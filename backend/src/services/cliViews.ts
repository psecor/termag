/**
 * The JSON the `termag` CLI reads (routes/cliApi.ts). This is a contract with
 * shipped clients: add fields, never rename or remove them.
 *
 * Pure: rows in, views out. Agent connectivity and live status are passed in.
 */
import { isValidBoxName } from './boxNames';
import { cliSessionValidity, type CliSessionTimes } from './cliAuth';
import { projectDirUnder, resolveProjectRoot } from './projectPaths';
import { needsBoxRelaunch, toSetupStatus } from './projectSetup';

export type BoxState =
  | 'provisioning' | 'running' | 'stopping' | 'stopped' | 'hibernating' | 'hibernated' | 'starting'
  | 'failed' | 'awaiting-agent' | 'unknown';

/** Instance.status in the PRD's vocabulary: a ready box is a running one. */
export function boxState(status: string): BoxState {
  switch (status) {
    case 'ready': return 'running';
    case 'provisioning':
    case 'stopping':
    case 'stopped':
    case 'hibernating':
    case 'hibernated':
    case 'starting':
    case 'failed':
    case 'awaiting-agent':
      return status;
    default: return 'unknown';
  }
}

// The PRD's naming rule. Older boxes may predate it; the CLI warns on those.
export function isAddressableName(name: string): boolean {
  return isValidBoxName(name);
}

export interface BoxRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  provisioningError: string | null;
  ec2InstanceId: string | null;
  region: string | null;
  hostUnixUser: string | null;
  createdAt: Date;
  readyAt: Date | null;
  projects: Array<{ id: string; name: string }>;
}

export interface CliBox {
  id: string;
  name: string;
  addressable: boolean;
  kind: string;
  state: BoxState;
  status: string;
  agentConnected: boolean;
  error: string | null;
  ec2InstanceId: string | null;
  region: string | null;
  hostUnixUser: string | null;
  createdAt: string;
  readyAt: string | null;
  projects: Array<{ id: string; name: string }>;
}

export function shapeBox(row: BoxRow, agentConnected: boolean): CliBox {
  return {
    id: row.id,
    name: row.name,
    addressable: isAddressableName(row.name),
    kind: row.kind,
    state: boxState(row.status),
    status: row.status,
    agentConnected,
    error: row.status === 'failed' ? row.provisioningError : null,
    ec2InstanceId: row.ec2InstanceId,
    region: row.region,
    hostUnixUser: row.hostUnixUser,
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt ? row.readyAt.toISOString() : null,
    projects: row.projects.map(p => ({ id: p.id, name: p.name })),
  };
}

export interface ProjectRow {
  id: string;
  name: string;
  instanceId: string | null;
  lastActiveAt: Date;
  instance: {
    id: string; name: string; hostHome?: string | null;
    kind?: string; status?: string; provisioningError?: string | null;
  } | null;
  user: { unixUsername: string };
  workstreams: Array<{ name: string }>;
  workflows: Array<{ provider: string | null }>;
  /** Project.repoUrl, setupStatus, setupError: the clone the web UI's tile shows (services/projectSetup.ts). */
  repoUrl?: string | null;
  setupStatus?: string | null;
  setupError?: string | null;
}

/**
 * Where a project's setup is, in the terms of the web UI's clone tile
 * (frontend/src/utils/cloneTile.ts), which reads the same columns:
 *
 *   waiting  nothing has started on the box yet (its agent is not connected,
 *            or it is still waiting for GitHub delivery or the claim's dotfiles)
 *   cloning  the box's clone unit is running
 *   done     the checkout is in place and the project's sessions were started
 *   failed   see `error`; POST /projects/:id/clone/retry tries again
 *   unknown  the checkout was typed into the agent pane by an agent without
 *            durable clones (`project-clone-v1`): nothing reports how it went,
 *            so only the directory's existence says anything
 */
export type CloneState = 'waiting' | 'cloning' | 'done' | 'failed' | 'unknown';

export interface CliClone {
  state: CloneState;
  /** Project.setupStatus as stored: none | pending | cloning | ready | failed (or text a newer release wrote). */
  setupStatus: string;
  /** Why it failed; null unless `state` is failed. */
  error: string | null;
  /** The repository being cloned; null for an empty project waiting for its box. */
  repoUrl: string | null;
  /** Whether POST /projects/:id/clone/retry acts: a failed clone, or one waiting on a box that failed to launch. */
  retryable: boolean;
}

