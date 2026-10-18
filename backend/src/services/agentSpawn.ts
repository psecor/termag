/**
 * Agent spawn, the pure half: what a spawn request may
 * say, the defaults it gets, the brief the child is launched on, the launch
 * line per provider, the limits, and when a parent may be nudged. No Prisma,
 * no RPCs — routes/spawns.ts does those and calls in here.
 */
import { PROVIDERS } from '../providers/registry';
import { isBranchName } from './repoCreate';

export const SPAWN_FLAG = 'agent-spawn-enabled';

// The limits are tuning parameters now: services/spawnLimits.ts.

export type SpawnRelationship = 'delegate' | 'peer';
export type SpawnTarget = 'workstream' | 'project';
export const REPORT_STATUSES = ['done', 'blocked', 'needs_input'] as const;
export type ReportStatus = typeof REPORT_STATUSES[number];
/** A child in one of these still counts against its parent's open children. */
export const OPEN_STATES = ['starting', 'running'];

const NAME = /^[a-zA-Z0-9_-]+$/;
const SESSION = /^[\w.-]+$/;
const SHA = /^[0-9a-f]{7,40}$/;
const MAX_NAME = 40;
const MAX_TASK = 8000;
const MAX_CONTEXT = 16000;
const MAX_DONE_WHEN = 2000;
const MAX_SUMMARY = 8000;

export interface SpawnRequest {
  target: SpawnTarget;
  relationship: SpawnRelationship;
  task: string;
  context?: string;
  doneWhen?: string;
  name?: string;
  provider?: string;
  baseRef?: string;
  /** Workstream target: the project to branch in (default: the caller's). */
  projectId?: string;
  /** Project target: the box (default: the caller's). */
  boxId?: string;
  repoUrl?: string;
  /** The caller's own pane, as its MCP server sees it. Attribution only. */
  from?: { session: string; head?: string };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function optString(body: Record<string, unknown>, key: string, max: number): Parsed<string | undefined> {
  const v = body[key];
  if (v == null || v === '') return { ok: true, value: undefined };
  if (typeof v !== 'string') return { ok: false, error: `${key} must be a string` };
  const s = v.trim();
  if (s.length > max) return { ok: false, error: `${key} is longer than ${max} characters` };
  return { ok: true, value: s || undefined };
}

/** The body of POST /api/spawns, checked. Nothing is defaulted here that needs the database. */
export function parseSpawnRequest(raw: unknown): Parsed<SpawnRequest> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const task = optString(body, 'task', MAX_TASK);
  if (!task.ok) return task;
  if (!task.value) return { ok: false, error: 'task required' };

  const target = body.target ?? 'workstream';
  if (target !== 'workstream' && target !== 'project') return { ok: false, error: 'target must be workstream or project' };
  const relationship = body.relationship ?? 'delegate';
  if (relationship !== 'delegate' && relationship !== 'peer') return { ok: false, error: 'relationship must be delegate or peer' };

  const fields: Record<string, Parsed<string | undefined>> = {
    context: optString(body, 'context', MAX_CONTEXT),
    doneWhen: optString(body, 'doneWhen', MAX_DONE_WHEN),
    name: optString(body, 'name', MAX_NAME),
    provider: optString(body, 'provider', 40),
    baseRef: optString(body, 'baseRef', 200),
    projectId: optString(body, 'projectId', 100),
    boxId: optString(body, 'boxId', 100),
    repoUrl: optString(body, 'repoUrl', 500),
  };
  for (const f of Object.values(fields)) if (!f.ok) return f;
  const v = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, (f as { value?: string }).value])) as Record<string, string | undefined>;

  if (v.name && !NAME.test(v.name)) return { ok: false, error: 'name must be alphanumeric with dashes/underscores only' };
  if (v.name === 'main') return { ok: false, error: '"main" is reserved for the default workstream' };
  if (v.baseRef && !isBranchName(v.baseRef)) return { ok: false, error: 'baseRef contains disallowed characters' };
  if (target === 'workstream' && (v.boxId || v.repoUrl)) return { ok: false, error: 'boxId and repoUrl need target: "project"' };
  if (target === 'project' && v.projectId) return { ok: false, error: 'projectId is for target: "workstream"' };
  if (target === 'project' && v.baseRef) return { ok: false, error: 'baseRef is for target: "workstream"' };

  let from: SpawnRequest['from'];
  if (body.from != null) {
    const f = body.from as Record<string, unknown>;
    if (typeof f !== 'object' || typeof f.session !== 'string' || !SESSION.test(f.session)) {
      return { ok: false, error: 'from.session must be a tmux session name' };
    }
    // A head that is not a plain sha is dropped, not refused: it only picks a default.
    const head = typeof f.head === 'string' && SHA.test(f.head) ? f.head : undefined;
    from = { session: f.session, ...(head ? { head } : {}) };
  }

  const value: SpawnRequest = { target, relationship, task: task.value, ...(from ? { from } : {}) };
  for (const [k, val] of Object.entries(v)) if (val !== undefined) (value as unknown as Record<string, string>)[k] = val;
  return { ok: true, value };
}

