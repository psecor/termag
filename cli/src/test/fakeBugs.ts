import type { ServerResponse } from 'node:http';

/**
 * The orchestrator's bug-report routes on /api/cli/v1 (backend
 * routes/cliBugReports.ts): POST /bug-reports files one. Nothing reads them
 * back; that route is write-only.
 */
export interface FakeBugsState {
  /** The bodies POSTed, newest last, with whether a box credential sent them. */
  posts: Array<{ body: Record<string, unknown>; isBox: boolean }>;
  /** Kinds the orchestrator says it redacted. */
  redacted: string[];
  /** Answer the next POST with this error instead (e.g. 429 rate_limited). */
  refuse: { status: number; error: string; code: string } | null;
}

export function newBugsState(): FakeBugsState {
  return { posts: [], redacted: [], refuse: null };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

export function handleBugs(s: FakeBugsState, route: string, body: Record<string, unknown>, isBox: boolean, res: ServerResponse): boolean {
  if (route === 'POST /bug-reports') {
    if (s.refuse) { const { status, ...rest } = s.refuse; s.refuse = null; send(res, status, rest); return true; }
    s.posts.push({ body, isBox });
    const id = `bug${s.posts.length}`;
    send(res, 201, { id, status: 'new', redacted: s.redacted });
    return true;
  }
  return false;
}
