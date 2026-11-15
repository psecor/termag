// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoftwareCellPolicy, SoftwareHost, SoftwareMatrix, SoftwareState, SoftwareUpdateRun, ToolUpdatePreview, UpdatableTool } from '../../services/adminApi';

const mocks = vi.hoisted(() => ({
  software: vi.fn(), clientVersions: vi.fn(), softwareHost: vi.fn(), refreshSoftware: vi.fn(),
  toolUpdatePreview: vi.fn(), softwareUpdates: vi.fn(), updateTool: vi.fn(), updateToolFleet: vi.fn(),
}));
vi.mock('../../services/adminApi', () => ({ adminApi: mocks }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { AdminSoftware } = await import('./AdminSoftware');

const counts = (over: Partial<Record<SoftwareState, number>>): Record<SoftwareState, number> => ({ current: 0, 'below-floor': 0, held: 0, behind: 0, outdated: 0, ahead: 0, pending: 0, missing: 0, unknown: 0, ...over });
const cell = (version: string, state: SoftwareState) => ({ version, raw: version, path: null, state, observedAt: '2026-10-30T10:00:00Z' });
// Made-up hosts and owners.
const box = (hostKey: string, name: string, owner: string, claude: string, codex: string): SoftwareHost => ({
  hostKey, kind: 'box', name, owner, boxKind: 'ec2', status: 'ready', connected: true, lastInventoryAt: '2026-10-30T10:00:00Z',
  // `fleet`: what the backend's selectFleet takes per scope, here every box not on the newest version.
  cells: {
    claude: { ...cell(claude, claude === '2.1.314' ? 'current' : 'behind'), fleet: { 'below-floor': false, behind: claude !== '2.1.314' } },
    codex: { ...cell(codex, codex === '0.165.0' ? 'current' : 'outdated'), fleet: { 'below-floor': false, behind: codex !== '0.165.0' } },
  },
});
const matrix: SoftwareMatrix = {
  components: ['claude', 'codex'],
  summary: [
    { component: 'claude', reference: '2.1.314', referenceNote: '', counts: counts({ current: 1, behind: 1 }), spread: [] },
    { component: 'codex', reference: '0.165.0', referenceNote: '', counts: counts({ current: 1, outdated: 1 }), spread: [] },
  ],
  hosts: [box('i-0aaa', 'otter-box', 'river', '2.1.312', '0.163.0'), box('i-0bbb', 'heron-box', 'marsh', '2.1.314', '0.165.0')],
  targets: { boxCommit: null, orchestratorImageCommit: null, runningCommit: null },
  collector: { lastSweepAt: null, lastSelfAt: null, lastError: null },
  generatedAt: '2026-10-30T10:00:00Z',
};
const preview = (c: UpdatableTool, hostKey: string): ToolUpdatePreview => ({
  hostKey, connected: true, capable: true, current: c === 'claude' ? '2.1.312' : c === 'codex' ? '0.163.0' : '2026.10.01-0a1b2c3', target: 'latest', floor: c === 'claude' ? '2.1.308' : c === 'codex' ? '0.131.0' : '2025.09.17-25b418f',
  liveSessions: 1, busySessions: 0, runInFlight: false,
});
const off = () => Promise.reject(Object.assign(new Error('off'), { response: { status: 404, data: { code: 'claude_update_off' } } }));

let root: Root;
let el: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0); });
const buttons = (label: string | RegExp) => [...el.querySelectorAll('button')].filter(b => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')));
const followed = () => el.querySelector('[data-testid="followed-run"]')?.textContent ?? null;
const headers = () => [...el.querySelectorAll('th')].map(th => th.textContent);

function serve(codexOn: boolean, cursorOn = false, devinOn = false, piOn = false, ghOn = false, awsOn = false, nodeOn = false, pythonOn = false, dockerOn = false) {
  const on = (c: UpdatableTool) => c === 'claude' || (c === 'codex' && codexOn) || (c === 'cursor' && cursorOn) || (c === 'devin' && devinOn) || (c === 'pi' && piOn) || (c === 'gh' && ghOn) || (c === 'aws' && awsOn) || (c === 'node' && nodeOn) || (c === 'python' && pythonOn) || (c === 'docker' && dockerOn);
  mocks.software.mockResolvedValue(matrix);
  mocks.clientVersions.mockResolvedValue({ clients: [], runningCommit: null });
  mocks.softwareHost.mockImplementation(async (hostKey: string) => ({ host: matrix.hosts.find(h => h.hostKey === hostKey), changes: [] }));
  mocks.toolUpdatePreview.mockImplementation((c: UpdatableTool, hostKey: string) => (!on(c) ? off() : Promise.resolve(preview(c, hostKey))));
  mocks.softwareUpdates.mockImplementation((c: UpdatableTool) => (!on(c) ? off() : Promise.resolve({ runs: [] })));
  mocks.updateTool.mockResolvedValue({ runId: 'cmvtrun0000000000000000002', acknowledged: true });
}

async function openHost(name: string) {
  await act(async () => { buttons(name)[0].click(); });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const m of Object.values(mocks)) m.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the Software tab, per tool', () => {
  it('mounts every tool UPDATE_TOOLS lists: Docker\'s button queues a run for the box\'s next start (Bugbot on #1305)', async () => {
    serve(false, false, false, false, false, false, false, false, true);
    mocks.toolUpdatePreview.mockImplementation((c: UpdatableTool, hostKey: string) => (c === 'claude' || c === 'docker'
      ? Promise.resolve({ ...preview(c, hostKey), ...(c === 'docker' ? { current: '29.8.1', floor: '29.9.3', atStart: true } : {}) })
      : off()));
    mocks.updateTool.mockResolvedValue({ runId: 'cmvtrun0000000000000000009', acknowledged: false, atStart: true });
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-30T11:00:00Z')} />));
    await flush();
    expect(el.textContent).toContain('Recent Docker updates');
    await openHost('otter-box');
    expect(buttons('Update Docker at next start')).toHaveLength(1);
    await act(async () => { buttons('Update Docker at next start')[0].click(); });
    await flush();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Queue a Docker update for otter-box’s next start?'));
    expect(mocks.updateTool).toHaveBeenCalledWith('docker', 'i-0aaa', 'none');
    expect(followed()).toContain('queued: installs at the box’s next start');
  });

  it('counts the fleet against a box\'s policy, never the orchestrator host\'s pin (Bugbot on #1165)', async () => {
    serve(true);
    const orch: SoftwareHost = { ...box('orchestrator', 'orchestrator', '', '2.1.308', '0.163.0'), kind: 'orchestrator', owner: null };
    mocks.software.mockResolvedValue({ ...matrix, hosts: [orch, ...matrix.hosts] });
    mocks.softwareHost.mockImplementation(async (hostKey: string) => ({ host: hostKey === 'orchestrator' ? orch : matrix.hosts.find(h => h.hostKey === hostKey), changes: [] }));
    mocks.toolUpdatePreview.mockImplementation((c: UpdatableTool, hostKey: string) => Promise.resolve(hostKey === 'orchestrator'
      ? { ...preview(c, hostKey), kind: 'orchestrator', current: '2.1.308', target: '2.1.320', floorOnly: false, nothingToDo: false }
      : preview(c, hostKey)));
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-30T11:00:00Z')} />));
    await flush();
    const before = buttons(/^Update behind \(/)[0].textContent;
    await openHost('orchestrator');
    // The pin 2.1.320 would count both boxes as behind; the count is the backend's selection, which the orchestrator's preview doesn't move.
    expect(buttons(/^Update behind \(/)[0].textContent).toBe(before);
    expect(before).toBe('Update behind (1)');
  });


  it('offers Codex the same actions as Claude Code while its update is on', async () => {
    serve(true);
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-30T11:00:00Z')} />));
    await flush();
    // One fleet button on each tool's summary row; no last-update columns (a cell's badges and hover have the run).
    expect(buttons(/^Update behind \(/)).toHaveLength(2);
    expect(headers().some(h => /^last .*update$/.test(h ?? ''))).toBe(false);
    expect(el.textContent).toContain('Recent Claude Code updates');
    expect(el.textContent).toContain('Recent Codex updates');
    expect([...new Set(mocks.softwareUpdates.mock.calls.map(c => c[0]))].sort()).toEqual(['aws', 'claude', 'codex', 'cursor', 'devin', 'docker', 'gh', 'node', 'pi', 'python']);

    await openHost('otter-box');
    expect(buttons('Update Claude Code')).toHaveLength(1);
    expect(buttons('Update Codex')).toHaveLength(1);
    await act(async () => { buttons('Update Codex')[0].click(); });
    await flush();
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Update Codex on otter-box?'));
    expect(mocks.updateTool).toHaveBeenCalledWith('codex', 'i-0aaa', 'idle');
    expect(followed()).toBe('updating… (run cmvtrun0000000000000000002)');
  });

  it('opens Codex\'s fleet choices from its own row, and asks for Codex', async () => {
    serve(true);
    mocks.updateToolFleet.mockResolvedValue({ runs: [{ hostKey: 'i-0aaa', runId: 'r' }], skipped: [] });
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-30T11:00:00Z')} />));
    await flush();
    // The rows are in the matrix's component order: Claude Code's first, then Codex's.
    await act(async () => { buttons(/^Update behind \(/)[1].click(); });
    expect(el.textContent).toContain('Update Codex on hosts');
    expect(el.textContent).not.toContain('Update Claude Code on hosts');
    await act(async () => { buttons(/^update \d+…$|^update…$/)[0].click(); });
    await flush();
    expect(mocks.updateToolFleet).toHaveBeenCalledWith('codex', 'behind', 'idle');
    expect(el.textContent).toContain('Codex: 1 run requested');
  });

  it('hides every Codex action while Codex\'s update is off, and leaves Claude Code\'s as they are', async () => {
    serve(false);
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-30T11:00:00Z')} />));
    await flush();
    expect(buttons(/^Update behind \(/)).toHaveLength(1);
    expect(headers().some(h => /^last .*update$/.test(h ?? ''))).toBe(false);
    expect(el.textContent).toContain('Recent Claude Code updates');
    expect(el.textContent).not.toContain('Recent Codex updates');
    await openHost('otter-box');
    expect(buttons('Update Claude Code')).toHaveLength(1);
    expect(buttons('Update Codex')).toHaveLength(0);
    expect(el.querySelector('.admin-error')).toBe(null);
  });

  it('counts every tool\'s "Update behind (N)" over online hosts while "exclude offline hosts" is on, and over all once it is off', async () => {
    serve(true);
    const offline = { ...box('i-0ccc', 'stoat-box', 'moor', '2.1.300', '0.162.0'), connected: false };
    mocks.software.mockResolvedValue({ ...matrix, hosts: [...matrix.hosts, offline], online: { summary: matrix.summary, offline: 1 } });
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-30T11:00:00Z')} />));
    await flush();
    // Online: otter-box is behind on Claude Code and outdated on Codex; stoat-box is offline.
    expect(buttons(/^Update behind \(/).map(b => b.textContent)).toEqual(['Update behind (1)', 'Update behind (1)']);
    const toggle = [...el.querySelectorAll('label')].find(l => l.textContent?.includes('exclude offline hosts'))!.querySelector('input')!;
    await act(async () => { toggle.click(); });
    await flush();
    expect(buttons(/^Update behind \(/).map(b => b.textContent)).toEqual(['Update behind (2)', 'Update behind (2)']);
  });

  it('offers the Cursor agent its own row, column and button while its update is on', async () => {
    serve(false, true);
    const withCursor = {
      ...matrix,
      components: [...matrix.components, 'cursor-agent'],
      summary: [...matrix.summary, { component: 'cursor-agent', reference: '2026.10.22-27dcf5f', referenceNote: '', counts: counts({ current: 1, behind: 1 }), spread: [] }],
      hosts: matrix.hosts.map((h, i) => ({ ...h, cells: { ...h.cells, 'cursor-agent': cell(i === 0 ? '2026.10.01-0a1b2c3' : '2026.10.22-27dcf5f', i === 0 ? 'behind' : 'current') } })),
    };
    mocks.software.mockResolvedValue(withCursor);
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-30T11:00:00Z')} />));
    await flush();
    expect(buttons(/^Update behind \(/)).toHaveLength(2);
    expect(el.textContent).toContain('Recent Cursor agent updates');
    await openHost('otter-box');
    await act(async () => { buttons('Update Cursor agent')[0].click(); });
    await flush();
    expect(mocks.updateTool).toHaveBeenCalledWith('cursor', 'i-0aaa', 'idle');
  });

  it('offers the Devin CLI its own row, column and button while its update is on', async () => {
    serve(false, false, true);
    const withDevin = {
      ...matrix,
      components: [...matrix.components, 'devin'],
      summary: [...matrix.summary, { component: 'devin', reference: '3000.11.234', referenceNote: '', counts: counts({ current: 1, behind: 1 }), spread: [] }],
      hosts: matrix.hosts.map((h, i) => ({ ...h, cells: { ...h.cells, 'devin': cell(i === 0 ? '3000.11.92' : '3000.11.234', i === 0 ? 'behind' : 'current') } })),
    };
    mocks.software.mockResolvedValue(withDevin);
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-30T11:00:00Z')} />));
    await flush();
    expect(buttons(/^Update behind \(/)).toHaveLength(2);
    expect(el.textContent).toContain('Recent Devin CLI updates');
    await openHost('otter-box');
    await act(async () => { buttons('Update Devin CLI')[0].click(); });
    await flush();
    expect(mocks.updateTool).toHaveBeenCalledWith('devin', 'i-0aaa', 'idle');
  });

  it('offers pi its own row, column and button while its update is on', async () => {
    serve(false, false, false, true);
    const withPi = {
      ...matrix,
      components: [...matrix.components, 'pi'],
      summary: [...matrix.summary, { component: 'pi', reference: '1.4.0', referenceNote: '', counts: counts({ current: 1, behind: 1 }), spread: [] }],
      hosts: matrix.hosts.map((h, i) => ({ ...h, cells: { ...h.cells, 'pi': cell(i === 0 ? '1.0.2' : '1.4.0', i === 0 ? 'outdated' : 'current') } })),
    };
    mocks.software.mockResolvedValue(withPi);
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-30T11:00:00Z')} />));
    await flush();
    expect(buttons(/^Update behind \(/)).toHaveLength(2);
    expect(el.textContent).toContain('Recent pi updates');
    await openHost('otter-box');
    await act(async () => { buttons('Update pi')[0].click(); });
    await flush();
    expect(mocks.updateTool).toHaveBeenCalledWith('pi', 'i-0aaa', 'idle');
  });

  it('offers the GitHub CLI its own row and button while its update is on, with binary only as its restart', async () => {
    serve(false, false, false, false, true);
    const withGh = {
      ...matrix,
      components: [...matrix.components, 'gh'],
      summary: [...matrix.summary, { component: 'gh', reference: '2.103.3', referenceNote: '', counts: counts({ current: 1, outdated: 1 }), spread: [] }],
      hosts: matrix.hosts.map((h, i) => ({ ...h, cells: { ...h.cells, 'gh': cell(i === 0 ? '2.96.0' : '2.103.3', i === 0 ? 'outdated' : 'current') } })),
    };
    mocks.software.mockResolvedValue(withGh);
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-30T11:00:00Z')} />));
    await flush();
    expect(buttons(/^Update behind \(/)).toHaveLength(2);
    expect(el.textContent).toContain('Recent GitHub CLI updates');
    await openHost('otter-box');
    const selects = [...el.querySelectorAll('select[aria-label="restart sessions"]')] as HTMLSelectElement[];
    const ghSelect = selects.find(s => s.options.length === 1);
    expect(ghSelect?.value).toBe('none');
    await act(async () => { buttons('Update GitHub CLI')[0].click(); });
    await flush();
    expect(mocks.updateTool).toHaveBeenCalledWith('gh', 'i-0aaa', 'none');
  });

  it('offers the AWS CLI its own row and button while its update is on, with binary only as its restart', async () => {
    serve(false, false, false, false, false, true);
    const withAws = {
      ...matrix,
      components: [...matrix.components, 'aws'],
      summary: [...matrix.summary, { component: 'aws', reference: '2.39.2', referenceNote: '', counts: counts({ current: 1, outdated: 1 }), spread: [] }],
      hosts: matrix.hosts.map((h, i) => ({ ...h, cells: { ...h.cells, 'aws': cell(i === 0 ? '2.38.5' : '2.39.2', i === 0 ? 'outdated' : 'current') } })),
    };
    mocks.software.mockResolvedValue(withAws);
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-31T11:00:00Z')} />));
    await flush();
    expect(buttons(/^Update behind \(/)).toHaveLength(2);
    expect(el.textContent).toContain('Recent AWS CLI updates');
    await openHost('otter-box');
    await act(async () => { buttons('Update AWS CLI')[0].click(); });
    await flush();
    expect(mocks.updateTool).toHaveBeenCalledWith('aws', 'i-0aaa', 'none');
  });

  it('offers Node its own row and button while its update is on, starting at binary only', async () => {
    serve(false, false, false, false, false, false, true);
    const withNode = {
      ...matrix,
      components: [...matrix.components, 'node'],
      summary: [...matrix.summary, { component: 'node', reference: '24.22.2', referenceNote: '', counts: counts({ current: 1, behind: 1 }), spread: [] }],
      hosts: matrix.hosts.map((h, i) => ({ ...h, cells: { ...h.cells, 'node': cell(i === 0 ? '24.22.1' : '24.22.2', i === 0 ? 'behind' : 'current') } })),
    };
    mocks.software.mockResolvedValue(withNode);
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-31T11:00:00Z')} />));
    await flush();
    expect(el.textContent).toContain('Recent Node updates');
    await openHost('otter-box');
    await act(async () => { buttons('Update Node')[0].click(); });
    await flush();
    expect(mocks.updateTool).toHaveBeenCalledWith('node', 'i-0aaa', 'none');
  });

  it('offers Python its own row and button while its update is on, binary only', async () => {
    serve(false, false, false, false, false, false, false, true);
    const withPython = {
      ...matrix,
      components: [...matrix.components, 'python'],
      summary: [...matrix.summary, { component: 'python', reference: '3.13.18', referenceNote: '', counts: counts({ current: 1, behind: 1 }), spread: [] }],
      hosts: matrix.hosts.map((h, i) => ({ ...h, cells: { ...h.cells, 'python': cell(i === 0 ? '3.13.16' : '3.13.18', i === 0 ? 'behind' : 'current') } })),
    };
    mocks.software.mockResolvedValue(withPython);
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-31T11:00:00Z')} />));
    await flush();
    expect(el.textContent).toContain('Recent Python updates');
    await openHost('otter-box');
    await act(async () => { buttons('Update Python')[0].click(); });
    await flush();
    expect(mocks.updateTool).toHaveBeenCalledWith('python', 'i-0aaa', 'none');
  });
});

describe('the Software tab, kernels and reboots', () => {
  const kernelBox = (hostKey: string, name: string, kernel: string, kState: SoftwareState, reboot: { version: string; raw: string; state: SoftwareState }): SoftwareHost => ({
    ...box(hostKey, name, 'river', '2.1.314', '0.165.0'),
    cells: {
      kernel: cell(kernel, kState),
      reboot: { version: reboot.version, raw: reboot.raw, path: null, state: reboot.state, observedAt: '2026-11-03T10:00:00Z' },
    },
  });
  const pending = kernelBox('i-0ccc', 'lark-box', '6.8.0-1061-aws', 'behind', { version: 'pending', raw: 'since 2026-10-31T06:10:00Z · kernel 6.8.0-1067-aws installed · packages: linux-base', state: 'pending' });
  const fine = kernelBox('i-0ddd', 'wren-box', '6.8.0-1067-aws', 'current', { version: 'no', raw: 'booted 2026-11-01T08:00:00Z', state: 'current' });
  const km: SoftwareMatrix = {
    ...matrix,
    components: ['kernel', 'reboot'],
    summary: [
      { component: 'kernel', reference: 'box 6.8.0-1067-aws · orchestrator 7.0.0-1014-aws', referenceNote: '', counts: counts({ current: 1, behind: 1 }), spread: [] },
      { component: 'reboot', reference: 'no', referenceNote: '', counts: counts({ current: 1, pending: 1 }), spread: [] },
    ],
    hosts: [pending, fine],
  };

  it('shows a reboot pending column with how long, counts it, and says so in the host panel', async () => {
    serve(false);
    mocks.software.mockResolvedValue(km);
    mocks.softwareHost.mockImplementation(async (hostKey: string) => ({ host: km.hosts.find(h => h.hostKey === hostKey), changes: [] }));
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-11-03T12:10:00Z')} />));
    await flush();
    expect(headers()).toEqual(expect.arrayContaining(['kernel', 'reboot pending']));
    const cells = [...el.querySelectorAll('.admin-sw-matrix .admin-sw--pending')].map(c => c.textContent);
    expect(cells).toEqual(['pending · 3 d']);
    // The by-component table has a reboot pending count, and the header counts the host as needing updates.
    expect(el.textContent).toContain('1 of 2 hosts need updates');
    expect(el.textContent).toContain('box 6.8.0-1067-aws · orchestrator 7.0.0-1014-aws');

    await openHost('lark-box');
    expect(el.textContent).toContain('Reboot pending since 2026-10-31 06:10 UTC (3 d): kernel 6.8.0-1067-aws installed · packages: linux-base.');
    await openHost('wren-box');
    expect(el.textContent).not.toContain('Reboot pending since');
  });
});

describe('the host panel\'s line under "Update <tool>"', () => {
  const RUN = 'cmvtrun0000000000000000002';
  // The Codex run the panel asked for, as the runs list has it at each step.
  const codexRun = (over: Partial<SoftwareUpdateRun>): SoftwareUpdateRun => ({
    id: RUN, hostKey: 'i-0aaa', instanceId: 'i-0aaa', component: 'codex', trigger: 'manual', requestedById: 'u1', restart: 'idle', reason: null,
    status: 'requested', outcome: null, target: 'latest', fromVersion: null, toVersion: null, detail: null, sessions: null,
    requestedAt: '2026-10-30T11:00:00Z', startedAt: null, finishedAt: null, ...over,
  });
  let runs: SoftwareUpdateRun[];
  let current: string;
  const codexCalls = () => mocks.softwareUpdates.mock.calls.filter(c => c[0] === 'codex').length;
  const previewCalls = () => mocks.toolUpdatePreview.mock.calls.filter(c => c[0] === 'codex' && c[1] === 'i-0aaa').length;

  async function requestCodex(acknowledged = true) {
    serve(true);
    runs = []; current = '0.163.0';
    mocks.softwareUpdates.mockImplementation((c: UpdatableTool) => Promise.resolve({ runs: c === 'codex' ? runs : [] }));
    mocks.toolUpdatePreview.mockImplementation((c: UpdatableTool, hostKey: string) => Promise.resolve({ ...preview(c, hostKey), ...(c === 'codex' ? { current } : {}) }));
    mocks.updateTool.mockResolvedValue({ runId: RUN, acknowledged });
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-30T11:00:00Z')} />));
    await flush();
    await openHost('otter-box');
    await act(async () => { buttons('Update Codex')[0].click(); });
    await flush();
  }
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it('goes from updating to updated with the versions, re-reads the runs every few seconds meanwhile, then the preview', async () => {
    await requestCodex();
    expect(followed()).toBe(`updating… (run ${RUN})`);
    // Off while it follows a run, before the preview's runInFlight says so (Bugbot on #1211).
    expect(buttons('Update Codex')[0].disabled).toBe(true);
    runs = [codexRun({ status: 'running', startedAt: '2026-10-30T11:00:02Z' })];
    const before = codexCalls();
    await tick(4000);
    expect(codexCalls()).toBe(before + 1);
    expect(followed()).toBe(`updating… (run ${RUN})`);
    runs = [codexRun({ status: 'done', outcome: 'updated', fromVersion: '0.163.0', toVersion: '0.166.0', finishedAt: '2026-10-30T11:00:09Z', detail: 'policy=ok restart=idle' })];
    current = '0.166.0';
    const previews = previewCalls();
    await tick(4000);
    expect(followed()).toBe(`updated · 0.163.0 → 0.166.0 (run ${RUN})`);
    expect(el.querySelector('[data-testid="followed-run"]')!.className).toBe('admin-ok');
    expect(el.querySelector('[data-testid="followed-run"]')!.getAttribute('title')).toContain('policy=ok restart=idle');
    // The run's end re-reads the panel's preview, so its "current → target" moves without a reload.
    await flush();
    expect(previewCalls()).toBeGreaterThan(previews);
    expect(el.textContent).toContain('0.166.0 → latest');
    expect(buttons('Update Codex')[0].disabled).toBe(false);
    // And the fast poll stops: nothing more until the tab's own minute.
    const ended = codexCalls();
    await tick(20_000);
    expect(codexCalls()).toBe(ended);
  });

  it('says why a run failed, in words, with the raw detail on hover', async () => {
    await requestCodex();
    runs = [codexRun({ status: 'failed', outcome: 'failed', fromVersion: '1.0.2', toVersion: '1.0.2', detail: 'policy=ok npm=1.0.2->FAILED:unpinned:1.5.0' })];
    await tick(4000);
    expect(followed()).toBe(`failed: not pinned (1.5.0) · 1.0.2 (run ${RUN})`);
    const line = el.querySelector('[data-testid="followed-run"]')!;
    expect(line.className).toBe('admin-bad');
    expect(line.getAttribute('title')).toContain('npm=1.0.2->FAILED:unpinned:1.5.0');
  });

  it('says expired for a run the box never fetched', async () => {
    await requestCodex();
    runs = [codexRun({ status: 'requested' })];
    await tick(4000);
    expect(followed()).toBe(`updating… (run ${RUN})`);
    runs = [codexRun({ status: 'expired', finishedAt: '2026-10-30T11:15:00Z', detail: 'the box did not fetch its policy within 15 minutes' })];
    await tick(4000);
    expect(followed()).toBe(`expired · → latest (run ${RUN})`);
    expect(el.querySelector('[data-testid="followed-run"]')!.className).toBe('admin-warn');
  });

  it('follows a run whose acknowledgement was lost the same way', async () => {
    await requestCodex(false);
    expect(followed()).toMatch(/acknowledgement was lost: it may be running \(run /);
    expect(el.querySelector('[data-testid="followed-run"]')!.className).toBe('admin-warn');
    runs = [codexRun({ status: 'done', outcome: 'current', fromVersion: '0.165.0', toVersion: '0.165.0' })];
    await tick(4000);
    expect(followed()).toBe(`current · 0.165.0 (run ${RUN})`);
  });
});

describe('the Software tab, its host table', () => {
  // 40 made-up boxes, every fifth offline, with Claude Code 2.1.0 … 2.1.390.
  const many = Array.from({ length: 40 }, (_, i) => ({
    ...box(`i-${String(i).padStart(4, '0')}`, `box-${String(i + 1).padStart(2, '0')}`, `owner${i % 3}`, `2.1.${i * 10}`, '0.165.0'),
    connected: i % 5 !== 0,
  }));
  const hostNames = () => [...el.querySelectorAll('.admin-sw-matrix tbody tr td:first-child')].map(td => td.querySelector('button')?.textContent);
  const range = () => el.querySelector('.admin-pager-range')?.textContent ?? null;
  const press = (label: string) => act(async () => { (el.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click(); });

  it('pages 25 hosts, sorts a version column, keeps the page through a poll, and goes to page 1 on hide offline', async () => {
    serve(false);
    mocks.software.mockImplementation(async () => ({ ...matrix, hosts: many.map(h => ({ ...h })) }));
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-30T11:00:00Z')} />));
    await flush();
    expect(hostNames()).toHaveLength(25);
    expect(range()).toBe('1–25 of 40');
    // Sort by Claude Code, newest first: 2.1.390 before 2.1.90.
    await act(async () => { ([...el.querySelectorAll('.admin-sw-matrix th')].find(th => th.textContent === 'claude code')! as HTMLElement).click(); });
    expect(hostNames()[0]).toBe('box-40');
    await press('next page');
    expect(range()).toBe('26–40 of 40');
    const page2 = hostNames();
    // The matrix polls every minute: new objects, same hosts; the reader stays where they were.
    const polls = mocks.software.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
    await flush();
    expect(mocks.software.mock.calls.length).toBeGreaterThan(polls);
    expect(range()).toBe('26–40 of 40');
    expect(hostNames()).toEqual(page2);
    // The tab's own filter still works, and starts the table over.
    await act(async () => { [...el.querySelectorAll('label')].find(l => l.textContent?.includes('hide offline hosts'))!.querySelector('input')!.click(); });
    expect(range()).toBe('1–25 of 32');
    expect(el.querySelector('.dash-section-title .dash-count')?.textContent).toBe('32');
  });

  it('filters hosts by name, owner or version', async () => {
    serve(false);
    mocks.software.mockResolvedValue({ ...matrix, hosts: many });
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-10-30T11:00:00Z')} />));
    await flush();
    const input = el.querySelector('input[type="search"]') as HTMLInputElement;
    const type = (text: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await type('2.1.390');
    expect(hostNames()).toEqual(['box-40']);
    await type('owner1');
    expect(hostNames()).toHaveLength(13);
    await type('offline');
    expect(hostNames()).toHaveLength(8);
  });
});

describe('the Software tab, graded by policy', () => {
  // Claude Code pinned to 2.1.314 with floor 2.1.308. kestrel-box is on 2.1.320 by hand: ahead, not the reference.
  const policy: SoftwareCellPolicy = { mode: 'auto', floor: '2.1.308', target: '2.1.314', reference: '2.1.314' };
  // What the backend's selectFleet takes per scope for these fixtures (a held box, mode off, neither).
  const takes = (state: SoftwareState, p: SoftwareCellPolicy) => ({ 'below-floor': state === 'below-floor' && p.mode !== 'off', behind: (state === 'below-floor' || state === 'behind') && p.mode !== 'off' });
  const graded = (version: string, state: SoftwareState, p: SoftwareCellPolicy = policy) => ({ ...cell(version, state), observedAt: '2026-11-10T10:00:00Z', policy: p, fleet: takes(state, p) });
  const host = (hostKey: string, name: string, owner: string, c: ReturnType<typeof graded>): SoftwareHost => ({
    hostKey, kind: 'box', name, owner, boxKind: 'ec2', status: 'ready', connected: true, lastInventoryAt: '2026-11-10T10:00:00Z', cells: { claude: c },
  });
  const byPolicy: SoftwareMatrix = {
    ...matrix,
    components: ['claude'],
    summary: [{ component: 'claude', reference: '2.1.314', floor: '2.1.308', referenceNote: '', counts: counts({ current: 1, 'below-floor': 1, behind: 1, ahead: 1, held: 1 }), spread: [] }],
    hosts: [
      host('i-01', 'otter-box', 'river', graded('2.1.314', 'current')),
      host('i-02', 'wren-box', 'moor', graded('2.1.240', 'below-floor')),
      host('i-03', 'plover-box', 'delta', graded('2.1.310', 'behind')),
      host('i-04', 'kestrel-box', 'fen', graded('2.1.320', 'ahead')),
      host('i-05', 'heron-box', 'marsh', graded('2.1.310', 'held', { ...policy, mode: 'off' })),
    ],
  };
  it('shows below floor, held and ahead, the floor, and what each cell was graded against', async () => {
    serve(false);
    mocks.software.mockResolvedValue(byPolicy);
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-11-10T11:00:00Z')} />));
    await flush();
    expect(headers()).toEqual(expect.arrayContaining(['floor', 'below floor', 'held', 'ahead']));
    const wren = el.querySelector('.admin-sw-matrix .admin-sw--below-floor')!;
    expect(wren.textContent).toBe('2.1.240');
    expect(wren.closest('[title]')!.getAttribute('title')).toContain('target 2.1.314 · floor 2.1.308 · mode auto');
    expect(el.querySelector('.admin-sw-matrix .admin-sw--held')!.closest('[title]')!.getAttribute('title')).toContain('held: mode off, so neither this tab nor the sweep updates it');
    // The button counts the cells' own states: below floor and behind, not held or ahead (and not the probe's target).
    expect(buttons(/^Update behind \(/).map(b => b.textContent)).toEqual(['Update behind (2)']);
  });

  it('counts 0 and says why on the button when the matrix sends no fleet selection (Devin on #1607)', async () => {
    serve(false);
    const bare = { ...byPolicy, hosts: byPolicy.hosts.map(h => ({ ...h, cells: { claude: { ...h.cells.claude, fleet: undefined } } })) };
    mocks.software.mockResolvedValue(bare);
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-11-10T11:00:00Z')} />));
    await flush();
    const b = buttons(/^Update behind \(/)[0];
    expect(b.textContent).toBe('Update behind (0)');
    expect(b.getAttribute('title')).toMatch(/no fleet selection for Claude Code/);
  });

  it('puts each tool\'s newest run, the sweep\'s block and staleness in its cell, and dims a stale row', async () => {
    serve(false);
    const failed: SoftwareUpdateRun = {
      id: 'r1', hostKey: 'i-02', instanceId: null, component: 'claude', trigger: 'floor', requestedById: null, restart: 'idle',
      status: 'failed', outcome: 'failed', target: '2.1.314', fromVersion: '2.1.240', toVersion: null, detail: 'claude=2.1.240->FAILED:digest', sessions: null,
      requestedAt: '2026-11-10T09:00:00Z', startedAt: '2026-11-10T09:00:05Z', finishedAt: '2026-11-10T09:02:00Z',
    };
    mocks.softwareUpdates.mockImplementation((c: UpdatableTool) => (c === 'claude' ? Promise.resolve({ runs: [failed] }) : off()));
    const hosts = byPolicy.hosts.map(h => (h.hostKey === 'i-02' ? { ...h, cells: { claude: { ...h.cells.claude, sweep: { why: 'floor-failing', at: '2026-11-10T09:45:00Z' } } } }
      : h.hostKey === 'i-03' ? { ...h, cells: { claude: { ...h.cells.claude, observedAt: '2026-11-08T10:00:00Z' } } } : h));
    mocks.software.mockResolvedValue({ ...byPolicy, hosts });
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-11-10T11:00:00Z')} />));
    await flush();
    const badges = [...el.querySelectorAll('.admin-sw-matrix .admin-sw-badge')].map(b => b.textContent);
    expect(badges).toEqual(['failed: digest mismatch', 'floor runs failing', 'stale 2d 1h', 'held: mode off']);
    const wren = el.querySelector('.admin-sw-matrix .admin-sw--below-floor')!.closest('[title]')!;
    expect(wren.getAttribute('title')).toContain('last update: failed · 2.1.240');
    expect(el.querySelectorAll('.admin-sw-matrix .admin-sw-stale')).toHaveLength(1);
    // The header names what an admin can act on; plover-box's stale behind cell still counts, as it is behind.
    expect(el.textContent).toContain('1 below floor · 1 behind target · 0 reboot pending · of 5 hosts');
    // Below a floor, the table shows wren-box alone.
    const show = el.querySelector('select[aria-label="show hosts"]') as HTMLSelectElement;
    await act(async () => { show.value = 'below-floor'; show.dispatchEvent(new Event('change', { bubbles: true })); });
    expect([...el.querySelectorAll('.admin-sw-matrix tbody .admin-link')].map(a => a.textContent)).toEqual(['wren-box']);
  });

  it('shows a host\'s run for a tool it has no inventory row for, as Recent updates does (Devin on #1608)', async () => {
    serve(false);
    const queued: SoftwareUpdateRun = {
      id: 'r9', hostKey: 'i-01', instanceId: null, component: 'claude', trigger: 'manual', requestedById: null, restart: 'idle',
      status: 'running', outcome: null, target: 'latest', fromVersion: null, toVersion: null, detail: null, sessions: null,
      requestedAt: '2026-11-10T10:55:00Z', startedAt: '2026-11-10T10:55:05Z', finishedAt: null,
    };
    mocks.softwareUpdates.mockImplementation((c: UpdatableTool) => (c === 'claude' ? Promise.resolve({ runs: [queued] }) : off()));
    // otter-box has no Claude Code row; heron-box's keeps the column.
    const hosts = [{ ...byPolicy.hosts[0], cells: {} }, byPolicy.hosts[4]];
    mocks.software.mockResolvedValue({ ...byPolicy, hosts });
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-11-10T11:00:00Z')} />));
    await flush();
    // No matrix cell, so no inFlight to say it is on its way: the run's own state, as Recent updates lists it.
    const badge = [...el.querySelectorAll('.admin-sw-matrix .admin-sw-badge')].find(b => b.textContent === 'last update: running')!;
    expect(badge).toBeTruthy();
    expect(badge.closest('[title]')!.getAttribute('title')).toContain('last update: running');
  });

  it('finds a host by its badges and run versions, and gives a tool with runs but no inventory anywhere its column (Bugbot and Devin on #1608)', async () => {
    serve(false, true);
    const failed: SoftwareUpdateRun = {
      id: 'r1', hostKey: 'i-02', instanceId: null, component: 'claude', trigger: 'floor', requestedById: null, restart: 'idle',
      status: 'failed', outcome: 'failed', target: 'latest', fromVersion: '2.1.240', toVersion: '2.1.241', detail: 'claude=2.1.240->FAILED:digest', sessions: null,
      requestedAt: '2026-11-10T09:00:00Z', startedAt: '2026-11-10T09:00:05Z', finishedAt: '2026-11-10T09:02:00Z',
    };
    const cursorRun: SoftwareUpdateRun = { ...failed, id: 'r2', hostKey: 'i-03', component: 'cursor', status: 'running', outcome: null, fromVersion: null, toVersion: null, detail: null, finishedAt: null };
    mocks.softwareUpdates.mockImplementation((c: UpdatableTool) => (c === 'claude' ? Promise.resolve({ runs: [failed] }) : c === 'cursor' ? Promise.resolve({ runs: [cursorRun] }) : off()));
    // Enough hosts for the table's search field to show.
    const filler = Array.from({ length: 25 }, (_, i) => host(`i-f${i}`, `filler-${i}`, 'pool', graded('2.1.314', 'current')));
    mocks.software.mockResolvedValue({ ...byPolicy, hosts: [...byPolicy.hosts, ...filler] });
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-11-10T11:00:00Z')} />));
    await flush();
    // No host has a cursor-agent row, but a run exists: the column is there, and plover-box's cell shows it.
    expect(headers()).toContain('cursor');
    expect([...el.querySelectorAll('.admin-sw-matrix .admin-sw-badge')].map(b => b.textContent)).toContain('last update: running');
    const hostNames = () => [...el.querySelectorAll('.admin-sw-matrix tbody .admin-link')].map(a => a.textContent);
    const search = el.querySelector('input[type="search"]') as HTMLInputElement;
    const type = async (v: string) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      await act(async () => { set.call(search, v); search.dispatchEvent(new Event('input', { bubbles: true })); });
      await flush();
    };
    await type('digest mismatch');
    expect(hostNames()).toEqual(['wren-box']);
    await type('2.1.241');
    expect(hostNames()).toEqual(['wren-box']);
    await type('last update: running');
    expect(hostNames()).toEqual(['plover-box']);
  });

  it('says updating from the matrix\'s inFlight, though the run is not among the runs the tab read (Bugbot on #1608)', async () => {
    serve(false);
    // A Docker-style run queued for days: no run in the runs list at all, but the backend's runActive keeps it.
    const hosts = byPolicy.hosts.map(h => (h.hostKey === 'i-02' ? { ...h, cells: { claude: { ...h.cells.claude, inFlight: { id: 'r-old', status: 'running' as const, requestedAt: '2026-11-07T11:00:00Z' }, sweep: { why: 'floor-failing', at: '2026-11-10T10:45:00Z' } } } } : h));
    mocks.software.mockResolvedValue({ ...byPolicy, hosts });
    await act(async () => root.render(<AdminSoftware now={Date.parse('2026-11-10T11:00:00Z')} />));
    await flush();
    const badges = [...el.querySelectorAll('.admin-sw-matrix .admin-sw-badge')].map(b => b.textContent);
    expect(badges).toContain('updating');
    expect(badges).not.toContain('floor runs failing');
  });
});
