import type { ServerResponse } from 'node:http';
import type { AutomationView, RunView } from '../automation.js';

/**
 * The orchestrator's automation routes on /api/cli/v1 (backend
 * routes/cliAutomations.ts), over a list of automations. A box credential
 * sees only the automations on box i1, as the real scope does. `refuse`
 * answers the next mutating call with an error, as a handler would. A
 * space's folder is fixed as routes/automations.ts fixes it,
 * `.termag/automations/<automation id>`, written when a space is attached.
 */
export interface FakeAutomationsState {
  automations: AutomationView[];
  runs: Map<string, RunView[]>;
  calls: Array<{ route: string; body: Record<string, unknown> }>;
  refuse: { status: number; error: string; code?: string } | null;
  /** The minimum interval the preview reports, in minutes. */
  minIntervalMinutes: number;
}

export function run(id: string, extra: Partial<RunView> = {}): RunView {
  return {
    id, trigger: 'schedule', scheduledFor: '2026-10-27T12:00:00.000Z', state: 'done', reason: null, reasonLabel: null,
    workstream: `run-${id}`, summary: 'triaged 3 issues', branch: null, prUrl: null, changesLabel: 'no changes',
    startedAt: '2026-10-27T12:00:05.000Z', finishedAt: '2026-10-27T12:04:05.000Z', durationSec: 240, ...extra,
  };
}

export function automation(id: string, extra: Partial<AutomationView> = {}): AutomationView {
  return {
    id, projectId: `p-${id}`, projectName: id, instanceId: 'i1', repoUrl: 'https://github.com/example/repo',
    schedule: '0 * * * *', timezone: 'UTC', prompt: 'Triage new issues.\nBe brief.', tier: 'full', enabled: true,
    prOnChange: true, wakeBox: false, maxRunMinutes: 60, pausedReason: null, nextRunAt: '2026-10-27T13:00:00.000Z',
    next: ['2026-10-27T13:00:00.000Z', '2026-10-27T14:00:00.000Z', '2026-10-27T15:00:00.000Z'], lastRun: null, owner: true,
    spaceName: null, spaceFolder: null,
    ...extra,
  };
}

