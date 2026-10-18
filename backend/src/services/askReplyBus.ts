/**
 * The wire format and the in-memory hand-off behind ask replies.
 *
 * A reply is never written to the database. The orchestrator that receives a
 * box's result sends the text as Postgres NOTIFYs on REPLY_CHANNEL in the same
 * transaction that marks the message finished, so every orchestrator process
 * listening on the shared database (both halves of an overlapping deploy) gets
 * it at commit and can answer whichever long poll the asker's CLI holds.
 * NOTIFY payloads are capped below 8000 bytes, so the text travels as base64
 * chunks; each process reassembles them and holds the result for HANDOFF_TTL_MS,
 * then forgets it. services/askReplyListener.ts owns the LISTEN connection.
 */

export const REPLY_CHANNEL = 'termag_ask_reply';
/** Postgres refuses a NOTIFY payload of 8000 bytes or more. */
export const NOTIFY_PAYLOAD_MAX = 7999;
/** Raw bytes per chunk: 5400 encode to 7200 base64 characters, plus a short header. */
export const CHUNK_BYTES = 5400;
/** How long a process holds a finished reply for a poll to collect. */
export const HANDOFF_TTL_MS = 60_000;
/** A reply whose chunks have not all arrived by then is abandoned. */
const PARTIAL_TTL_MS = 30_000;
const MAX_CHUNKS = 10_000;

const PAYLOAD = /^([A-Za-z0-9_-]{1,64}):(\d{1,5}):(\d{1,5}):([A-Za-z0-9+/=]*)$/;

/** `<message>:<index>:<total>:<base64>` payloads, each under NOTIFY_PAYLOAD_MAX. */
export function chunkReply(messageId: string, text: string): string[] {
  const buf = Buffer.from(text, 'utf8');
  const total = Math.max(1, Math.ceil(buf.length / CHUNK_BYTES));
  const out: string[] = [];
  for (let i = 0; i < total; i++) {
    out.push(`${messageId}:${i}:${total}:${buf.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).toString('base64')}`);
  }
  return out;
}

/** Collects chunks per message; returns the text when the last one arrives. */
export class ReplyAssembler {
  private partial = new Map<string, { parts: Buffer[]; got: number; total: number; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  accept(payload: string): { messageId: string; text: string } | null {
    const m = PAYLOAD.exec(payload);
    if (!m) return null;
    const id = m[1];
    const index = Number(m[2]);
    const total = Number(m[3]);
    if (total < 1 || total > MAX_CHUNKS || index >= total) return null;
    const t = this.now();
    for (const [k, p] of this.partial) if (t - p.at > PARTIAL_TTL_MS) this.partial.delete(k);
    let p = this.partial.get(id);
    if (!p || p.total !== total) {
      p = { parts: new Array<Buffer>(total), got: 0, total, at: t };
      this.partial.set(id, p);
    }
    if (!p.parts[index]) {
      p.parts[index] = Buffer.from(m[4], 'base64');
      p.got++;
    }
    if (p.got < total) return null;
    this.partial.delete(id);
    return { messageId: id, text: Buffer.concat(p.parts).toString('utf8') };
  }

  get pending(): number {
    return this.partial.size;
  }
}

/** Finished replies this process can hand to a poll, each for HANDOFF_TTL_MS. */
export class ReplyHandoff {
  private held = new Map<string, { text: string; until: number }>();

  constructor(private readonly ttlMs = HANDOFF_TTL_MS, private readonly now: () => number = Date.now) {}

  /** A second put (the local copy and the NOTIFY) keeps the first expiry. */
  put(messageId: string, text: string): void {
    this.prune();
    if (!this.held.has(messageId)) this.held.set(messageId, { text, until: this.now() + this.ttlMs });
  }

  get(messageId: string): string | null {
    this.prune();
    return this.held.get(messageId)?.text ?? null;
  }

  get size(): number {
    this.prune();
    return this.held.size;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, v] of this.held) if (v.until <= t) this.held.delete(k);
  }
}
