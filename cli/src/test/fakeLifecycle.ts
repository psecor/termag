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
  // Same optionality as the API's Box: the fake's own made-boxes always set it
  // (the CLI sends the field), the hand-written fixtures may not.
  flavor?: string;
  state: string;
  status: string;
  agentConnected: boolean;
  error: string | null;
  projects: Array<{ id: string; name: string }>;
  size?: string | null;
  instanceType?: string | null;
  resize?: { to: string; from: string | null; phase: string; running: boolean; error: string | null } | null;
  diskGiB?: number | null;
  /** 'ask' for a box made with createdFor: 'ask', which the real orchestrator also gives the ask-box policy. */
  createdFor?: string | null;
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
  createdFor?: string | null;
  workstreams: string[];
}

export interface FakeLifecycleState {
  boxes: FakeBox[];
  projects: FakeProject[];
  /** Box list reads a new box spends provisioning; Infinity never finishes. */
  provisionPolls: number;
  /** Box list reads a stopping or hibernating box spends before it has parked. */
  parkPolls: number;
  /** What a provisioning box ends up as. */
  provisionOutcome: 'running' | 'failed';
  /** False plays an orchestrator from before a project could wait for its box. */
  projectWaitsForBox: boolean;
  calls: Array<{ route: string; body: Record<string, unknown> }>;
  /** Box ids launched without hibernation: their auto-park setting comes back with a warning. */
  cannotHibernate: Set<string>;
  /** Boxes auto-park can't run on (not an EC2 box termag runs): the orchestrator's warning. */
  cannotPark: Set<string>;
  /** box-idle-stop-enabled's window for a box with no idle hours, or null when that flag is off. */
  idleStopHours: number | null;
  /** box-default-size: null is the flag off (no sizes, a size asked for refused), else the owner's default. */
  defaultSize: string | null;
  /** What a resize of a running box is refused for until `force` (backend boxResizePolicy blockers); empty is idle. */
  resizeBlockers: Array<{ check: string; reason: string; forceable: boolean }>;
  /** Each `from`'s .termag/environment.json as the orchestrator read it: its preset, and the warnings for what it left out. */
  repoFiles: Record<string, { size?: string; diskGiB?: number; warnings?: string[] }>;
  /** Fields a box made by POST /boxes gets as well (an EC2 instance to reach, say). */
  newBoxFields: Record<string, unknown>;
  /** Fields a project made by POST /projects gets as well (its directory, say). */
  newProjectFields: Record<string, unknown>;
}

const TEMPLATES: Record<string, string> = {
  webapp: 'https://github.com/example-org/webapp.git',
  research: 'https://github.com/example-org/research.git',
};
const STEP: Record<string, string> = { starting: 'running', stopping: 'stopped', hibernating: 'hibernated' };
const pending = new WeakMap<FakeBox, number>();

export function newLifecycleState(boxes: FakeBox[], projects: FakeProject[]): FakeLifecycleState {
  const state: FakeLifecycleState = {
    boxes: structuredClone(boxes), projects: structuredClone(projects),
    provisionPolls: 1, parkPolls: 1, provisionOutcome: 'running', projectWaitsForBox: true, calls: [], cannotHibernate: new Set(), cannotPark: new Set(), idleStopHours: null, defaultSize: null, resizeBlockers: [], repoFiles: {},
    newBoxFields: {}, newProjectFields: {},
  };
  syncBoxProjects(state);
  return state;
}

function syncBoxProjects(state: FakeLifecycleState): void {
  for (const b of state.boxes) {
    b.projects = state.projects.filter(p => p.box.id === b.id).map(p => ({ id: p.id, name: p.name }));
  }
}

const RESIZE_STEP: Record<string, string> = { stopping: 'resizing', resizing: 'starting', starting: 'ready' };
const RESIZE_TYPES: Record<string, string> = { small: 'm8g.large', medium: 'm8g.xlarge', large: 'm8g.2xlarge' };

