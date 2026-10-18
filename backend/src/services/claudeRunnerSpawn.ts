/**
 * Claude Code cloud sessions on termag boxes.
 *
 * The orchestrator host runs `claude self-hosted-runner orchestrator`, whose
 * spawn-runner hook (deploy/claude-spawn-runner) POSTs one work order per
 * queued session to routes/claudeRunner.ts. That route resolves the session
 * owner to a termag user, picks one of their connected boxes and, through the
 * box agent, writes the work order and creates a tmux session whose only
 * process is `termag-claude-runner <order> <slot>`. The runner serves that one
 * session and exits, and the session goes with it: a runner session exists
 * exactly while its runner runs.
 *
 * This module is the side-effect-free part: body validation, box and slot
 * choice and the exact values sent to the agent. The route owns Prisma and the
 * RPCs.
 */
import { createHash, timingSafeEqual } from 'crypto';
import type { OtlpDestination } from '../config/env';

export interface SpawnRequest {
  orderId: string;
  sessionId: string;
  accountEmail: string;
  workOrder: string;
}

// Order IDs are documented as safe for Kubernetes resource names, which admit
// `.`. That alphabet is safe in a file name; in a tmux session name `.` is
// not, so tmuxSafe escapes it first.
const ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The order-id alphabet, for the box's end-of-session report too (routes/claudeRunnerEvents.ts). */
export const isOrderId = (s: string): boolean => ORDER_ID.test(s);
const EMAIL = /^[^\s@]+@[^\s@]+$/;
// A JWT: three base64url segments. Checked for shape only, never decoded.
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function parseSpawnBody(body: unknown): SpawnRequest | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  const orderId = typeof b.orderId === 'string' ? b.orderId : '';
  if (!ORDER_ID.test(orderId)) return { error: 'orderId missing or not a safe identifier' };
  const sessionId = typeof b.sessionId === 'string' ? b.sessionId.trim() : '';
  if (!sessionId) return { error: 'sessionId missing (pre-warming orders are not supported)' };
  const accountEmail = typeof b.accountEmail === 'string' ? b.accountEmail.trim() : '';
  if (!EMAIL.test(accountEmail)) return { error: 'accountEmail missing (agent-owned sessions cannot be routed to a box)' };
  const workOrder = typeof b.workOrder === 'string' ? b.workOrder.trim() : '';
  if (!JWT.test(workOrder)) return { error: 'workOrder missing or not a JWT' };
  return { orderId, sessionId, accountEmail, workOrder };
}

/**
 * What a box's agent must announce before a runner is launched there: it runs
 * tmux-create's `command` (agent/tmux-args.js). An older agent would ignore
 * the field and leave a bare shell holding a slot.
 */
export const RUNNER_AGENT_CAPABILITY = 'tmux-create-command-v1';

export interface CandidateBox {
  id: string;
  kind: string;
  status: string;
  hostHome: string | null;
  hostUnixUser: string | null;
  lastConnectedAt: Date | null;
  connected: boolean;
  /** The agent announced RUNNER_AGENT_CAPABILITY. */
  capable: boolean;
}

/**
 * The boxes a session may land on, best first: owned (the caller already
 * filtered by user), EC2-managed, `ready`, agent connected now and able to run
 * a runner, with a known home so the work order has somewhere to go. Most
 * recently connected first: the box the owner is most likely using.
 */
export function runnerBoxes<T extends CandidateBox>(boxes: T[]): T[] {
  return boxes
    .filter(b => b.kind === 'ec2' && b.status === 'ready' && b.connected && b.capable && !!b.hostHome && !!b.hostUnixUser)
    .sort((a, b) => (b.lastConnectedAt?.getTime() ?? 0) - (a.lastConnectedAt?.getTime() ?? 0));
}

/**
 * Concurrency on one box. Each cloud session gets its own slot, which is the
 * dev-stack instance it runs (DEV_INSTANCE; the owner keeps instance 1 for
 * interactive work) and names its checkout and tmux session. Three at once per
 * box for now: an m9g.2xlarge holds the owner's stack plus one comfortably,
 * larger boxes more, and nothing measures free RAM yet
 *.
 */
export const MAX_RUNNERS_PER_BOX = 3;
export const FIRST_SLOT = 2;

export interface RunnerSession {
  slot: number;
  /** The tmux-safe form (tmuxSafe), as read back from the session name. */
  orderId: string;
  sessionName: string;
}

/**
 * A unix user name or an order id as it appears in a tmux session name. `.`
 * is not a tmux name character (tmux rewrites it to `_`, and the agent then
 * cannot address the session it just created), and a plain `.` -> `_` rewrite
 * would make `a.b` and `a_b` the same name, so the escape is reversible:
 * `_` -> `__`, `.` -> `_d`. Distinct inputs always get distinct names.
 */
export function tmuxSafe(s: string): string {
  return s.replace(/_/g, '__').replace(/\./g, '_d');
}