/**
 * Null when there is nothing to wait for: an empty project already set up
 * (or a failed clone started empty, which drops the repository).
 */
export function shapeClone(row: Pick<ProjectRow, 'repoUrl' | 'setupStatus' | 'setupError' | 'instance'>): CliClone | null {
  const raw = row.setupStatus ?? 'none';
  const status = toSetupStatus(raw);
  const repoUrl = row.repoUrl ?? null;
  const box = row.instance && row.instance.kind !== undefined && row.instance.status !== undefined
    ? { kind: row.instance.kind, status: row.instance.status }
    : null;
  const relaunch = needsBoxRelaunch(raw, box);
  const view = (state: CloneState, error: string | null = null): CliClone => ({
    state, setupStatus: raw, error, repoUrl, retryable: state === 'failed' && (status === 'failed' || relaunch),
  });
  switch (status) {
    case 'none': return repoUrl ? view('unknown') : null;
    case 'pending': {
      if (!relaunch) return view('waiting');
      const detail = row.instance?.provisioningError?.trim();
      return view('failed', `The box failed to launch${detail ? `: ${detail}` : ''}. Retry launches a new one.`);
    }
    case 'cloning': return view('cloning');
    case 'ready': return view('done');
    case 'failed': return view('failed', row.setupError?.trim() || (repoUrl ? 'clone failed' : 'setup failed'));
    default: return view('unknown');
  }
}

export interface LiveStatus {
  status: string;
  waitingReason?: string | null;
  rateLimited?: unknown;
  source?: string;
}

export interface CliProject {
  id: string;
  name: string;
  ref: string;
  box: { id: string; name: string };
  provider: string | null;
  status: string;
  waitingReason: string | null;
  rateLimited: unknown;
  workstreams: string[];
  lastActiveAt: string;
  /** The main workstream's working directory on the box (`termag ssh <box>/<project>`). */
  directory: string;
  /** The main workstream's tmux sessions (`termag attach`); null when the caller didn't supply them. */
  sessions: ProjectSessions | null;
  /** The project's clone (shapeClone); null when there is none to wait for. */
  clone: CliClone | null;
}

export interface ProjectSessions {
  agent: string;
  ctrl: string;
}

/**
 * Null for a project with no box: the PRD addresses every project as
 * <box>/<project>, and orchestrator-host projects have no box part.
 * `agentStatus` is looked up for the project's main agent session.
 */
export function shapeProject(row: ProjectRow, agentStatus: LiveStatus | undefined, sessions?: ProjectSessions): CliProject | null {
  if (!row.instance) return null;
  const workstreams = row.workstreams.length ? row.workstreams.map(w => w.name) : ['main'];
  const root = resolveProjectRoot({ ownerUnixUser: row.user.unixUsername, hostHome: row.instance.hostHome });
  return {
    id: row.id,
    name: row.name,
    ref: `${row.instance.name}/${row.name}`,
    box: { id: row.instance.id, name: row.instance.name },
    provider: row.workflows[0]?.provider ?? null,
    status: agentStatus?.status ?? 'not_running',
    waitingReason: agentStatus?.waitingReason ?? null,
    rateLimited: agentStatus?.rateLimited ?? null,
    workstreams,
    lastActiveAt: row.lastActiveAt.toISOString(),
    directory: projectDirUnder(root, row.name),
    sessions: sessions ?? null,
    clone: shapeClone(row),
  };
}

export interface DeviceRow extends CliSessionTimes {
  id: string;
  deviceName: string;
  tokenPrefix: string;
}

export interface CliDevice {
  id: string;
  deviceName: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

/** Live devices only: revoked and lapsed sessions are dropped. */
export function shapeDevices(rows: DeviceRow[], now: Date): CliDevice[] {
  const out: CliDevice[] = [];
  for (const row of rows) {
    const v = cliSessionValidity(row, now);
    if (!v.valid) continue;
    out.push({
      id: row.id,
      deviceName: row.deviceName,
      tokenPrefix: row.tokenPrefix,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: row.lastUsedAt.toISOString(),
      expiresAt: v.expiresAt.toISOString(),
    });
  }
  return out;
}