export function newAutomationsState(): FakeAutomationsState {
  return {
    automations: [automation('nightly'), automation('elsewhere', { instanceId: 'i2' })],
    runs: new Map([['nightly', [run('r2', { state: 'running', finishedAt: null, summary: null, changesLabel: null }), run('r1', { prUrl: 'https://github.com/example/repo/pull/7' })]]]),
    calls: [],
    refuse: null,
    minIntervalMinutes: 15,
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

const fixedFolder = (id: string) => `.termag/automations/${id}`;

/** The smallest gap of the few cron shapes the tests use: `*\/N` minutes, else an hour. */
function gapOf(schedule: string): number {
  const m = /^\*\/(\d+) /.exec(schedule);
  return m ? Number(m[1]) : 60;
}

export function handleAutomations(s: FakeAutomationsState, route: string, body: Record<string, unknown>, isBox: boolean, res: ServerResponse): boolean {
  const [method, path] = route.split(' ');
  const visible = () => s.automations.filter(a => !isBox || a.instanceId === 'i1');
  const find = (id: string) => visible().find(a => a.id === id || a.projectId === id) ?? null;
  const refused = () => {
    if (!s.refuse) return false;
    send(res, s.refuse.status, s.refuse);
    s.refuse = null;
    return true;
  };
  let m: RegExpMatchArray | null;

  if (route === 'GET /automations') { send(res, 200, visible()); return true; }
  if (route === 'POST /automations/preview') {
    s.calls.push({ route, body });
    const schedule = String(body.schedule);
    const gap = gapOf(schedule);
    send(res, 200, {
      normalised: schedule, timezone: body.timezone, minGapMinutes: gap,
      next: ['2026-10-27T12:15:00.000Z', '2026-10-27T12:30:00.000Z', '2026-10-27T12:45:00.000Z'],
      tooFrequent: gap < s.minIntervalMinutes ? s.minIntervalMinutes : null, keepsBoxUpMinutesPerDay: null,
    });
    return true;
  }
  if (route === 'POST /automations') {
    s.calls.push({ route, body });
    if (refused()) return true;
    const spaceName = typeof body.spaceName === 'string' ? body.spaceName : null;
    const spaceFolder = spaceName ? fixedFolder(String(body.name)) : null;
    const a = automation(String(body.name), {
      instanceId: String(body.instanceId), schedule: String(body.schedule), timezone: String(body.timezone),
      prompt: String(body.prompt), enabled: body.enabled !== false, tier: (body.tier as string) ?? 'full',
      spaceName, spaceFolder,
    });
    s.automations.push(a);
    send(res, 201, { project: { id: a.projectId, name: a.projectName }, automation: a, next: a.next });
    return true;
  }
  if ((m = path.match(/^\/automations\/([^/]+)$/))) {
    const a = find(decodeURIComponent(m[1]));
    if (method === 'GET') {
      if (!a) { send(res, 404, { error: 'Automation not found', code: 'not_found' }); return true; }
      send(res, 200, { ...a, runs: s.runs.get(a.id) ?? [] });
      return true;
    }
    s.calls.push({ route, body });
    if (!a) { send(res, 404, { error: 'Automation not found', code: 'not_found' }); return true; }
    if (refused()) return true;
    if (method === 'PATCH') {
      const { spaceName: askedSpace, ...rest } = body as { spaceName?: string | null };
      const nextSpace = askedSpace !== undefined ? askedSpace : a.spaceName ?? null;
      const nextFolder = !nextSpace ? null : nextSpace !== a.spaceName ? fixedFolder(a.id) : a.spaceFolder ?? fixedFolder(a.id);
      Object.assign(a, rest, { pausedReason: null, spaceName: nextSpace, spaceFolder: nextFolder });
      a.next = a.enabled ? a.next.length ? a.next : ['2026-10-27T13:00:00.000Z'] : [];
      send(res, 200, a);
      return true;
    }
    if (method === 'DELETE') {
      s.automations = s.automations.filter(x => x !== a);
      send(res, 200, { ok: true });
      return true;
    }
  }
  if (method === 'POST' && (m = path.match(/^\/automations\/([^/]+)\/run$/))) {
    s.calls.push({ route, body });
    const a = find(decodeURIComponent(m[1]));
    if (!a) { send(res, 404, { error: 'Automation not found', code: 'not_found' }); return true; }
    if (refused()) return true;
    const r = run('r3', { trigger: 'manual', state: 'running', workstream: 'run-20261027-1200-manual', finishedAt: null, summary: null, changesLabel: null, durationSec: 0 });
    s.runs.set(a.id, [r, ...(s.runs.get(a.id) ?? [])]);
    send(res, 202, { run: r, decision: { kind: 'start' } });
    return true;
  }
  if (method === 'POST' && (m = path.match(/^\/automations\/([^/]+)\/runs\/([^/]+)\/stop$/))) {
    s.calls.push({ route, body });
    const a = find(decodeURIComponent(m[1]));
    if (!a) { send(res, 404, { error: 'Automation not found', code: 'not_found' }); return true; }
    const r = (s.runs.get(a.id) ?? []).find(x => x.id === decodeURIComponent(m![2]));
    if (!r) { send(res, 404, { error: 'Run not found', code: 'not_found' }); return true; }
    if (r.state !== 'running') { send(res, 409, { error: 'This run is not live', code: 'conflict' }); return true; }
    Object.assign(r, { state: 'failed', reason: 'interrupted', reasonLabel: 'stopped by its owner' });
    send(res, 200, { ok: true });
    return true;
  }
  // An automation's name is its project's (the lifecycle route renames it).
  if (method === 'POST' && (m = path.match(/^\/projects\/([^/]+)\/rename$/))) {
    const a = s.automations.find(x => x.projectId === decodeURIComponent(m![1]));
    if (!a) return false;
    s.calls.push({ route, body });
    a.projectName = String(body.name);
    send(res, 200, { project: { id: a.projectId, name: a.projectName } });
    return true;
  }
  return false;
}