// <user>-claude-runner-s<slot>-<order>-r, user and order through tmuxSafe.
// The fixed `-r` tail keeps the name from ending in `-agent` or `-ctrl`
// (status.ts parseSessionName) whatever the order id is. Parsing anchors on
// the box user's own prefix, so an order id containing `-claude-runner-s3-`
// cannot shift where the user part ends.
const RUNNER_TAIL = /^(\d+)-([A-Za-z0-9][A-Za-z0-9_-]*)-r$/;
const runnerPrefix = (hostUnixUser: string) => `${tmuxSafe(hostUnixUser)}-claude-runner-s`;

export function runnerSessionName(hostUnixUser: string, slot: number, orderId: string): string {
  return `${runnerPrefix(hostUnixUser)}${slot}-${tmuxSafe(orderId)}-r`;
}

/** The runner tmux sessions among a box's live tmux sessions, for this unix user. */
export function parseRunnerSessions(tmuxSessions: string[], hostUnixUser: string): RunnerSession[] {
  const prefix = runnerPrefix(hostUnixUser);
  const out: RunnerSession[] = [];
  for (const name of tmuxSessions) {
    if (!name.startsWith(prefix)) continue;
    const m = RUNNER_TAIL.exec(name.slice(prefix.length));
    if (m) out.push({ slot: Number(m[1]), orderId: m[2], sessionName: name });
  }
  return out;
}

/**
 * Whether `session` is a runner tmux session of the box whose unix user is
 * `hostUnixUser`: the ownership check for status posts from inside a cloud
 * session (routes/status.ts). The session's Claude Code runs the box owner's
 * status hooks, and its posts carry the runner's name, which begins with the
 * box's unix user, not necessarily the owner's termag username (an
 * orchestrator-provisioned box keeps the image's user). An instance-bound
 * token names the box, so its runner sessions are its own; a project pane's
 * name under that prefix is not admitted here, only names that parse.
 */
export function isRunnerSessionOf(session: string, hostUnixUser: string | null | undefined): boolean {
  if (!hostUnixUser) return false;
  return parseRunnerSessions([session], hostUnixUser).length === 1;
}

/**
 * Whether a status for `session` on box `instanceId` is one of the client
 * user's own cloud sessions: the box is theirs (`ownedBoxes` maps their box
 * ids to each box's unix user) and the name parses as that box's runner
 * session. The status WebSocket uses it beside the username-prefix rule,
 * since a runner session is named after the box's unix user, not the owner's
 * termag username (routes/status.ts has the matching rule for the posts).
 */
/** Does the name look like any box's runner session (`<user>-claude-runner-s<slot>-<order>-r`)? A cheap pre-check before a box lookup. */
export function isRunnerSessionShaped(session: string): boolean {
  return /-claude-runner-s\d+-[A-Za-z0-9][A-Za-z0-9_-]*-r$/.test(session);
}

export function isOwnRunnerSessionStatus(session: string, instanceId: string | null, ownedBoxes: ReadonlyMap<string, string | null>): boolean {
  if (!instanceId || !ownedBoxes.has(instanceId)) return false;
  return isRunnerSessionOf(session, ownedBoxes.get(instanceId));
}

export type SlotDecision =
  | { kind: 'existing'; slot: number }
  | { kind: 'new'; slot: number }
  | { kind: 'full'; running: number; max: number };

/**
 * One box. Idempotent on the order id: an order already running keeps its
 * slot. Else the lowest free slot in [FIRST_SLOT, FIRST_SLOT + max), else full.
 */
export function allocateSlot(existing: RunnerSession[], orderId: string, max: number = MAX_RUNNERS_PER_BOX): SlotDecision {
  const key = tmuxSafe(orderId);
  const mine = existing.find(s => s.orderId === key);
  if (mine) return { kind: 'existing', slot: mine.slot };
  const taken = new Set(existing.map(s => s.slot));
  for (let slot = FIRST_SLOT; slot < FIRST_SLOT + max; slot++) {
    if (!taken.has(slot)) return { kind: 'new', slot };
  }
  return { kind: 'full', running: existing.length, max };
}

export type Placement<T> =
  | { kind: 'existing'; box: T; slot: number }
  | { kind: 'new'; box: T; slot: number }
  | { kind: 'full'; boxes: number; max: number };

/**
 * All of the owner's runner boxes, best first, each with its live runner
 * sessions. An order already running on any of them stays there (a retry must
 * not start a second runner elsewhere); otherwise the first box with a free
 * slot takes it, so a full favourite box does not queue a session another box
 * could run now.
 */
export function placeRunner<T>(listed: { box: T; sessions: RunnerSession[] }[], orderId: string, max: number = MAX_RUNNERS_PER_BOX): Placement<T> {
  for (const l of listed) {
    const d = allocateSlot(l.sessions, orderId, max);
    if (d.kind === 'existing') return { kind: 'existing', box: l.box, slot: d.slot };
  }
  for (const l of listed) {
    const d = allocateSlot(l.sessions, orderId, max);
    if (d.kind === 'new') return { kind: 'new', box: l.box, slot: d.slot };
  }
  return { kind: 'full', boxes: listed.length, max };
}

