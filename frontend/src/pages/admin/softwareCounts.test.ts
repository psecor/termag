import { describe, it, expect } from 'vitest';
import { fleetCountHosts, softwareCounts, tableHosts } from './softwareCounts';
import { scopeCount, updateTool } from '../../utils/toolUpdate';

const claude = updateTool('claude');
const codex = updateTool('codex');
import type { SoftwareHost, SoftwareMatrix, SoftwareState, SoftwareSummary } from '../../services/adminApi';

const cell = (state: SoftwareState) => ({ version: '1', raw: null, path: null, state, observedAt: '2026-10-30T00:00:00.000Z' });
const host = (hostKey: string, kind: SoftwareHost['kind'], connected: boolean, state: SoftwareState): SoftwareHost =>
  ({ hostKey, kind, name: hostKey, owner: null, boxKind: null, status: null, connected, lastInventoryAt: null, cells: { claude: cell(state) } });
const summary = (current: number): SoftwareSummary[] =>
  [{ component: 'claude', reference: '1', referenceNote: '', counts: { current, behind: 0, outdated: 0, ahead: 0, missing: 0, unknown: 0 }, spread: [] }];
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
    expect(softwareCounts(m, true)).toEqual({ summary: m.online!.summary, needs: 1, total: 2, excluded: 2, canExclude: true });
  });

  it('off, counts every host as before', () => {
    const m = matrix({ summary: summary(1), offline: 2 });
    expect(softwareCounts(m, false)).toEqual({ summary: m.summary, needs: 3, total: 4, excluded: 0, canExclude: true });
  });

  it('counts every host when an older backend sends no online counts', () => {
    const m = matrix();
    expect(softwareCounts(m, true)).toEqual({ summary: m.summary, needs: 3, total: 4, excluded: 0, canExclude: false });
  });
});

describe('tableHosts', () => {
  const hosts = matrix().hosts;
  it('off (the default) lists every host', () => {
    expect(tableHosts(hosts, { kind: 'all', onlyBad: false, hideOffline: false }).map(h => h.hostKey)).toEqual(['orchestrator', 'box-live', 'box-stopped', 'agent:gone']);
  });
  it('on hides offline hosts and keeps the orchestrator', () => {
    expect(tableHosts(hosts, { kind: 'all', onlyBad: false, hideOffline: true }).map(h => h.hostKey)).toEqual(['orchestrator', 'box-live']);
  });
  it('combines with the kind and needs-update filters', () => {
    expect(tableHosts(hosts, { kind: 'box', onlyBad: true, hideOffline: false }).map(h => h.hostKey)).toEqual(['box-stopped']);
    expect(tableHosts(hosts, { kind: 'box', onlyBad: true, hideOffline: true })).toEqual([]);
  });
});

describe('the fleet update count', () => {
  // Claude cells by state: box-live current, box-stopped outdated, agent:gone behind (the orchestrator never counts).
  const hosts = matrix().hosts;
  it('with "exclude offline hosts" on counts only the online hosts the action reaches', () => {
    expect(scopeCount(claude, fleetCountHosts(hosts, true), 'behind', null)).toBe(0);
  });
  it('with it off counts every host, as before', () => {
    expect(scopeCount(claude, fleetCountHosts(hosts, false), 'behind', null)).toBe(2);
  });
  it('against a target version counts online hosts below it', () => {
    const live = { ...hosts[1], cells: { claude: { ...hosts[1].cells.claude, version: '2.1.0' } } };
    const mixed = [hosts[0], live, { ...hosts[2], cells: { claude: { ...hosts[2].cells.claude, version: '2.0.0' } } }];
    expect(scopeCount(claude, fleetCountHosts(mixed, true), 'behind', { floor: null, target: '2.1.312' })).toBe(1);
    expect(scopeCount(claude, fleetCountHosts(mixed, false), 'behind', { floor: null, target: '2.1.312' })).toBe(2);
  });
  it('counts Codex\'s row the same way, from its own column', () => {
    const withCodex = (h: SoftwareHost, state: SoftwareState): SoftwareHost => ({ ...h, cells: { ...h.cells, codex: { ...cell(state), version: '0.162.0' } } });
    const hs = [withCodex(hosts[0], 'outdated'), withCodex(hosts[1], 'current'), withCodex(hosts[2], 'outdated')];
    const online = hs.filter(h => h.connected && h.kind !== 'orchestrator' && h.cells.codex.state === 'outdated').length;
    expect(scopeCount(codex, fleetCountHosts(hs, true), 'behind', null)).toBe(online);
    expect(scopeCount(codex, fleetCountHosts(hs, false), 'behind', null)).toBe(hs.filter(h => h.kind !== 'orchestrator' && h.cells.codex.state === 'outdated').length);
    expect(scopeCount(codex, fleetCountHosts(hs, true), 'behind', { floor: null, target: '0.165.0' })).toBe(hs.filter(h => h.connected && h.kind !== 'orchestrator').length);
  });
});
