import type { ServerResponse } from 'node:http';

/**
 * The orchestrator's bug-report routes on /api/cli/v1 (backend
 * routes/cliBugReports.ts): POST /bug-reports files one, from any
 * credential; GET /bug-reports, GET /bug-reports/:id and PATCH
 * /bug-reports/:id read and triage, for an admin's box only.
 */
export interface FakeBugsState {
  /** The bodies POSTed, newest last, with whether a box credential sent them. */
  posts: Array<{ body: Record<string, unknown>; isBox: boolean }>;
  /** Kinds the orchestrator says it redacted. */
  redacted: string[];
  /** Answer the next POST with this error instead (e.g. 429 rate_limited). */
  refuse: { status: number; error: string; code: string } | null;
  /** Whether the box's owner is an admin, asked on every read or triage. */
  admin: boolean;
  /** What GET /bug-reports and GET /bug-reports/:id answer. */
  list: Array<Record<string, unknown>>;
  details: Record<string, Record<string, unknown>>;
  /** The query strings of the GETs, and the PATCH bodies by id, newest last. */
  queries: string[];
  patches: Array<{ id: string; body: Record<string, unknown> }>;
}

export function newBugsState(): FakeBugsState {
  return { posts: [], redacted: [], refuse: null, admin: false, list: [], details: {}, queries: [], patches: [] };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

export function handleBugs(s: FakeBugsState, route: string, query: URLSearchParams, body: Record<string, unknown>, isBox: boolean, res: ServerResponse): boolean {
  const m = route.match(/^(GET|PATCH) \/bug-reports(?:\/([^/]+))?$/);
  if (m) {
    if (!isBox) { send(res, 403, { error: "Reading and triaging bug reports from the CLI works with an admin's box credential only; on a laptop, open /admin/bugs", code: 'box_credential_required' }); return true; }
    if (!s.admin) { send(res, 403, { error: 'Only termag admins can read or triage bug reports. File one with `termag bug report`', code: 'admin_required' }); return true; }
    const [, method, id] = m;
    if (method === 'GET' && !id) { s.queries.push(query.toString()); send(res, 200, { reports: s.list }); return true; }
    const detail = id ? s.details[decodeURIComponent(id)] : undefined;
    if (!detail) { send(res, 404, { error: 'No such bug report' }); return true; }
    if (method === 'GET') { send(res, 200, detail); return true; }
    s.patches.push({ id: decodeURIComponent(id), body });
    const report = { ...(detail.report as Record<string, unknown>), status: body.duplicateOf ? 'duplicate' : body.status ?? (detail.report as { status: string }).status, duplicateOfId: body.duplicateOf ?? null, linkUrl: body.link || null };
    send(res, 200, { report });
    return true;
  }
  if (route === 'POST /bug-reports') {
    if (s.refuse) { const { status, ...rest } = s.refuse; s.refuse = null; send(res, status, rest); return true; }
    s.posts.push({ body, isBox });
    const id = `bug${s.posts.length}`;
    send(res, 201, { id, status: 'new', redacted: s.redacted });
    return true;
  }
  return false;
}
