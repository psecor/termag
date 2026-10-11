import { sessionName } from './sessionName.js';
import { STATUS_PRIORITY } from './status.js';
import type { AgentStatusValue, Project, Role, SessionRow, Workstream } from './types.js';

/**
 * GET /api/sessions rows keyed by `projectId/workstream/role` — NOT by tmux
 * session name. Session names are `<owner>-<project>[-<ws>]-<role>` with no box
 * component, so a project that exists on two boxes (a `sysadmin` everywhere)
 * yields two rows with the same name; keying by name would silently drop one
 * and corrupt both the per-project status and the local-box inference.
 */
export type SessionMap = Record<string, SessionRow>;

export function sessionKey(projectId: string, workstream: string, role: Role): string {
  return `${projectId}/${workstream}/${role}`;
}

export function indexSessions(rows: SessionRow[]): SessionMap {
  const map: SessionMap = {};
  for (const r of rows) map[sessionKey(r.projectId, r.workstream, r.role)] = r;
  return map;
}

export function sessionFor(map: SessionMap, project: Project, workstream: string, role: Role): SessionRow | undefined {
  return map[sessionKey(project.id, workstream, role)];
}

export interface Target {
  project: Project;
  workstream: string;
}

export function targetKey(t: Target): string {
  return `${t.project.id}/${t.workstream}`;
}

export function ownerOf(p: Project, fallback = ''): string {
  return p.ownerUsername ?? fallback;
}

export function targetSession(t: Target, role: Role, fallbackOwner = ''): string {
  return sessionName(ownerOf(t.project, fallbackOwner), t.project.name, role, t.workstream);
}

export function hasAgentWorkflow(p: Project): boolean {
  return p.workflows.some(w => w.type === 'agent');
}

export function liveWorkstreams(p: Project): Workstream[] {
  return p.workstreams.filter(w => !w.archived);
}

export function workstreamStatus(p: Project, ws: string, map: SessionMap): AgentStatusValue {
  return sessionFor(map, p, ws, 'agent')?.status ?? 'not_running';
}

/**
 * Highest-priority status across a project's workstream agent sessions
 * (working > waiting > idle > not_running), or null when the project has no
 * agent workflow at all. Same rule as ProjectControl.aggregateStatus.
 */
export function aggregateStatus(p: Project, map: SessionMap): AgentStatusValue | null {
  if (!hasAgentWorkflow(p)) return null;
  let best: AgentStatusValue = 'not_running';
  for (const ws of liveWorkstreams(p)) {
    const cur = workstreamStatus(p, ws.name, map);
    if (STATUS_PRIORITY[cur] > STATUS_PRIORITY[best]) best = cur;
  }
  return best;
}

export interface ProjectBadges {
  contextTokens: number | null;   // max across workstreams
  rateLimited: boolean;
  provider: string | null;        // live provider from any workstream session, else saved workflow provider
}

export function projectBadges(p: Project, map: SessionMap): ProjectBadges {
  let contextTokens: number | null = null;
  let rateLimited = false;
  let provider: string | null = null;
  for (const ws of liveWorkstreams(p)) {
    const s = sessionFor(map, p, ws.name, 'agent');
    if (!s) continue;
    if (s.contextTokens != null && (contextTokens == null || s.contextTokens > contextTokens)) contextTokens = s.contextTokens;
    if (s.rateLimited) rateLimited = true;
    if (s.provider && !provider) provider = s.provider;
  }
  if (!provider) provider = p.workflows.find(w => w.type === 'agent')?.provider ?? null;
  return { contextTokens, rateLimited, provider };
}

// ── rows ───────────────────────────────────────────────────────────────────

export type Row =
  | { kind: 'group'; id: string; label: string; count: number }
  | { kind: 'project'; project: Project; target: Target; status: AgentStatusValue | null; badges: ProjectBadges; local: boolean; workstreamCount: number }
  | { kind: 'workstream'; project: Project; target: Target; workstream: Workstream; status: AgentStatusValue | null; local: boolean };

export interface BuildOptions {
  filter?: string;
  /** Session names present on this host's tmux server. */
  localSessions?: Set<string>;
  /** The logged-in unix user, used when a project row lacks ownerUsername. */
  me?: string;
}

function matchesFilter(p: Project, filter: string): boolean {
  if (!filter) return true;
  const f = filter.toLowerCase();
  if (p.name.toLowerCase().includes(f)) return true;
  if ((p.ownerUsername ?? '').toLowerCase().includes(f)) return true;
  return liveWorkstreams(p).some(w => w.name.toLowerCase().includes(f));
}