export interface ReportBody {
  session: string;
  status: ReportStatus;
  summary: string;
  refs?: string[];
}

/** The body of POST /api/spawns/report. */
export function parseReport(raw: unknown): Parsed<ReportBody> {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof body.session !== 'string' || !SESSION.test(body.session)) {
    return { ok: false, error: 'session required (the reporting pane\'s tmux session)' };
  }
  if (!REPORT_STATUSES.includes(body.status as ReportStatus)) {
    return { ok: false, error: `status must be one of: ${REPORT_STATUSES.join(', ')}` };
  }
  const summary = optString(body, 'summary', MAX_SUMMARY);
  if (!summary.ok) return summary;
  if (!summary.value) return { ok: false, error: 'summary required' };
  let refs: string[] | undefined;
  if (body.refs != null) {
    if (!Array.isArray(body.refs) || body.refs.some(r => typeof r !== 'string')) return { ok: false, error: 'refs must be a list of strings' };
    refs = (body.refs as string[]).slice(0, 20).map(r => r.slice(0, 300));
  }
  return { ok: true, value: { session: body.session, status: body.status as ReportStatus, summary: summary.value, ...(refs ? { refs } : {}) } };
}

/** The task's first non-empty line, for lists and the nudge's log line. */
export function taskTitle(task: string): string {
  const line = task.split('\n').map(l => l.trim()).find(Boolean) ?? 'task';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

const FILLER = new Set(['a', 'an', 'the', 'to', 'of', 'and', 'for', 'in', 'on', 'with', 'please', 'that', 'this', 'it', 'is', 'be']);

/** A workstream name from the task: its first few meaningful words, kebab-case, at most 32 characters. */
export function slugFromTask(task: string): string {
  const words = taskTitle(task).toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !FILLER.has(w));
  let slug = '';
  for (const w of words.slice(0, 4)) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > 32) break;
    slug = next;
  }
  if (!slug) slug = (words[0] ?? '').slice(0, 32);
  return slug && slug !== 'main' ? slug : 'task';
}

/** `base`, else `base-2`, `base-3`, … whichever is not taken (case-insensitive, like branch names on a Mac). */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const lower = new Set([...taken].map(t => t.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base.slice(0, MAX_NAME - String(i).length - 1)}-${i}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
  return `${base.slice(0, 30)}-${Date.now().toString(36)}`;
}

/**
 * The providers a spawn can start: the offered ones that can start on a
 * prompt file (the registry's promptLaunch, shared with handoff restarts).
 * A spawned agent runs in the owner's normal permission mode, unlike the
 * review's read-only modes (services/reviewers.ts).
 */
export const SPAWNABLE_PROVIDERS = Object.values(PROVIDERS).filter(p => p.selectable && p.promptLaunch).map(p => p.id);

export function isSpawnableProvider(id: string | null | undefined): id is string {
  return !!id && SPAWNABLE_PROVIDERS.includes(id);
}

/** An explicit choice, else the parent's provider, else the user's default, else Claude: the first spawnable one. */
export function chooseSpawnProvider(explicit: string | undefined, parent: string | null | undefined, userDefault: string | null | undefined): Parsed<string> {
  if (explicit) {
    return isSpawnableProvider(explicit)
      ? { ok: true, value: explicit }
      : { ok: false, error: `provider must be one of: ${SPAWNABLE_PROVIDERS.join(', ')}` };
  }
  for (const p of [parent, userDefault]) if (isSpawnableProvider(p)) return { ok: true, value: p };
  return { ok: true, value: 'claude' };
}

const PROMPT_DIR = '.termag/spawn-prompts';
const SAFE_ID = /^[a-z0-9]+$/i;

function promptFile(id: string): string {
  if (!SAFE_ID.test(id)) throw new Error('unsafe spawn id');
  return `${id}.md`;
}

/** Where write-file puts the brief (the agent applies its path_remap to this). */
export function spawnPromptPath(home: string, id: string): string {
  return `${home.replace(/\/+$/, '')}/${PROMPT_DIR}/${promptFile(id)}`;
}

