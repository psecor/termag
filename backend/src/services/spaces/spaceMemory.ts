/**
 * A space's shared agent memory, `.termag/`: the pure
 * part of what the orchestrator adds for it. The orchestrator never reads the
 * files: the box's CLI syncs, scans and indexes them (`termag space memory`).
 * Here are only the history it serves (who changed what, and why) and the
 * conditional writes it signs, so two agents editing one memory can't
 * silently overwrite each other.
 *
 * `.termag/tools/` is not memory: space tools are rendered to people, not
 * loaded into agents, so it has no writers, no log and no longer retention.
 * Nor is `.termag/skills/`: v1 loads memories only (plan-outbox #50), and
 * skills live in a repo's `.claude/skills/`, reviewed through PRs. Nor is
 * `.termag/automations/`, where each automation keeps its notes, state and
 * run logs (automations/spaceFolder.ts): its runs write there every time
 * they run, so its events would bury the memory log and never be pruned.
 */
import { findSecretsInText } from '../askPublish';
import type { SpaceEventRecord } from './spaceStore';

export const MEMORY_ROOT = '.termag/';
export const TOOLS_ROOT = '.termag/tools/';
export const SKILLS_ROOT = '.termag/skills/';
/** automations/spaceFolder.ts AUTOMATIONS_SPACE_ROOT (spaceMemory.test.ts holds them equal). */
export const AUTOMATIONS_ROOT = '.termag/automations/';
/** The folders under `.termag/` that are not memory. */
const NOT_MEMORY = [TOOLS_ROOT, SKILLS_ROOT, AUTOMATIONS_ROOT];
/**
 * `.termag/` history is kept indefinitely (the person's decision, 2026-10-27):
 * it is the memory's changelog. Other events go after 90 days
 * (spaceSweeper.ts EVENT_RETENTION_MS). S3 keeps every version too, and a
 * space's used bytes count them all.
 */
export const MEMORY_EVENT_RETENTION = 'keep' as const;
export const NOTE_MAX_CHARS = 200;
export const MEMORY_LOG_MAX = 500;
/** The events that change a file: the ones the log and the writers are made of. */
export const MEMORY_ACTIONS = ['file.put', 'file.put.signed', 'file.rm', 'file.mv'] as const;

/** Whether a space path is memory: under `.termag/`, and not a tool, a skill or an automation's folder. */
export function isMemoryPath(path: string): boolean {
  return path.startsWith(MEMORY_ROOT) && path !== MEMORY_ROOT && !NOT_MEMORY.some(r => path.startsWith(r));
}

/**
 * Whether an event path (one side of a move) touches memory: a memory path,
 * or `.termag/` itself, whose delete or move takes every memory with it
 * (memoryPathWhere matches it too). Never a writer's path (isMemoryPath).
 */
function touchesMemory(path: string): boolean {
  return path === MEMORY_ROOT || isMemoryPath(path);
}

/** Whether an event's path is about memory; a move's is `from -> to`, either side counts. */
export function isMemoryEvent(e: Pick<SpaceEventRecord, 'action' | 'path'>): boolean {
  if (!e.path || !(MEMORY_ACTIONS as readonly string[]).includes(e.action)) return false;
  return e.action === 'file.mv' ? e.path.split(' -> ').some(touchesMemory) : touchesMemory(e.path);
}

/**
 * The paths of memory events, as a Prisma `where`: under `.termag/` but not
 * a tool or a skill, or a move into `.termag/` (not into those). In the
 * database, so a `take` counts memory events only, however often a tool
 * rewrites its data.
 */
export function memoryPathWhere() {
  return {
    OR: [
      { AND: [{ path: { startsWith: MEMORY_ROOT } }, ...NOT_MEMORY.map(r => ({ NOT: { path: { startsWith: r } } }))] },
      { AND: [{ path: { contains: ` -> ${MEMORY_ROOT}` } }, ...NOT_MEMORY.map(r => ({ NOT: { path: { contains: ` -> ${r}` } } }))] },
    ],
  };
}

/** findMany args for memory events (spaceStorePrisma memoryEvents); isMemoryEvent still checks each row. */
export function memoryEventsQuery(spaceId: string, since: Date, limit: number) {
  return {
    where: { spaceId, at: { gte: since }, action: { in: [...MEMORY_ACTIONS] }, ...memoryPathWhere() },
    orderBy: { at: 'desc' as const },
    take: limit,
  };
}

/** The deleteMany where of the event prune: everything before `before` but memory events (moves in included), which stay. */
export function pruneEventsWhere(before: Date) {
  // A null path is not memory: NOT (…) over NULL alone would keep those rows forever.
  const notMemory = { OR: [{ path: null }, { NOT: memoryPathWhere() }] };
  return { AND: [{ at: { lt: before } }, notMemory] };
}

/** Whether an event path is memory's (a move's either side), as memoryPathWhere decides it in the database. */
export function isMemoryEventPath(path: string | null | undefined): boolean {
  return !!path && path.split(' -> ').some(touchesMemory);
}

