/**
 * A tool update run (phase 2; Claude Code is the
 * only tool so far, components.ts): its states, its expiry, what the box's
 * policy fetch answers for it and what its report writes. Pure: runs.ts reads
 * and writes the `software_update_runs` rows and sends the RPCs.
 *
 *   requested ── policy fetch (flag on) ──▶ running ── report ──▶ done | failed
 *       │                                                          ▲
 *       ├── 15 min, no fetch ──▶ expired ── a late report ─────────┘
 *       │   (a run of a tool updated at the box's start, Docker: 14 days,
 *       │   and its "fetch" is the box's boot unit asking for it)
 *       └── the agent refuses the tool-update RPC ──▶ refused
 *
 * A boot or runner-guard run has no requested row: its report creates one,
 * already finished.
 */
import type { ClaudeUpdateRestart } from '../claudeUpdatePolicy';
import { isRestart } from '../claudeUpdatePolicy';
import { isToolComponent, type ToolComponent, type ToolUpdatePolicy } from './components';
import { chatNoticeText } from './notice';

/** Announced by an agent whose `tool-update` RPC starts the component's unit (termag-claude-update@<run>.service, 2b). */
export const TOOL_UPDATE_CAPABILITY = 'tool-update-v1';

export const TRIGGERS = ['manual', 'boot', 'guard', 'floor', 'resume', 'nightly'] as const;
export type RunTrigger = typeof TRIGGERS[number];
const isTrigger = (v: unknown): v is RunTrigger => (TRIGGERS as readonly unknown[]).includes(v);
export const STATUSES = ['requested', 'running', 'done', 'failed', 'refused', 'expired'] as const;
export type RunStatus = typeof STATUSES[number];
// floor-only: the orchestrator host's run with no version pinned, which had nothing to bring up to the floor (orchestrator.ts).
export const OUTCOMES = ['updated', 'current', 'partial', 'failed', 'floor-only'] as const;
export type RunOutcome = typeof OUTCOMES[number];

/** The run id the RPC carries and the unit is named after: a cuid fits, and so does nothing a shell would read. */
const RUN_ID = /^[a-z0-9]{20,40}$/;
export const isRunId = (v: unknown): v is string => typeof v === 'string' && RUN_ID.test(v);

/** A run nobody fetched the policy for in this long is `expired`. */
export const RUN_EXPIRE_MS = 15 * 60_000;
/**
 * The tools updated only at the box's start (components.ts `atStart`): a run
 * of one waits `requested` for the box's next start, which may be days away
 * (a box its owner leaves stopped), and expires only after this long.
 */
export const AT_START_COMPONENTS: readonly string[] = ['docker'];
export const AT_START_EXPIRE_MS = 14 * 24 * 3600_000;
export const isAtStart = (component: string | undefined): boolean => !!component && AT_START_COMPONENTS.includes(component);
/** How long a requested run of `component` waits for its box. */
export const expireMsFor = (component: string | undefined): number => (isAtStart(component) ? AT_START_EXPIRE_MS : RUN_EXPIRE_MS);
/**
 * A `running` run counts as in flight (for the 409 and the fleet's pacing) for
 * this long after it started: the drain is at most an hour, and the install a
 * few minutes. A box that never reports stops blocking its host after that;
 * its row stays `running`, which is what is known.
 */
export const RUN_STALE_MS = 90 * 60_000;
export const DETAIL_MAX = 2000;
/**
 * A box that asks again for a run its own fetch started this recently, with
 * no report yet, gets the run back: the first answer may have been lost on
 * the way (Devin on #975).
 */
export const POLICY_RETRY_MS = 5 * 60_000;

export interface RunSessions {
  stopped: number; resumed: number; fresh: number; cut: number; typed: number; other: number; runnersLeft: number;
}
const SESSION_KEYS: ReadonlyArray<keyof RunSessions> = ['stopped', 'resumed', 'fresh', 'cut', 'typed', 'other', 'runnersLeft'];

/** The columns these rules read. */
export interface RunFacts {
  id: string;
  hostKey: string;
  component: string;
  status: string;
  restart: string;
  /** What asked for it (TRIGGERS); the box names it in its restart notice. */
  trigger?: string;
  target: string | null;
  requestedAt: Date;
  startedAt: Date | null;
}

export function isExpired(run: Pick<RunFacts, 'status' | 'requestedAt'> & { component?: string }, now: number): boolean {
  return run.status === 'requested' && now - run.requestedAt.getTime() >= expireMsFor(run.component);
}

/** Whether the run still holds its host: a fresh request, or a run that started not long ago. */
export function isInFlight(run: Pick<RunFacts, 'status' | 'requestedAt' | 'startedAt'> & { component?: string }, now: number): boolean {
  if (run.status === 'requested') return !isExpired(run, now);
  if (run.status === 'running') return now - (run.startedAt ?? run.requestedAt).getTime() < RUN_STALE_MS;
  return false;
}

