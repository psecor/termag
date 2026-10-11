import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The lifecycle half of the fake orchestrator (backend routes/cliLifecycle.ts).
 * Boxes move one step towards where they are going each time the box list is
 * read, so `--wait` sees provisioning → running without real time passing.
 */
export interface FakeBox {
  id: string;
  name: string;
  addressable: boolean;
  kind: string;
  state: string;
  status: string;
  agentConnected: boolean;
  error: string | null;
  projects: Array<{ id: string; name: string }>;
}

export interface FakeProject {
  id: string;
  name: string;
  ref: string;
  box: { id: string; name: string };
  provider: string | null;
  status: string;
  waitingReason: string | null;
  rateLimited: unknown;
  workstreams: string[];
}

export interface FakeLifecycleState {
  boxes: FakeBox[];
  projects: FakeProject[];
  /** Box list reads a new box spends provisioning; Infinity never finishes. */
  provisionPolls: number;
  /** What a provisioning box ends up as. */
  provisionOutcome: 'running' | 'failed';
  calls: Array<{ route: string; body: Record<string, unknown> }>;
}

const STEP: Record<string, string> = { starting: 'running', stopping: 'stopped' };
const pending = new WeakMap<FakeBox, number>();

export function newLifecycleState(boxes: FakeBox[], projects: FakeProject[]): FakeLifecycleState {
  const state: FakeLifecycleState = {
    boxes: structuredClone(boxes), projects: structuredClone(projects),
    provisionPolls: 1, provisionOutcome: 'running', calls: [],
  };
  syncBoxProjects(state);
  return state;
}

function syncBoxProjects(state: FakeLifecycleState): void {
  for (const b of state.boxes) {
    b.projects = state.projects.filter(p => p.box.id === b.id).map(p => ({ id: p.id, name: p.name }));
  }
}

/** One step of every box's transition, as a read of the box list sees it. */
export function advance(state: FakeLifecycleState): void {
  for (const b of state.boxes) {
    if (b.state === 'provisioning') {
      const left = (pending.get(b) ?? state.provisionPolls) - 1;
      pending.set(b, left);
      if (left > 0) continue;
      b.state = b.status = state.provisionOutcome === 'running' ? 'running' : 'failed';
      if (b.state === 'running') { b.status = 'ready'; b.agentConnected = true; } else b.error = 'RunInstances refused';
    } else if (STEP[b.state]) {
      b.state = STEP[b.state];
      b.status = b.state === 'running' ? 'ready' : b.state;
      b.agentConnected = b.state === 'running';
    }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

/** Answers a lifecycle route, or returns false for the caller to 404. */
export function handleLifecycle(
  state: FakeLifecycleState,
  route: string,
  body: Record<string, unknown>,
  isBoxToken: boolean,
  res: ServerResponse,
): boolean {
  const [method, path] = route.split(' ');
  const box = (id: string) => state.boxes.find(b => b.id === id);
  let m: RegExpMatchArray | null;

  if (route === 'POST /boxes') {
    state.calls.push({ route, body });
    const name = body.name as string;
    if (state.boxes.some(b => b.name === name)) { send(res, 409, { error: `A box named "${name}" already exists`, code: 'conflict' }); return true; }
    const b: FakeBox = {
      id: `i-${name}`, name, addressable: true, kind: 'ec2', state: 'provisioning', status: 'provisioning',
      agentConnected: false, error: null, projects: [],
    };
    state.boxes.push(b);
    send(res, 201, { box: b, claimed: false });
    return true;
  }
  if (method === 'POST' && (m = path.match(/^\/boxes\/([^/]+)\/(start|stop)$/))) {
    state.calls.push({ route, body });
    const b = box(decodeURIComponent(m[1]));
    if (!b) { send(res, 404, { error: 'Box not found' }); return true; }
    const from = m[2] === 'start' ? ['stopped'] : ['running', 'starting'];
    if (!from.includes(b.state)) { send(res, 409, { error: `Can't ${m[2]} a box that is ${b.status}`, code: 'conflict' }); return true; }
    b.state = b.status = m[2] === 'start' ? 'starting' : 'stopping';
    b.agentConnected = false;
    send(res, 202, { box: b });
    return true;
  }
  if (method === 'DELETE' && (m = path.match(/^\/boxes\/([^/]+)$/))) {
    state.calls.push({ route, body });
    if (isBoxToken) { send(res, 403, { error: "A box's own credentials can't terminate boxes", code: 'forbidden' }); return true; }
    const b = box(decodeURIComponent(m[1]));
    if (!b) { send(res, 404, { error: 'Box not found' }); return true; }
    const live = state.projects.filter(p => p.box.id === b.id);
    if (live.length && body.confirmed !== true) { send(res, 409, { error: 'Box has live projects', code: 'has_projects', projects: b.projects }); return true; }
    state.projects = state.projects.filter(p => p.box.id !== b.id);
    state.boxes = state.boxes.filter(x => x !== b);
    send(res, 200, { ok: true, archivedProjects: live.length, alreadyTerminated: false });
    return true;
  }
  if (route === 'POST /projects') {
    state.calls.push({ route, body });
    const b = box(body.boxId as string);
    if (!b) { send(res, 400, { error: 'instanceId not found or not owned by you' }); return true; }
    if (b.state !== 'running') { send(res, 409, { error: 'This box is stopped. Start it from the Boxes list first.', code: 'conflict' }); return true; }
    const name = body.name as string;
    if (state.projects.some(p => p.box.id === b.id && p.name === name)) { send(res, 409, { error: 'Project name already exists', code: 'conflict' }); return true; }
    const p: FakeProject = {
      id: `p-${name}`, name, ref: `${b.name}/${name}`, box: { id: b.id, name: b.name }, provider: body.agent as string,
      status: 'idle', waitingReason: null, rateLimited: null, workstreams: ['main'],
    };
    state.projects.push(p);
    syncBoxProjects(state);
    send(res, 201, { project: p, restored: false });
    return true;
  }
  if (method === 'POST' && (m = path.match(/^\/projects\/([^/]+)\/(rename|archive)$/))) {
    state.calls.push({ route, body });
    const p = state.projects.find(x => x.id === decodeURIComponent(m![1]));
    if (!p) { send(res, 404, { error: 'Not found' }); return true; }
    if (m[2] === 'archive') {
      state.projects = state.projects.filter(x => x !== p);
      syncBoxProjects(state);
      send(res, 200, { ok: true });
      return true;
    }
    p.name = body.name as string;
    p.ref = `${p.box.name}/${p.name}`;
    syncBoxProjects(state);
    send(res, 200, { project: p });
    return true;
  }
  return false;
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}
