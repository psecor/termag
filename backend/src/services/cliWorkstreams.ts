/**
 * What `POST /api/cli/v1/projects/:id/workstreams` adds over the web UI's
 * Branch off… (createWorkstreamFor in routes/workstreams.ts, which does the
 * work: the worktree at <project>/.worktrees/<name>, the row, the Slack
 * channel, main's workflows mirrored and their tmux sessions started). Kept
 * apart from Prisma and the agent so it can be tested on its own; the wiring
 * is routes/cliLifecyclePrisma.ts.
 *
 * - `startFromOrigin` (t3's "New worktrees start from remote"): fetch `base`
 *   from origin and branch from `origin/<base>`, the automation runner's
 *   fetch. A base origin doesn't have (a local-only branch) is branched as
 *   given instead, as t3 does.
 * - The answer names the workstream's directory as the box sees it (its
 *   agent's path_remap), which is where a desktop thread runs, as
 *   `t3/projects` does for a project's checkout.
 */
import type { CreateWorkstreamInput } from '../routes/workstreams';
import type { RouteResult } from '../routes/routeResult';

export interface CliWorkstreamRequest {
  name: string;
  /** The commit-ish to branch off; the main checkout's HEAD when left out. */
  base?: string;
  /** The new workstream's agent instead of main's (a provider id, checked by the route). */
  agent?: string;
  startFromOrigin?: boolean;
}

export interface CliWorkstreamView {
  id: string;
  name: string;
  branch: string;
  /** The worktree as the box sees it. */
  directory: string;
  exists: boolean;
}

export interface CliWorkstreamDeps {
  create(input: CreateWorkstreamInput): Promise<RouteResult>;
  /** The new workstream's directory, as the box sees it. */
  locate(name: string): Promise<{ directory: string; exists: boolean }>;
}

/** git's words for a start point that does not exist (an unfetched origin/<base>); automations/runner.ts reads the same. */
const UNRESOLVED_BASE_REF = /invalid reference|not a valid object name|unknown revision/;

function errorOf(result: RouteResult): string {
  const body = result.body as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : '';
}

export async function createCliWorkstream(request: CliWorkstreamRequest, deps: CliWorkstreamDeps): Promise<RouteResult> {
  const input: CreateWorkstreamInput = {
    name: request.name,
    ...(request.base ? { baseRef: request.base } : {}),
    ...(request.agent ? { provider: request.agent } : {}),
  };
  const remote = request.startFromOrigin && request.base && !request.base.startsWith('origin/') ? request.base : null;
  let result = remote
    ? await deps.create({ ...input, baseRef: `origin/${remote}`, fetch: { remoteBranch: remote } })
    : await deps.create(input);
  if (remote && result.status !== 201 && /git worktree add failed/.test(errorOf(result)) && UNRESOLVED_BASE_REF.test(errorOf(result))) {
    result = await deps.create(input);
  }
  if (result.status !== 201) return result;

  const created = result.body as { id: string; name: string; branch: string; sessionLaunchWarnings?: string[] };
  const where = await deps.locate(created.name);
  const workstream: CliWorkstreamView = {
    id: created.id,
    name: created.name,
    branch: created.branch,
    directory: where.directory,
    exists: where.exists,
  };
  return { status: 201, body: { workstream, warnings: created.sessionLaunchWarnings ?? [] } };
}