function pinnedFirst(list: Project[]): Project[] {
  // Backend order is already pinned desc, name asc; a stable sort keeps it
  // while making pins float within our own groups.
  return [...list].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
}

/**
 * Which instance is "this host"? tmux session names carry owner + project, not
 * box, so the same project name on two boxes (a `sysadmin` on every box, say)
 * collides. Score each instance by how many of its alive sessions exist on the
 * local tmux server and take the best; `undefined` means no evidence.
 * `null` is a legitimate answer: the orchestrator itself hosts instanceId-null
 * projects.
 */
export function inferLocalInstance(rows: Iterable<SessionRow>, local: Set<string>): string | null | undefined {
  if (!local.size) return undefined;
  const score = new Map<string | null, { matched: number; alive: number }>();
  for (const r of rows) {
    if (!r.alive) continue;
    const s = score.get(r.instanceId) ?? { matched: 0, alive: 0 };
    s.alive++;
    if (local.has(r.session)) s.matched++;
    score.set(r.instanceId, s);
  }
  let best: { id: string | null; matched: number; ratio: number } | null = null;
  for (const [id, s] of score) {
    if (!s.matched) continue;
    const ratio = s.matched / s.alive;
    if (!best || s.matched > best.matched || (s.matched === best.matched && ratio > best.ratio)) best = { id, matched: s.matched, ratio };
  }
  return best ? best.id : undefined;
}

function isLocalProject(p: Project, local: Set<string>, me: string, localInstance: string | null | undefined): boolean {
  if (!local.size || localInstance === undefined) return false;
  if ((p.instanceId ?? null) !== localInstance) return false;
  const owner = ownerOf(p, me);
  return liveWorkstreams(p).some(ws =>
    local.has(sessionName(owner, p.name, 'agent', ws.name)) || local.has(sessionName(owner, p.name, 'ctrl', ws.name)));
}

function shortId(id: string): string {
  return id.length > 6 ? `…${id.slice(-6)}` : id;
}

/**
 * Flatten projects into the lobby's rows, mirroring ProjectControl's grouping:
 * MetaTerm first, then one group per box, then "Shared with me", then
 * "This host"; pinned first inside each group. Workstream sub-rows appear only
 * for projects with more than one live workstream (the web's rule).
 *
 * Box names need GET /api/instances, which is cookie-only, so groups are
 * labelled by instance id. A box whose sessions exist on this host's tmux
 * server is labelled "this box".
 */
export function buildRows(projects: Project[], map: SessionMap, opts: BuildOptions = {}): Row[] {
  const filter = opts.filter ?? '';
  const local = opts.localSessions ?? new Set<string>();
  const me = opts.me ?? '';
  const localInstance = inferLocalInstance(Object.values(map), local);
  const visible = projects.filter(p => !p.archived && matchesFilter(p, filter));

  // Web rule (ProjectControl): "Shared with me" = projects on a box I do not
  // own. Boxes I own are inferred from my own projects, since GET /api/instances
  // is cookie-only. A collaborator project on the orchestrator (instanceId null)
  // therefore lands in the host group, as it does on the web.
  const ownedBoxes = new Set(projects.filter(p => p.role !== 'collaborator' && p.instanceId).map(p => p.instanceId as string));
  const meta: Project[] = [];
  const byBox = new Map<string, Project[]>();
  const shared: Project[] = [];
  const host: Project[] = [];
  for (const p of visible) {
    if (p.kind === 'metaterm') meta.push(p);
    else if (p.role === 'collaborator' && p.instanceId && !ownedBoxes.has(p.instanceId)) shared.push(p);
    else if (p.instanceId) {
      const list = byBox.get(p.instanceId) ?? [];
      list.push(p);
      byBox.set(p.instanceId, list);
    } else host.push(p);
  }

  const rows: Row[] = [];
  const pushProject = (p: Project) => {
    const isLocal = isLocalProject(p, local, me, localInstance);
    const wss = liveWorkstreams(p);
    const mainTarget: Target = { project: p, workstream: wss.find(w => w.name === 'main')?.name ?? wss[0]?.name ?? 'main' };
    rows.push({
      kind: 'project', project: p, target: mainTarget,
      status: aggregateStatus(p, map), badges: projectBadges(p, map),
      local: isLocal, workstreamCount: wss.length,
    });
    if (wss.length > 1) {
      for (const ws of wss) {
        rows.push({
          kind: 'workstream', project: p, workstream: ws, target: { project: p, workstream: ws.name },
          status: hasAgentWorkflow(p) ? workstreamStatus(p, ws.name, map) : null,
          local: isLocal,
        });
      }
    }
  };

  for (const p of meta) pushProject(p);

  const boxes = [...byBox.entries()].map(([id, list]) => {
    const isLocal = localInstance === id;
    return { id, list, isLocal, label: isLocal ? `this box ${shortId(id)}` : `box ${shortId(id)}` };
  }).sort((a, b) => Number(b.isLocal) - Number(a.isLocal) || a.id.localeCompare(b.id));
  for (const box of boxes) {
    rows.push({ kind: 'group', id: `box:${box.id}`, label: box.label, count: box.list.length });
    for (const p of pinnedFirst(box.list)) pushProject(p);
  }
  if (shared.length) {
    rows.push({ kind: 'group', id: 'shared', label: 'shared with me', count: shared.length });
    for (const p of pinnedFirst(shared)) pushProject(p);
  }
  if (host.length) {
    const isLocal = localInstance === null;
    rows.push({ kind: 'group', id: 'host', label: isLocal ? 'this host (orchestrator)' : 'orchestrator host', count: host.length });
    for (const p of pinnedFirst(host)) pushProject(p);
  }
  return rows;
}