export interface RunnerLaunch {
  /** Where the agent writes the work order, mode 0600 from the first byte. */
  workOrderPath: string;
  workOrderMode: number;
  /** tmux session for the runner; matches no project, so the pollers ignore it. */
  sessionName: string;
  /**
   * The session's only process (argv, no shell): it ends when the runner does.
   * `termag-claude-runner <order> <slot>`, then, when the orchestrator ships
   * telemetry, `--otel-project <routing key> --otel-endpoint <url>`: where the
   * session's own OpenTelemetry goes, and `--user-key <user id> --box-key
   * <instance id>`, so the session's telemetry can be joined to the owner and
   * the box. A script from before the flags reads `$1 $2` and ignores them.
   */
  command: string[];
  /**
   * The session's cwd: the runner state dir, never the home. tmux-create
   * `git init`s its cwd unless told not to.
   */
  cwd: string;
  gitInit: false;
  slot: number;
}

/** The keys a runner session's telemetry carries: the termag user (owner) and the box. */
export interface RunnerContextKeys {
  user: string;
  box: string;
}

export function runnerLaunch(hostHome: string, hostUnixUser: string, orderId: string, slot: number, telemetry: OtlpDestination | null = null, contextKeys: RunnerContextKeys | null = null): RunnerLaunch {
  const home = hostHome.replace(/\/+$/, '');
  const stateDir = `${home}/.termag/claude-runner`;
  const routing = telemetry ? [
    '--otel-project', telemetry.project, '--otel-endpoint', telemetry.endpoint,
    ...(contextKeys ? ['--user-key', contextKeys.user, '--box-key', contextKeys.box] : []),
  ] : [];
  return {
    workOrderPath: `${stateDir}/${orderId}.work-order`,
    workOrderMode: 0o600,
    sessionName: runnerSessionName(hostUnixUser, slot, orderId),
    command: [`${home}/.local/bin/termag-claude-runner`, orderId, String(slot), ...routing],
    cwd: stateDir,
    gitInit: false,
    slot,
  };
}

/**
 * Run `fn` after every earlier call with the same key has finished. Placement
 * is a check-then-act over the owner's boxes' tmux sessions, and the
 * orchestrator runs several spawn hooks at once, so two sessions for one owner
 * would otherwise both see slot 2 free, and a retry racing its first attempt
 * would start a second runner. Keyed per owner; one backend process serves a
 * host, so an in-process queue is enough.
 */
const chains = new Map<string, Promise<unknown>>();
/** The per-owner lock placements, renames and the number backfill all take. */
export const ownerPlacementKey = (userId: string): string => `claude-runner:${userId}`;

export function serializeByKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  chains.set(key, next);
  next.finally(() => { if (chains.get(key) === next) chains.delete(key); }).catch(() => undefined);
  return next;
}

export type GithubCredentialState = 'present' | 'absent' | 'unknown';

/**
 * Whether a session for this owner can reach GitHub from a box. On a host
 * with the GitHub broker, boxes clone with the owner's stored `gh` token; an
 * owner who never connected GitHub gets a runner whose checkout fails late.
 * Refuse up front instead (503, retried) so the Activity tab says what to do.
 * Without the broker, boxes use their own SSH keys and nothing is checked
 * here. A failed credential read (KMS, a bad row) is not the owner's fault and
 * is not held against them; the box's own delivery handles that the same way.
 */
/**
 * The texts a refusal carries, in the hook's stderr (the Activity tab), the
 * journal and the session's `queued` event. One place, so the admin report's
 * category matcher (services/admin/claudeRunnerQueries.ts, refusalCategory)
 * and the route cannot drift; the matcher's test imports these.
 */
export const REFUSAL_TEXTS = {
  github: 'the session owner has not connected GitHub in termag; paste `gh auth token` on the termag Credentials page, then the session is retried',
  agentTooOld: "the session owner's box runs a termag agent too old for cloud sessions; it is retried once the box's termag is updated",
  noBox: 'no ready termag box with a connected agent for the session owner; start or add a box in termag',
  /** Carries counts: `every box of the session owner (2) already runs 3 cloud sessions; ...`. Matched by prefix. */
  boxesFullPrefix: 'every box of the session owner (',
  boxesFull: (boxes: number, max: number) => `${REFUSAL_TEXTS.boxesFullPrefix}${boxes}) already runs ${max} cloud sessions; it is retried when one ends`,
  hookGaveUp: 'the spawn hook stopped waiting; not launched',
} as const;

export function githubGate(input: { brokerConfigured: boolean; credential: GithubCredentialState }): { ok: true } | { ok: false; error: string } {
  if (!input.brokerConfigured || input.credential !== 'absent') return { ok: true };
  return { ok: false, error: REFUSAL_TEXTS.github };
}

/**
 * Constant-time equality for the bearer check. Both sides are hashed first so
 * the comparison runs over equal-length buffers and leaks neither content nor
 * length.
 */
export function tokensEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** The bearer token from an Authorization header, or null. */
export function bearerToken(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(raw ?? '');
  return m ? m[1] : null;
}