/** One step of every box's transition, as a read of the box list sees it. */
export function advance(state: FakeLifecycleState): void {
  for (const b of state.boxes) {
    const r = b.resize;
    if (r?.running) {
      // A box that was down is retyped and left stopped; a running one goes round to ready.
      r.phase = r.phase === 'resizing' && b.state === 'stopped' ? 'stopped' : RESIZE_STEP[r.phase] ?? r.phase;
      if (r.phase === 'ready' || r.phase === 'stopped') { r.running = false; b.size = r.to; b.instanceType = RESIZE_TYPES[r.to]; }
      continue;
    }
    if (b.state === 'provisioning') {
      const left = (pending.get(b) ?? state.provisionPolls) - 1;
      pending.set(b, left);
      if (left > 0) continue;
      b.state = b.status = state.provisionOutcome === 'running' ? 'running' : 'failed';
      if (b.state === 'running') { b.status = 'ready'; b.agentConnected = true; } else b.error = 'RunInstances refused';
    } else if (STEP[b.state]) {
      if (b.state === 'stopping' || b.state === 'hibernating') {
        const left = (pending.get(b) ?? state.parkPolls) - 1;
        pending.set(b, left);
        if (left > 0) continue;
        pending.delete(b);
      }
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
    // A launch that failed is retried under its own name: the failed box is retired, unless a project waits on it
    // (its own Retry relaunches it then), as backend routes/instances.ts createBox does.
    const same = state.boxes.find(b => b.name === name);
    if (same?.state === 'failed') {
      if (state.projects.some(p => p.box.id === same.id)) {
        send(res, 409, { error: `"${name}" failed to launch; use Retry on its project to launch it again`, code: 'conflict' });
        return true;
      }
      state.boxes = state.boxes.filter(b => b !== same);
    } else if (same) { send(res, 409, { error: `A box named "${name}" already exists`, code: 'conflict' }); return true; }
    // The orchestrator's size order (backend services/boxSize.ts decideBoxSize), as far as the CLI sees it:
    // with the flag on, an explicit size, else the `from` repos' environment.json (the largest), else the default; off, none.
    const types: Record<string, string> = { small: 'm8g.large', medium: 'm8g.xlarge', large: 'm8g.2xlarge' };
    if (body.size !== undefined && !state.defaultSize) { send(res, 403, { error: 'Choosing a box size is not turned on for you yet', code: 'box_size_disabled' }); return true; }
    if (body.size !== undefined && !types[body.size as string]) { send(res, 400, { error: 'size must be one of small, medium, large', code: 'invalid_size' }); return true; }
    // The disk (backend services/boxDiskSize.ts): asked for, else the largest repo file's, else 120; no flag.
    if (body.diskGiB !== undefined && !(Number.isInteger(body.diskGiB) && (body.diskGiB as number) >= 50 && (body.diskGiB as number) <= 300)) {
      send(res, 400, { error: 'diskGiB must be a whole number of GB from 50 to 300', code: 'invalid_disk' }); return true;
    }
    const forAsk = body.createdFor === 'ask';
    const files = [body.from ?? []].flat().map(f => state.repoFiles[String(f)]).filter(Boolean);
    const order = ['small', 'medium', 'large'];
    const fromFile = files.map(f => f.size).filter((x): x is string => !!x).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0];
    const size = !state.defaultSize ? null
      : typeof body.size === 'string' ? body.size
      : fromFile ?? state.defaultSize;
    const fileDisks = files.map(f => f.diskGiB).filter((d): d is number => d != null);
    const diskGiB = typeof body.diskGiB === 'number' ? body.diskGiB : fileDisks.length ? Math.max(...fileDisks) : 120;
    const b: FakeBox = {
      id: `i-${name}`, name, addressable: true, kind: 'ec2',
      flavor: body.flavor === 'minimal' || body.minimal === true ? 'minimal' : 'full',
      state: 'provisioning', status: 'provisioning',
      agentConnected: false, error: null, projects: [], size, instanceType: size ? types[size] : 't4g.medium', diskGiB,
      ...(forAsk ? { createdFor: 'ask' } : {}), ...state.newBoxFields,
    };
    state.boxes.push(b);
    const warnings = state.defaultSize && body.size === undefined ? files.flatMap(f => f.warnings ?? []) : [];
    send(res, 201, { box: b, claimed: false, ...(warnings.length ? { warnings } : {}) });
    return true;
  }
  if (method === 'POST' && (m = path.match(/^\/boxes\/([^/]+)\/(start|stop)$/))) {
    state.calls.push({ route, body });
    const b = box(decodeURIComponent(m[1]));
    if (!b) { send(res, 404, { error: 'Box not found' }); return true; }
    const from = m[2] === 'start' ? ['stopped', 'hibernated'] : ['running', 'starting'];
    if (!from.includes(b.state)) { send(res, 409, { error: `Can't ${m[2]} a box that is ${b.status}`, code: 'conflict' }); return true; }
    b.state = b.status = m[2] === 'start' ? 'starting' : 'stopping';
    b.agentConnected = false;
    send(res, 202, { box: b });
    return true;
  }
  if (method === 'POST' && (m = path.match(/^\/boxes\/([^/]+)\/resize$/))) {
    state.calls.push({ route, body });
    const b = box(decodeURIComponent(m[1]));
    if (!b) { send(res, 404, { error: 'Box not found' }); return true; }
    if (!RESIZE_TYPES[body.size as string]) { send(res, 400, { error: 'size must be one of small, medium, large', code: 'invalid_size' }); return true; }
    if (b.resize?.running) { send(res, 409, { error: 'This box is already being resized; one resize at a time', code: 'resize_running' }); return true; }
    if (b.state === 'running' && state.resizeBlockers.length && body.force !== true) {
      const forceable = state.resizeBlockers.every(x => x.forceable);
      send(res, 409, {
        error: `Resizing stops this box for two to three minutes, and ${state.resizeBlockers.map(x => x.reason).join('; ')}.`,
        code: 'box_busy', blockers: state.resizeBlockers, forceable,
      });
      return true;
    }
    b.resize = { to: body.size as string, from: b.size ?? null, phase: b.state === 'running' ? 'stopping' : 'resizing', running: true, error: null };
    send(res, 202, { box: b, resize: b.resize });
    return true;
  }
  if (method === 'POST' && (m = path.match(/^\/boxes\/([^/]+)\/keep-running$/))) {
    state.calls.push({ route, body });
    const b = box(decodeURIComponent(m[1]));
    if (!b) { send(res, 404, { error: 'Box not found' }); return true; }
    if (b.state !== 'running') { send(res, 409, { error: `Only a running box can be kept running; ${b.name} is ${b.status}`, code: 'conflict' }); return true; }
    send(res, 200, { lifecycle: { idleHibernateHours: null, idleLimitHours: state.idleStopHours, idleLimitSource: state.idleStopHours ? 'default' : null, hibernatedTerminateDays: null, warning: null } });
    return true;
  }
  if (method === 'PATCH' && (m = path.match(/^\/boxes\/([^/]+)\/lifecycle$/))) {
    state.calls.push({ route, body });
    const b = box(decodeURIComponent(m[1]));
    if (!b) { send(res, 404, { error: 'Box not found' }); return true; }
    const hours = (body.idleHibernateHours ?? null) as number | null;
    const days = (body.hibernatedTerminateDays ?? null) as number | null;
    const canAutoHibernate = !state.cannotHibernate.has(b.id);
    // Parking is a stop, so own hours run on a box that can't hibernate too; only cannotPark warns.
    const ownRuns = !state.cannotPark.has(b.id);
    send(res, 200, {
      lifecycle: {
        canAutoHibernate, idleHibernateHours: hours, hibernatedTerminateDays: days, hibernateDueAt: null,
        terminateDueAt: null, parkedAt: null, unsavedWork: null, note: null,
        idleLimitHours: hours !== null && ownRuns ? hours : hours === null ? state.idleStopHours : null,
        idleLimitSource: hours !== null && ownRuns ? 'own' : hours === null && state.idleStopHours !== null ? 'default' : null,
        warning: (hours !== null || days !== null) && !ownRuns ? "This box (or its image) can't hibernate, so auto-park does nothing on it." : null,
        parkStop: true,
      },
    });
    return true;
  }
  if (method === 'POST' && (m = path.match(/^\/boxes\/([^/]+)\/rename$/))) {
    state.calls.push({ route, body });
    const b = box(decodeURIComponent(m[1]));
    if (!b) { send(res, 404, { error: 'Box not found' }); return true; }
    const name = body.name as string;
    if (state.boxes.some(x => x !== b && x.name === name)) { send(res, 409, { error: `A box named "${name}" already exists`, code: 'conflict' }); return true; }
    b.name = name;
    for (const p of state.projects.filter(x => x.box.id === b.id)) {
      p.box.name = name;
      p.ref = `${name}/${p.name}`;
    }
    send(res, 200, { box: b });
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
    const waits = b.state === 'provisioning' && state.projectWaitsForBox;
    if (b.state === 'provisioning' && !waits) { send(res, 503, { error: 'Box agent is not connected' }); return true; }
    if (b.state !== 'running' && !waits) { send(res, 409, { error: 'This box is stopped. Start it from the Boxes list first.', code: 'conflict' }); return true; }
    const name = body.name as string;
    // `from`: one source, or a list of them for a multi-repo project, whose checkouts are named by repository.
    const urls: string[] = [];
    for (const from of [body.from ?? []].flat() as string[]) {
      const url = TEMPLATES[from] ?? (/^(https:\/\/github\.com\/|git@github\.com:)/.test(from) ? from : null);
      if (!url) { send(res, 400, { error: 'from must be a template (webapp, research) or a GitHub repository URL', code: 'invalid_request' }); return true; }
      urls.push(url);
    }
    const repoUrl = urls[0] ?? null;
    const repos = urls.length > 1 ? urls.map(url => ({ name: url.replace(/\.git$/, '').split('/').at(-1)!, url })) : null;
    if (state.projects.some(p => p.box.id === b.id && p.name === name)) { send(res, 409, { error: 'Project name already exists', code: 'conflict' }); return true; }
    const p: FakeProject = {
      id: `p-${name}`, name, ref: `${b.name}/${name}`, box: { id: b.id, name: b.name }, provider: body.agent as string,
      status: 'idle', waitingReason: null, rateLimited: null, workstreams: ['main'], ...state.newProjectFields,
    };
    state.projects.push(p);
    syncBoxProjects(state);
    send(res, 201, { project: p, restored: false, repoUrl, ...(repos ? { repos } : {}) });
    return true;
  }
  // Retry on a project whose box failed to launch: a new box of the same name and size, the project moved onto it
  // (backend routes/projects.ts relaunchBoxFor).
  if (method === 'POST' && (m = path.match(/^\/projects\/([^/]+)\/clone\/retry$/))) {
    state.calls.push({ route, body });
    const p = state.projects.find(x => x.id === decodeURIComponent(m![1]));
    const old = p && box(p.box.id);
    if (!p || !old) { send(res, 404, { error: 'Not found' }); return true; }
    if (old.state !== 'failed') { send(res, 409, { error: 'Only a failed clone can be retried.', code: 'conflict' }); return true; }
    const fresh: FakeBox = { ...old, id: `${old.id}-2`, state: 'provisioning', status: 'provisioning', agentConnected: false, error: null, projects: [] };
    state.boxes = [...state.boxes.filter(b => b !== old), fresh];
    p.box = { id: fresh.id, name: fresh.name };
    syncBoxProjects(state);
    send(res, 202, { project: p });
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