export interface PolicyBody {
  floor: string;
  target: string;
  restart: ClaudeUpdateRestart;
  drainSec: number;
  /**
   * The run, with its trigger when it is one a box may name in the notice it
   * types before a resume (deploy/termag-tool-update-lib, tu_notice).
   */
  run: null | { id: string; component: ToolComponent; trigger?: RunTrigger };
}

export type PolicyAnswer =
  | { status: 404; body: { code: 'no_such_run' } }
  /** `start`: move the run to running. `expire`: it was requested too long ago; mark it so. */
  | { status: 200; body: PolicyBody; start: boolean; expire: boolean };

/**
 * GET /api/tool-update/policy for one box and component. `run` is the row
 * the `?run=` id names, already looked up by id; `asked` is that id, absent
 * for the boot and guard paths. A run of another component is no such run.
 * Only a requested, unexpired run of this box, with the flag on, gets a
 * restart and starts; everything else is the floor and target with restart
 * none, so a box that cannot tell why still updates nothing it was not asked
 * to.
 *
 * The one exception is a retry: a run that is `running` (so not reported),
 * started by a fetch less than POLICY_RETRY_MS ago, gets the same answer
 * again, `start: false`. Only the box the run belongs to gets here (the
 * hostKey check above), and that box runs one systemd instance per run id,
 * `termag-claude-update@<run>.service`, which cannot run twice at once: a
 * retry from the same unit continues the one run, it never starts a second.
 */
export function policyAnswer(input: {
  component: ToolComponent;
  asked: string | null;
  run: RunFacts | null;
  hostKey: string;
  enabled: boolean;
  policy: ToolUpdatePolicy;
  now: number;
}): PolicyAnswer {
  const { component, asked, run, hostKey, enabled, policy, now } = input;
  const base = { floor: policy.floor, target: policy.target, drainSec: policy.drainSec };
  if (asked !== null && (!run || run.hostKey !== hostKey || run.component !== component)) return { status: 404, body: { code: 'no_such_run' } };
  if (!run) return { status: 200, body: { ...base, restart: 'none', run: null }, start: false, expire: false };
  const answer = { ...base, target: run.target ?? policy.target, restart: isRestart(run.restart) ? run.restart : 'none', run: { id: run.id, component, ...(isTrigger(run.trigger) ? { trigger: run.trigger } : {}) } };
  if (enabled && isPolicyRetry(run, now)) return { status: 200, body: answer, start: false, expire: false };
  const expired = isExpired(run, now);
  if (run.status !== 'requested' || expired || !enabled) {
    return { status: 200, body: { ...base, restart: 'none', run: null }, start: false, expire: expired };
  }
  return { status: 200, body: answer, start: true, expire: false };
}

/** A fetch of a run its box's own fetch started moments ago, before any report (policyAnswer). */
export function isPolicyRetry(run: Pick<RunFacts, 'status' | 'startedAt'>, now: number): boolean {
  return run.status === 'running' && !!run.startedAt && now - run.startedAt.getTime() < POLICY_RETRY_MS;
}

// ── the report ──────────────────────────────────────────────────────────────

export interface ReportedPane {
  /** The tmux session name. */
  session: string;
  role: 'agent' | 'other';
  sessionId: string | null;
  hadConversation: boolean;
  /**
   * The restart notice the box printed in this pane before it resumed it
   * (tu_notice), when it printed one: data, kept only when chatNoticeText
   * passes it (notice.ts), else null. A box from before it sends none.
   */
  notice?: string | null;
}

export interface ToolUpdateReport {
  component: ToolComponent;
  trigger: RunTrigger;
  outcome: RunOutcome;
  run: string | null;
  target: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  detail: string | null;
  sessions: RunSessions | null;
  panes: ReportedPane[];
}

// A version, a dist-tag or npm's answer: short and printable, never a command line.
const SHORT = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
// A tmux session name as tmux.tmuxSafeName leaves it: no `:` or `.`, no whitespace or control characters.
// Only ever a lookup key (panes.ts names the box's panes forward and compares).
const SESSION = /^[^\s:.\x00-\x1f\x7f]{1,200}$/;
const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;
export const MAX_REPORTED_PANES = 200;

const optShort = (v: unknown, name: string): string | null | { error: string } =>
  v === undefined || v === null ? null : typeof v === 'string' && SHORT.test(v) ? v : { error: `${name} must be a short version string` };
const isErr = (v: unknown): v is { error: string } => !!v && typeof v === 'object' && 'error' in (v as object);

