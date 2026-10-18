import type { ServerResponse } from 'node:http';

/**
 * The orchestrator's handoff routes on /api/cli/v1 (backend routes/cliTui.ts):
 * POST /projects/:id/handoff and GET /handoffs/:id. A handoff moves one state
 * per read, through `states`, so --wait can be followed.
 */
export interface FakeHandoffState {
  /** The bodies POSTed, newest last. */
  posts: Array<{ projectId: string; body: Record<string, unknown> }>;
  /** The states successive reads report; the last one sticks. */
  states: string[];
  reason: string | null;
  /** Answer the next POST with this error instead (e.g. 403 handoff_disabled). */
  refuse: { status: number; error: string; code: string; handoffId?: string } | null;
  note: string | null;
  reads: number;
}

export function newHandoffState(): FakeHandoffState {
  return { posts: [], states: ['writing', 'written', 'resetting', 'done'], reason: null, refuse: null, note: null, reads: 0 };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

function view(s: FakeHandoffState, body: Record<string, unknown>, state: string) {
  const mode = typeof body.mode === 'string' ? body.mode : 'clear';
  return {
    id: 'handoff1', mode, requestedMode: mode, fromProvider: 'claude',
    toProvider: typeof body.provider === 'string' ? body.provider : null,
    state, reason: state === 'failed' || state === 'aborted' ? s.reason : null,
  };
}

export function handleHandoff(s: FakeHandoffState, route: string, body: Record<string, unknown>, res: ServerResponse): boolean {
  const post = route.match(/^POST \/projects\/([^/]+)\/handoff$/);
  if (post) {
    s.posts.push({ projectId: decodeURIComponent(post[1]), body });
    if (s.refuse) { send(res, s.refuse.status, s.refuse); return true; }
    s.reads = 0;
    send(res, 202, { handoff: view(s, body, 'requested'), ...(s.note ? { note: s.note } : {}) });
    return true;
  }
  if (route === 'GET /handoffs/handoff1') {
    const state = s.states[Math.min(s.reads, s.states.length - 1)];
    s.reads += 1;
    send(res, 200, view(s, s.posts.at(-1)?.body ?? {}, state));
    return true;
  }
  return false;
}