export function isSelectable(r: Row): r is Extract<Row, { kind: 'project' | 'workstream' }> {
  return r.kind !== 'group';
}

export interface Selection {
  projectId: string;
  workstream: string;
  /** Which row was highlighted; a multi-workstream project has both a project row and a `main` sub-row for the same target. */
  kind?: 'project' | 'workstream';
}

/**
 * Index in `rows` of the row for a selection. With `kind: 'project'` the project
 * row wins; otherwise the matching workstream sub-row wins and the project row
 * is the fallback (e.g. after the workstream was deleted).
 */
export function findRowIndex(rows: Row[], t: Selection | null): number {
  if (!t) return -1;
  let projectRow = -1;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!isSelectable(r) || r.project.id !== t.projectId) continue;
    if (r.kind === 'project') {
      if (t.kind === 'project') return i;
      if (r.target.workstream === t.workstream && r.workstreamCount <= 1) return i;
      if (projectRow < 0) projectRow = i;
      continue;
    }
    if (t.kind !== 'project' && r.workstream.name === t.workstream) return i;
  }
  return projectRow;
}

export function selectionOf(r: Extract<Row, { kind: 'project' | 'workstream' }>): Selection {
  return { projectId: r.project.id, workstream: r.target.workstream, kind: r.kind };
}

// ── transitions (flash + bell) ─────────────────────────────────────────────

export const FLASH_MS = 15_000;
/** Changes in the first seconds after mount are load, not activity. */
export const FLASH_GRACE_MS = 3_000;

export interface FlashState {
  prev: Record<string, AgentStatusValue | null>;
  flashUntil: Record<string, { status: AgentStatusValue; until: number }>;
}

export interface FlashUpdate {
  next: FlashState;
  /** Targets that just entered `waiting` (and deserve a bell). */
  nowWaiting: string[];
}

/**
 * Compare the previous and current per-row statuses. A change starts a 15s
 * flash on that key; entering `waiting` is reported so the UI can ring.
 */
export function updateFlashes(state: FlashState, current: Record<string, AgentStatusValue | null>, now: number, mountedAt: number): FlashUpdate {
  const flashUntil: FlashState['flashUntil'] = {};
  for (const [k, f] of Object.entries(state.flashUntil)) if (f.until > now) flashUntil[k] = f;
  const nowWaiting: string[] = [];
  const inGrace = now - mountedAt < FLASH_GRACE_MS;
  for (const [key, status] of Object.entries(current)) {
    const prev = state.prev[key];
    if (prev === undefined || prev === status || inGrace || status === null) continue;
    flashUntil[key] = { status, until: now + FLASH_MS };
    if (status === 'waiting') nowWaiting.push(key);
  }
  return { next: { prev: current, flashUntil }, nowWaiting };
}

export function rowStatusKey(r: Row): string | null {
  if (r.kind === 'group') return null;
  return targetKey(r.target) + (r.kind === 'project' ? '#p' : '#w');
}

/** Rows that are `waiting`, in list order — for the "next waiting" jump. */
export function waitingIndices(rows: Row[]): number[] {
  const out: number[] = [];
  rows.forEach((r, i) => {
    if (r.kind === 'project' && r.status === 'waiting' && r.workstreamCount <= 1) out.push(i);
    if (r.kind === 'workstream' && r.status === 'waiting') out.push(i);
  });
  return out;
}

export function nextIndex(indices: number[], from: number, dir: 1 | -1): number | null {
  if (!indices.length) return null;
  if (dir === 1) return indices.find(i => i > from) ?? indices[0];
  const before = indices.filter(i => i < from);
  return before.length ? before[before.length - 1] : indices[indices.length - 1];
}