function parseSessions(v: unknown): RunSessions | null | { error: string } {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return { error: 'sessions must be an object' };
  const s = v as Record<string, unknown>;
  const out = {} as RunSessions;
  for (const k of SESSION_KEYS) {
    const n = s[k] ?? 0;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 100_000) return { error: `sessions.${k} must be a count` };
    out[k] = n;
  }
  return out;
}

function parsePanes(v: unknown): ReportedPane[] | { error: string } {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return { error: 'panes must be an array' };
  if (v.length > MAX_REPORTED_PANES) return { error: `at most ${MAX_REPORTED_PANES} panes` };
  const out: ReportedPane[] = [];
  for (const p of v) {
    if (!p || typeof p !== 'object') return { error: 'each pane must be an object' };
    const r = p as Record<string, unknown>;
    if (typeof r.session !== 'string' || !SESSION.test(r.session)) return { error: 'pane.session must be a tmux session name' };
    if (r.role !== 'agent' && r.role !== 'other') return { error: 'pane.role must be agent or other' };
    if (r.sessionId !== undefined && r.sessionId !== null && (typeof r.sessionId !== 'string' || !SESSION_ID.test(r.sessionId))) return { error: 'pane.sessionId must be a session id' };
    if (typeof r.hadConversation !== 'boolean') return { error: 'pane.hadConversation must be a boolean' };
    // A notice that is not one is dropped, not refused: the report stands without it.
    const notice = chatNoticeText(r.notice);
    out.push({ session: r.session, role: r.role, sessionId: typeof r.sessionId === 'string' ? r.sessionId : null, hadConversation: r.hadConversation, ...(notice ? { notice } : {}) });
  }
  return out;
}

/**
 * POST /api/tool-update/report's body, or what is wrong with it; `code` is
 * `unknown_component` for a component the registry does not list.
 */
export function parseToolUpdateReport(body: unknown): ToolUpdateReport | { error: string; code?: 'unknown_component' } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (!isToolComponent(b.component)) return { error: 'component is not a tool termag updates', code: 'unknown_component' };
  if (!(TRIGGERS as readonly unknown[]).includes(b.trigger)) return { error: `trigger must be one of ${TRIGGERS.join(', ')}` };
  if (!(OUTCOMES as readonly unknown[]).includes(b.outcome)) return { error: `outcome must be one of ${OUTCOMES.join(', ')}` };
  if (b.run !== undefined && b.run !== null && !isRunId(b.run)) return { error: 'run is not a run id' };
  const target = optShort(b.target, 'target'); if (isErr(target)) return target;
  const fromVersion = optShort(b.fromVersion, 'fromVersion'); if (isErr(fromVersion)) return fromVersion;
  const toVersion = optShort(b.toVersion, 'toVersion'); if (isErr(toVersion)) return toVersion;
  if (b.detail !== undefined && b.detail !== null && typeof b.detail !== 'string') return { error: 'detail must be a string' };
  const sessions = parseSessions(b.sessions); if (isErr(sessions)) return sessions;
  const panes = parsePanes(b.panes); if (isErr(panes)) return panes;
  const trigger = b.trigger as RunTrigger;
  const run = typeof b.run === 'string' ? b.run : null;
  if (!run && trigger !== 'boot' && trigger !== 'guard') return { error: `a ${trigger} report names its run` };
  return {
    component: b.component, trigger, outcome: b.outcome as RunOutcome, run, target, fromVersion, toVersion,
    detail: typeof b.detail === 'string' && b.detail.length ? b.detail.slice(0, DETAIL_MAX) : null,
    sessions, panes,
  };
}

/** The status a reported outcome ends a run in. A partial run updated the binary but left something behind. */
export const statusForOutcome = (o: RunOutcome): RunStatus => (o === 'failed' ? 'failed' : 'done');

/** What a report writes on its run's row: any requested, running or expired run of the box ends with it (a late report still says what happened). */
export function reportUpdate(run: Pick<RunFacts, 'startedAt'>, r: ToolUpdateReport, now: Date) {
  return {
    status: statusForOutcome(r.outcome),
    outcome: r.outcome,
    ...(r.target ? { target: r.target } : {}),
    fromVersion: r.fromVersion,
    toVersion: r.toVersion,
    detail: r.detail,
    sessions: r.sessions,
    startedAt: run.startedAt ?? now,
    finishedAt: now,
  };
}

/** The row a boot or guard report creates: no request behind it, so asked, started and finished at once. */
export function reportCreate(hostKey: string, instanceId: string, r: ToolUpdateReport, now: Date) {
  return {
    hostKey, instanceId, component: r.component, trigger: r.trigger, restart: 'none',
    status: statusForOutcome(r.outcome), outcome: r.outcome, target: r.target, fromVersion: r.fromVersion, toVersion: r.toVersion,
    detail: r.detail, sessions: r.sessions, requestedAt: now, startedAt: now, finishedAt: now,
  };
}

