/**
 * CliAutomations over the handlers the cookie routes call
 * (routes/automations.ts). Nothing here decides who may do what beyond the
 * box scope (routes/cliAutomations.ts): the owner check, the validation, the
 * limits and automations-enabled are the handlers'. Successes pass through
 * (their bodies are already views, services/automations/store.ts), except
 * create's project row, cut to its id and name; failures pass through
 * cliErrorResult, so only an error, a code and, for Run now, the run and why
 * it did not start reach the CLI.
 */
import { prisma } from '../db';
import { parseAskRef } from '../services/agentMessages';
import { automationFor } from '../services/automations/store';
import type { CliUser } from '../services/cliStore';
import { resolveStartFrom } from '../services/projectTemplates';
import {
  automationDetailFor, createAutomationFor, deleteAutomationFor, listAutomationsFor, memoryFor,
  previewScheduleFor, retireRunFor, runNowFor, stopRunFor, updateAutomationFor,
} from './automations';
import type { BoxScope, CliAutomations } from './cliAutomations';
import { cliErrorResult } from './cliLifecycle';
import { prismaCliLifecycle } from './cliLifecyclePrisma';
import type { RouteResult } from './routeResult';

async function fullUser(user: CliUser): Promise<Express.User> {
  const row = await prisma.user.findUnique({ where: { id: user.id } });
  if (!row) throw new Error('User not found');
  return row;
}

/** What the handlers answer for an automation the caller cannot see, so a box's scope tells it nothing more. */
const NOT_FOUND: RouteResult = { status: 404, body: { error: 'Automation not found', code: 'not_found' } };

const BOX_SCOPE: RouteResult = {
  status: 403,
  body: { error: "A box's own credentials create automations on that box only; run `termag login` to use another", code: 'box_scope' },
};

/** A box credential's refusal for an automation on another box; null when the call may go to the handler. */
async function outOfScope(user: CliUser, scope: BoxScope, id: string): Promise<RouteResult | null> {
  if (scope === null) return null;
  const a = await automationFor(user.id, id);
  return a && a.project.instanceId === scope ? null : NOT_FOUND;
}

function shaped(result: RouteResult): RouteResult {
  return result.status < 300 ? result : cliErrorResult(result);
}

/**
 * `from` as `termag project create --from` takes it: a template, a GitHub
 * URL, or another project's `<box>/<project>`, resolved to the repoUrl the
 * handler takes. Absent, the body goes as it is.
 */
async function withRepo(user: CliUser, body: Record<string, unknown>): Promise<Record<string, unknown> | RouteResult> {
  const { from, ...rest } = body;
  if (from === undefined || from === null) return rest;
  if (typeof from !== 'string' || !from.trim()) return { status: 400, body: { error: 'from must be a string', code: 'invalid_request' } };
  const start = resolveStartFrom(from.trim());
  if (start.ok) return { ...rest, repoUrl: start.repoUrl };
  const ref = parseAskRef(from);
  if (!ref || ref.workstream) return { status: 400, body: { error: `${start.error}, or <box>/<project>`, code: 'invalid_request' } };
  const source = await prismaCliLifecycle.projectRepoUrl(user, ref.box, ref.project);
  return 'repoUrl' in source ? { ...rest, repoUrl: source.repoUrl } : source;
}

const isResult = (x: unknown): x is RouteResult =>
  !!x && typeof x === 'object' && 'status' in x && 'body' in x && typeof (x as RouteResult).status === 'number';

export const prismaCliAutomations: CliAutomations = {
  async list(user, scope) {
    const result = await listAutomationsFor(await fullUser(user));
    if (scope === null || result.status !== 200) return shaped(result);
    return { status: 200, body: (result.body as Array<{ instanceId: string | null }>).filter(a => a.instanceId === scope) };
  },

  async create(user, scope, raw) {
    if (scope !== null && raw.instanceId !== undefined && raw.instanceId !== scope) return BOX_SCOPE;
    const body = await withRepo(user, scope !== null && raw.instanceId === undefined ? { ...raw, instanceId: scope } : raw);
    if (isResult(body)) return cliErrorResult(body);
    const result = await createAutomationFor(await fullUser(user), body);
    if (result.status !== 201) return shaped(result);
    const { project, ...rest } = result.body as { project: { id: string; name: string } };
    return { status: 201, body: { project: { id: project.id, name: project.name }, ...rest } };
  },

  async preview(user, body) {
    return shaped(await previewScheduleFor(await fullUser(user), body));
  },

  async detail(user, scope, id) {
    return (await outOfScope(user, scope, id)) ?? shaped(await automationDetailFor(await fullUser(user), id));
  },

  async update(user, scope, id, body) {
    return (await outOfScope(user, scope, id)) ?? shaped(await updateAutomationFor(await fullUser(user), id, body));
  },

  async runNow(user, scope, id) {
    const refused = await outOfScope(user, scope, id);
    if (refused) return refused;
    const result = await runNowFor(await fullUser(user), id);
    const body = result.body as { run?: { reasonLabel?: string | null } | null; decision?: { kind: string; reason?: string } };
    if (result.status === 409 && body.decision) {
      // Skipped is the owner's situation, as the web UI shows it: the run row and why.
      const why = body.run?.reasonLabel ?? body.decision.reason ?? 'skipped';
      return { status: 409, body: { error: `The run was skipped: ${why}`, code: 'run_skipped', run: body.run ?? null, decision: body.decision } };
    }
    if (result.status === 502 && body.decision) {
      return { status: 502, body: { ...cliErrorResult(result).body as object, code: 'run_failed', run: body.run ?? null, decision: body.decision } };
    }
    return shaped(result);
  },

  async stopRun(user, scope, id, runId) {
    return (await outOfScope(user, scope, id)) ?? shaped(await stopRunFor(await fullUser(user), id, runId));
  },

  async retireRun(user, scope, id, runId) {
    return (await outOfScope(user, scope, id)) ?? shaped(await retireRunFor(await fullUser(user), id, runId));
  },

  async memory(user, scope, id) {
    return (await outOfScope(user, scope, id)) ?? shaped(await memoryFor(await fullUser(user), id));
  },

  async remove(user, scope, id) {
    const refused = await outOfScope(user, scope, id);
    if (refused) return refused;
    const result = await deleteAutomationFor(await fullUser(user), id);
    return result.status < 300 ? { status: 200, body: { ok: true } } : cliErrorResult(result);
  },
};