export class MemoryRequestError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface PutCondition { ifMatch?: string; ifNoneMatch?: '*' }

const ETAG_RE = /^(?:W\/)?"?([A-Za-z0-9-]{1,100})"?$/;

/**
 * The condition an upload asks for: `ifMatch` an ETag the caller read (the
 * write fails with 412 if anyone wrote since), or `ifNoneMatch: '*'` (it fails
 * if the file exists). Null when it asks for none; both at once is refused.
 */
export function putConditionOf(body: Record<string, unknown>): PutCondition | null {
  const { ifMatch, ifNoneMatch } = body;
  if (ifMatch === undefined && ifNoneMatch === undefined) return null;
  if (ifMatch !== undefined && ifNoneMatch !== undefined) {
    throw new MemoryRequestError('invalid_condition', 'Give ifMatch or ifNoneMatch, not both');
  }
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch !== '*') throw new MemoryRequestError('invalid_condition', 'ifNoneMatch must be "*"');
    return { ifNoneMatch: '*' };
  }
  const m = typeof ifMatch === 'string' ? ETAG_RE.exec(ifMatch.trim()) : null;
  if (!m) throw new MemoryRequestError('invalid_condition', 'ifMatch must be an ETag, as the tree listing gives it');
  return { ifMatch: `"${m[1]}"` };
}

/** A writer's note: trimmed, at most NOTE_MAX_CHARS, one line, and never a secret. Null when there is none. */
export function noteOf(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new MemoryRequestError('invalid_note', 'note must be text');
  const note = raw.replace(/\s+/g, ' ').trim();
  if (!note) return null;
  if (note.length > NOTE_MAX_CHARS) throw new MemoryRequestError('invalid_note', `A note is at most ${NOTE_MAX_CHARS} characters`);
  const secrets = findSecretsInText(note);
  if (secrets.length) throw new MemoryRequestError('note_secret', `The note looks like it holds a secret (${secrets.join(', ')}); it was not recorded`);
  return note;
}

export interface MemoryActor { userId: string; email: string | null; name: string | null; box: string | null }
export interface MemoryWriter extends MemoryActor { at: string; versionId: string | null; note: string | null }

/**
 * The last writer of each memory path, from events newest first: the newest
 * put (confirmed or only signed) of a path that no later rm or mv removed.
 */
export function lastWriters(events: SpaceEventRecord[], actor: (e: SpaceEventRecord) => MemoryActor): Record<string, MemoryWriter> {
  const out: Record<string, MemoryWriter> = {};
  // Paths, and folders (ending in /), whose older events no longer say who wrote what is there now.
  const gone = new Set<string>();
  const goneDirs: string[] = [];
  const settled = (p: string) => gone.has(p) || goneDirs.some(d => p.startsWith(d));
  for (const e of events) {
    if (!e.path || !isMemoryEvent(e)) continue;
    if (e.action === 'file.rm') { if (e.path.endsWith('/')) goneDirs.push(e.path); else gone.add(e.path); continue; }
    if (e.action === 'file.mv') {
      const [from, to] = e.path.split(' -> ');
      if (from.endsWith('/')) {
        // A folder move: its files' writers aren't known here, on either side.
        goneDirs.push(from, to);
        continue;
      }
      // The destination is the moved file now: the move is its last write, unless a later write already is.
      if (to && !out[to] && !settled(to) && isMemoryPath(to)) out[to] = { ...actor(e), at: e.at.toISOString(), versionId: null, note: e.note ?? null };
      gone.add(from);
      if (to) gone.add(to);
      continue;
    }
    if (out[e.path] || settled(e.path) || !isMemoryPath(e.path)) continue;
    // A signed PUT without its confirm can be newer than the confirm of the write before it; either names the writer.
    out[e.path] = { ...actor(e), at: e.at.toISOString(), versionId: e.versionId ?? null, note: e.note ?? null };
  }
  return out;
}

/** `7d`, `12h`, `30m` or an ISO date, as a Date; null when absent, an error when unreadable. */
export function sinceOf(raw: unknown, now: number): Date | null {
  if (raw === undefined || raw === '') return null;
  const s = String(raw);
  const m = /^(\d{1,4})([dhm])$/.exec(s);
  if (m) return new Date(now - Number(m[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2] as 'd' | 'h' | 'm']);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new MemoryRequestError('invalid_since', 'since is 7d, 12h, 30m or a date');
  return new Date(t);
}

/** One line of `termag space memory log`: a confirmed change, not the signing that preceded it. */
export function logEntries(events: SpaceEventRecord[], actor: (e: SpaceEventRecord) => MemoryActor) {
  return events
    .filter(e => isMemoryEvent(e) && e.action !== 'file.put.signed')
    .map(e => ({
      at: e.at.toISOString(), action: e.action, path: e.path!, bytes: e.bytes === null || e.bytes === undefined ? null : Number(e.bytes),
      versionId: e.versionId ?? null, note: e.note ?? null, ...actor(e),
    }));
}
