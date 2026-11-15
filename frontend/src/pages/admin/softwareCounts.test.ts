import { describe, it, expect } from 'vitest';
import { fleetCountHosts, headerText, hostAttention, softwareCounts, tableHosts } from './softwareCounts';
import { scopeCount, updateTool } from '../../utils/toolUpdate';

const claude = updateTool('claude');
const codex = updateTool('codex');
import type { SoftwareCell, SoftwareHost, SoftwareMatrix, SoftwareState, SoftwareSummary } from '../../services/adminApi';

const cell = (state: SoftwareState) => ({ version: '1', raw: null, path: null, state, observedAt: '2026-10-30T00:00:00.000Z' });
const host = (hostKey: string, kind: SoftwareHost['kind'], connected: boolean, state: SoftwareState): SoftwareHost =>
  ({ hostKey, kind, name: hostKey, owner: null, boxKind: null, status: null, connected, lastInventoryAt: null, cells: { claude: cell(state) } });
const summary = (current: number): SoftwareSummary[] =>
  [{ component: 'claude', reference: '1', referenceNote: '', counts: { current, 'below-floor': 0, held: 0, behind: 0, outdated: 0, ahead: 0, pending: 0, missing: 0, unknown: 0 }, spread: [] }];
const matrix = (online?: SoftwareMatrix['online']): SoftwareMatrix => ({
  components: ['claude'], summary: summary(9), online,
  hosts: [
    host('orchestrator', 'orchestrator', false, 'behind'), // always online
    host('box-live', 'box', true, 'current'),
    host('box-stopped', 'box', false, 'outdated'),
    host('agent:gone', 'agent', false, 'behind'),
  ],
  targets: { boxCommit: null, orchestratorImageCommit: null, runningCommit: null },
  collector: { lastSweepAt: null, lastSelfAt: null, lastError: null },
  generatedAt: '2026-10-30T00:00:00.000Z',
});

describe('softwareCounts', () => {
  it('excludes offline hosts from the header and uses the online summary, keeping the orchestrator', () => {
    const m = matrix({ summary: summary(1), offline: 2 });
    expect(softwareCounts(m, true)).toMatchObject({ summary: m.online!.summary, needs: 1, total: 2, excluded: 2, canExclude: true, graded: false });
  });

  it('off, counts every host as before', () => {
    const m = matrix({ summary: summary(1), offline: 2 });
    expect(softwareCounts(m, false)).toMatchObject({ summary: m.summary, needs: 3, total: 4, excluded: 0, canExclude: true });
  });

  it('counts every host when an older backend sends no online counts', () => {
    const m = matrix();
    expect(softwareCounts(m, true)).toMatchObject({ summary: m.summary, needs: 3, total: 4, excluded: 0, canExclude: false });
  });
});

describe('tableHosts', () => {
  const hosts = matrix().hosts;
  it('off (the default) lists every host', () => {
    expect(tableHosts(hosts, { kind: 'all', show: 'all', hideOffline: false }).map(h => h.hostKey)).toEqual(['orchestrator', 'box-live', 'box-stopped', 'agent:gone']);
  });
  it('on hides offline hosts and keeps the orchestrator', () => {
    expect(tableHosts(hosts, { kind: 'all', show: 'all', hideOffline: true }).map(h => h.hostKey)).toEqual(['orchestrator', 'box-live']);
  });
  it('combines with the kind and needs-update filters', () => {
    expect(tableHosts(hosts, { kind: 'box', show: 'needs', hideOffline: false }).map(h => h.hostKey)).toEqual(['box-stopped']);
    expect(tableHosts(hosts, { kind: 'box', show: 'needs', hideOffline: true })).toEqual([]);
  });
});

