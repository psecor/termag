import type { ServerResponse } from 'node:http';

/** The orchestrator's POST /api/cli/v1/feedback (backend routes/cliFeedback.ts), from any credential. */
export interface FakeFeedbackState {
  /** The bodies POSTed, newest last, with whether a box credential sent them. */
  posts: Array<{ body: Record<string, unknown>; isBox: boolean }>;
  /** Kinds the orchestrator says it redacted. */
  redacted: string[];
  /** Answer the next POST with this error instead (e.g. 429 rate_limited). */
  refuse: { status: number; error: string; code: string } | null;
}

export function newFeedbackState(): FakeFeedbackState {
  return { posts: [], redacted: [], refuse: null };
}

export function handleFeedback(s: FakeFeedbackState, route: string, body: Record<string, unknown>, isBox: boolean, res: ServerResponse): boolean {
  if (route !== 'POST /feedback') return false;
  const send = (status: number, b: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(b));
  if (s.refuse) { const { status, ...rest } = s.refuse; s.refuse = null; send(status, rest); return true; }
  s.posts.push({ body, isBox });
  send(201, { id: `fb${s.posts.length}`, status: 'new', redacted: s.redacted });
  return true;
}
