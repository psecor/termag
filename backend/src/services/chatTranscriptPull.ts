/**
 * One pull of a chat's transcript from its box (chatTranscriptSync.ts): read
 * the session file from the stored offset, store it, repeat until the box
 * has nothing more. Pure: the reads and writes are handed in.
 */
import type { AppendResult, ChunkKey, TranscriptHead } from './chatTranscriptStore';

/** Reads one pull makes at most; the next turn end or connect continues. */
export const MAX_READS = 64;

export interface TranscriptRead {
  sessionId: string | null;
  from: number;
  size: number;
  data: Buffer;
  shrunk: boolean;
  /** The box can't find the session file: nothing to read, and nothing stored is dropped. */
  missing: boolean;
  /** A line at `from` too long for the box to read: its length with its newline, to step past. */
  skipped: number;
}

/** A chat-transcript-read answer, or null for anything that isn't one. */
export function parseTranscriptRead(raw: unknown): TranscriptRead | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.sessionId === null) return { sessionId: null, from: 0, size: 0, data: Buffer.alloc(0), shrunk: false, missing: false, skipped: 0 };
  if (typeof r.sessionId !== 'string' || !Number.isSafeInteger(r.from) || !Number.isSafeInteger(r.size)) return null;
  if ((r.from as number) < 0 || typeof r.data !== 'string') return null;
  const skipped = Number.isSafeInteger(r.skipped) && (r.skipped as number) > 0 ? r.skipped as number : 0;
  return { sessionId: r.sessionId, from: r.from as number, size: r.size as number, data: Buffer.from(r.data, 'base64'), shrunk: r.shrunk === true, missing: r.missing === true, skipped };
}

export interface PullDeps {
  head(): Promise<TranscriptHead | null>;
  read(sessionId: string | null, from: number): Promise<unknown>;
  /** `skipped` stores a placeholder for that many unread bytes instead of `data` (appendChunk). */
  append(k: Omit<ChunkKey, 'projectId' | 'workstreamId'>, data: Buffer, skipped?: number): Promise<AppendResult>;
  reset(sessionId: string): Promise<void>;
}

/** Store everything the box has past what is stored. Returns the bytes stored. */
export async function pullTranscript(deps: PullDeps): Promise<number> {
  let head = await deps.head();
  let stored = 0;
  for (let i = 0; i < MAX_READS; i++) {
    const r = parseTranscriptRead(await deps.read(head?.sessionId ?? null, head?.rawBytes ?? 0));
    if (!r) throw new Error('the box sent an unreadable chat-transcript-read answer');
    if (!r.sessionId || r.missing) return stored;
    if (r.shrunk) {
      await deps.reset(r.sessionId);
      head = { sessionId: r.sessionId, rawBytes: 0, rawCapped: false };
      continue;
    }
    const known = head?.sessionId === r.sessionId;
    if (known && !r.data.length && !r.skipped) return stored;
    const res = r.skipped
      ? await deps.append({ sessionId: r.sessionId, byteStart: r.from }, Buffer.alloc(0), r.skipped)
      : await deps.append({ sessionId: r.sessionId, byteStart: r.from }, r.data);
    if (!res.ok) {
      head = { sessionId: r.sessionId, rawBytes: res.expected, rawCapped: false };
      continue;
    }
    stored += r.data.length;
    head = { sessionId: r.sessionId, rawBytes: res.rawBytes, rawCapped: false };
    if (res.rawBytes >= r.size || (!r.data.length && !r.skipped)) return stored;
  }
  return stored;
}


/** One pull per key at a time; a call during one makes it run once more, even when the running pull fails. `pull` returns false to stop. */
export async function coalescePulls(running: Map<string, { again: boolean }>, key: string, pull: () => Promise<boolean>, onError: (err: unknown) => void): Promise<void> {
  const inFlight = running.get(key);
  if (inFlight) { inFlight.again = true; return; }
  const state = { again: false };
  running.set(key, state);
  try {
    do {
      state.again = false;
      try { if (!await pull()) break; } catch (err) { onError(err); }
    } while (state.again);
  } finally { running.delete(key); }
}

/** `fn` over `items`, at most `limit` at once. A rejection is `fn`'s to handle; the first one rejects this. */
export async function forEachBounded<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