describe('the fleet update count', () => {
  // Each box cell's `fleet` is the backend's selectFleet per scope; the count is those, over the hosts the tab counts.
  const taken = (h: SoftwareHost, behind: boolean): SoftwareHost => ({ ...h, cells: { ...h.cells, claude: { ...h.cells.claude, fleet: { 'below-floor': false, behind } } } });
  const hosts = matrix().hosts.map(h => taken(h, h.hostKey !== 'box-live'));
  it('with "exclude offline hosts" on counts only the online hosts', () => {
    // box-live is online and not taken; box-stopped and agent:gone are offline; the orchestrator never counts.
    expect(scopeCount(claude, fleetCountHosts(hosts, true), 'behind')).toBe(0);
  });
  it('with it off counts every host the backend says the update takes', () => {
    expect(scopeCount(claude, fleetCountHosts(hosts, false), 'behind')).toBe(2);
  });
  it('counts Codex\'s row from its own column', () => {
    const withCodex = (h: SoftwareHost, behind: boolean): SoftwareHost => ({ ...h, cells: { ...h.cells, codex: { ...cell('outdated'), version: '0.162.0', fleet: { 'below-floor': false, behind } } } });
    const hs = matrix().hosts.map((h, i) => withCodex(h, i !== 1));
    expect(scopeCount(codex, fleetCountHosts(hs, false), 'behind')).toBe(2);
    expect(scopeCount(claude, fleetCountHosts(hs, false), 'behind')).toBe(0);
  });
});

describe('the actionable counts, once the tools are graded by policy', () => {
  const policy = { mode: 'auto' as const, floor: '2.1.308', target: 'latest', reference: '2.1.314' };
  const graded = (state: SoftwareState) => ({ ...cell(state), policy });
  const h = (hostKey: string, kind: SoftwareHost['kind'], cells: SoftwareHost['cells'], connected = true): SoftwareHost =>
    ({ hostKey, kind, name: hostKey, owner: null, boxKind: null, status: null, connected, lastInventoryAt: null, cells });
  const hosts = [
    // The orchestrator's container gh and tmux are outdated: nothing on the tab updates them.
    h('orchestrator', 'orchestrator', { gh: cell('outdated'), tmux: cell('behind'), claude: graded('current') }),
    h('box-floor', 'box', { claude: graded('below-floor'), gh: graded('behind') }),
    h('box-behind', 'box', { claude: graded('behind'), tmux: cell('outdated') }),
    h('box-held', 'box', { claude: graded('held'), git: cell('behind') }),
    h('box-reboot', 'box', { claude: graded('current'), reboot: cell('pending') }),
    h('box-off', 'box', { claude: graded('below-floor') }, false),
  ];
  const m: SoftwareMatrix = { ...matrix({ summary: summary(1), offline: 1 }), hosts };
  it('counts below floor, behind target and reboot pending, and nothing an admin can\'t act on here', () => {
    expect(hostAttention(hosts[0], true)).toEqual({ belowFloor: false, stuck: false, behind: false, reboot: false });
    expect(hostAttention(hosts[1], true)).toEqual({ belowFloor: true, stuck: false, behind: true, reboot: false });
    expect(hostAttention(hosts[3], true)).toEqual({ belowFloor: false, stuck: false, behind: false, reboot: false });
    const c = softwareCounts(m, true);
    expect(c).toMatchObject({ graded: true, belowFloor: 1, behind: 2, reboot: 1, needs: 3, total: 5, excluded: 1 });
    expect(headerText(c)).toBe('1 below floor · 2 behind target · 1 reboot pending · of 5 hosts');
    expect(softwareCounts(m, false)).toMatchObject({ belowFloor: 2, total: 6 });
  });
  it('keeps the old line for an older backend', () => {
    expect(headerText(softwareCounts(matrix(), true))).toBe('3 of 4 hosts need updates');
  });
  it('filters the table to the hosts needing updates, or only those below a floor', () => {
    expect(tableHosts(hosts, { kind: 'all', show: 'needs', hideOffline: false }).map(x => x.hostKey)).toEqual(['box-floor', 'box-behind', 'box-reboot', 'box-off']);
    expect(tableHosts(hosts, { kind: 'all', show: 'below-floor', hideOffline: true }).map(x => x.hostKey)).toEqual(['box-floor']);
  });
});