/** The line typed into the child's pane: the same file, named through the pane's own $HOME. */
export function spawnLaunchCommand(provider: string, id: string): string {
  const launch = isSpawnableProvider(provider) ? PROVIDERS[provider].promptLaunch : undefined;
  if (!launch) throw new Error(`provider ${provider} cannot be spawned`);
  return launch(`"$HOME/${PROMPT_DIR}/${promptFile(id)}"`);
}

export interface BriefInput {
  relationship: SpawnRelationship;
  parent: { session: string; projectName: string; workstream: string } | null;
  child: { projectName: string; workstream: string; branch: string | null; baseRef: string | null };
  task: string;
  context?: string;
  doneWhen?: string;
}

/**
 * The prompt file. The header and the reporting section are fixed so every
 * spawned agent can tell what it is and how to hand back; only the middle is
 * the caller's text.
 */
export function buildBrief(b: BriefInput): string {
  const who = b.parent
    ? `You were started by termag as a ${b.relationship.toUpperCase()} of the agent in tmux session ${b.parent.session} (project ${b.parent.projectName}, workstream ${b.parent.workstream}).`
    : `You were started by termag as a ${b.relationship.toUpperCase()} of another agent session.`;
  const where = b.child.branch
    ? `You are in project ${b.child.projectName}, workstream ${b.child.workstream}, on git branch ${b.child.branch}${b.child.baseRef ? `, based on ${b.child.baseRef}` : ''}. Only committed work from the parent is in this checkout.`
    : `You are in project ${b.child.projectName}, workstream ${b.child.workstream}.`;
  const role = b.relationship === 'delegate'
    ? 'The parent handed you this task and is waiting for your report. Stay inside the task; ask (report needs_input) rather than widen it.'
    : 'You work alongside the parent on a parallel line of work. Coordinate through reports, not by editing its checkout.';
  const parts = [
    who,
    where,
    role,
    '',
    '--- task ---',
    b.task,
  ];
  if (b.context) parts.push('', '--- context from the parent ---', b.context);
  if (b.doneWhen) parts.push('', '--- done when ---', b.doneWhen);
  parts.push(
    '',
    '--- reporting ---',
    'When you finish, or are blocked, call the report_back tool of the metaterm MCP server (mcp__metaterm__report_back in Claude Code) with status done, blocked or needs_input',
    'and a short summary: what changed, the branch and any PR, and open questions. Report again if the state changes.',
    'If that tool is not available, say so in your final message; the parent can read your pane.',
    '',
  );
  return parts.join('\n');
}


/** The one line the nudge types. Fixed text: the child's report is never typed into the parent. */
export function nudgeLine(child: string, status: string): string {
  return `[termag] delegate ${child} reported ${status}. Call list_spawns (metaterm MCP server) to read its report.`;
}

export const NUDGE_HUMAN_QUIET_MS = 2 * 60 * 1000;
/** A parent that has not come back to idle within a day is not nudged at all. */
export const NUDGE_GIVE_UP_MS = 24 * 60 * 60 * 1000;

export interface NudgeInput {
  relationship: string;
  /** The parent pane's role; only an agent pane is typed into. Null = recorded before roles (agent). */
  parentRole?: string | null;
  reportedAt: Date | null;
  nudgedAt: Date | null;
  parentSession: string | null;
  /** The parent agent pane's live status (working / waiting / idle / not_running). */
  parentStatus: string | null;
  parentConnected: boolean;
  /** When the owner last typed into the parent's project, ms epoch. */
  humanLastTyped: number | null;
  now: number;
}

/**
 * `nudge` now, `wait` for a later sweep, or `skip` for good. Only an idle
 * parent is nudged: `waiting` is an approval prompt the typed line would
 * answer, and `working` would queue the line mid-turn.
 */
export function nudgeDecision(n: NudgeInput): 'nudge' | 'wait' | 'skip' {
  if (n.relationship !== 'delegate' || !n.parentSession) return 'skip';
  if (n.parentRole && n.parentRole !== 'agent') return 'skip';
  if (!n.reportedAt) return 'wait';
  if (n.nudgedAt && n.nudgedAt >= n.reportedAt) return 'skip';
  if (n.now - n.reportedAt.getTime() > NUDGE_GIVE_UP_MS) return 'skip';
  if (!n.parentConnected || n.parentStatus !== 'idle') return 'wait';
  if (n.humanLastTyped != null && n.now - n.humanLastTyped < NUDGE_HUMAN_QUIET_MS) return 'wait';
  return 'nudge';
}