describe('below a floor, and nothing here would update it', () => {
  // Devin on #1607 and #1608: a box below its floor with mode off counted as actionable, and the update skipped it.
  const policy = { mode: 'off' as const, floor: '2.1.308', target: 'latest', reference: '2.1.314' };
  const c = (state: SoftwareState, refusal: SoftwareCell['refusal']) => ({ ...cell(state), policy, refusal });
  const h = (hostKey: string, cells: SoftwareHost['cells']): SoftwareHost =>
    ({ hostKey, kind: 'box', name: hostKey, owner: 'river', boxKind: null, status: null, connected: true, lastInventoryAt: null, cells });
  const hosts = [
    h('off', { claude: c('below-floor', 'claude_update_off') }),
    h('mixed', { claude: c('below-floor', 'claude_update_off'), node: c('below-floor', null) }),
    h('incapable-behind', { gh: c('behind', 'not_capable') }),
    h('fine', { claude: c('current', null) }),
  ];
  const m: SoftwareMatrix = { ...matrix(), online: undefined, hosts };
  it('still counts it below floor, and says how many can\'t be updated here', () => {
    expect(hostAttention(hosts[0], true)).toEqual({ belowFloor: true, stuck: true, behind: false, reboot: false });
    expect(hostAttention(hosts[1], true)).toMatchObject({ belowFloor: true, stuck: false });
    // Behind, but the update would skip it: not presented as actionable.
    expect(hostAttention(hosts[2], true)).toMatchObject({ behind: false });
    const counts = softwareCounts(m, false);
    expect(counts).toMatchObject({ belowFloor: 2, stuck: 1, behind: 0 });
    expect(headerText(counts)).toBe('2 below floor (1 can’t be updated here) · 0 behind target · 0 reboot pending · of 4 hosts');
  });
  it('counts a box whose update is running as updating, not stuck, and the orchestrator as having its own action (Devin on #1608)', () => {
    const run = h('running', { claude: c('below-floor', 'run_in_flight') });
    const mixed = h('mixed-running', { claude: c('below-floor', 'run_in_flight'), node: c('below-floor', 'claude_update_off') });
    // The orchestrator's own policy auto (its nightly run on): it has its own action, so it is not stuck.
    const orch: SoftwareHost = { ...h('orchestrator', { claude: { ...c('below-floor', 'orchestrator'), policy: { ...policy, mode: 'auto' } } }), kind: 'orchestrator' };
    expect(hostAttention(run, true)).toMatchObject({ belowFloor: true, stuck: false });
    expect(hostAttention(mixed, true)).toMatchObject({ belowFloor: true, stuck: false });
    expect(hostAttention(orch, true)).toMatchObject({ belowFloor: true, stuck: false });
    // Bugbot on #1607: the orchestrator counts by its own policy, never the viewing admin's host panel.
    const orchFor = (refusal: SoftwareCell['refusal'], ownMode: 'off' | 'auto', panel: { offered: boolean; mode: 'off' | 'auto' }): SoftwareHost =>
      ({ ...h('orchestrator', { claude: { ...cell('below-floor'), policy: { ...policy, mode: ownMode }, refusal, panel } }), kind: 'orchestrator' });
    expect(hostAttention(orchFor('orchestrator', 'auto', { offered: true, mode: 'auto' }), true)).toEqual(hostAttention(orchFor('orchestrator_panel_off', 'auto', { offered: false, mode: 'off' }), true));
    expect(hostAttention(orchFor('orchestrator_panel_off', 'auto', { offered: false, mode: 'off' }), true).stuck).toBe(false);
    expect(hostAttention(orchFor('orchestrator', 'off', { offered: true, mode: 'auto' }), true).stuck).toBe(true);
    // Behind with an update running still counts as behind; behind on an agent that can't doesn't.
    expect(hostAttention(h('b', { gh: c('behind', 'run_in_flight') }), true).behind).toBe(true);
  });
  it('keeps it in the host filters', () => {
    expect(tableHosts(hosts, { kind: 'all', show: 'below-floor', hideOffline: false }).map(x => x.hostKey)).toEqual(['off', 'mixed']);
    expect(tableHosts(hosts, { kind: 'all', show: 'needs', hideOffline: false }).map(x => x.hostKey)).toEqual(['off', 'mixed']);
  });
});
