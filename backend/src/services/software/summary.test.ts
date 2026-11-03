import { describe, it, expect } from 'vitest';
import { isOnline, summarize, summaryAnswer, type Cell, type HostRow } from './summary';
import type { SoftwareState } from './versions';

const cell = (version: string | null, state: SoftwareState): Cell => ({ version, raw: version, path: null, state, observedAt: '2026-10-30T00:00:00.000Z' });
const host = (hostKey: string, kind: HostRow['kind'], connected: boolean, cells: Record<string, Cell>): HostRow =>
  ({ hostKey, kind, name: hostKey, owner: null, boxKind: null, status: null, connected, lastInventoryAt: null, cells });
const ref = () => ({ reference: '2.1.312', referenceNote: 'the newest version anywhere in the fleet' });

const hosts = [
  // The orchestrator counts as online whatever its connected says.
  host('orchestrator', 'orchestrator', false, { claude: cell('2.1.312', 'current'), termag: cell('aaaaaaaaaaaaaaaa', 'current') }),
  host('box-live', 'box', true, { claude: cell('2.1.312', 'current') }),
  host('box-stopped-1', 'box', false, { claude: cell('2.1.292', 'behind') }),
  host('box-stopped-2', 'box', false, { claude: cell('2.0.1', 'outdated'), termag: cell('bbbbbbbbbbbbbbbb', 'behind') }),
  host('agent:u1', 'agent', true, { claude: cell(null, 'missing') }),
];

describe('isOnline', () => {
  it('is the connected flag, and always true for the orchestrator', () => {
    expect(hosts.map(isOnline)).toEqual([true, true, false, false, true]);
  });
});

describe('summarize', () => {
  it('over every host gives today\'s counts and spread', () => {
    const [claude, termag] = summarize(['claude', 'termag'], hosts, ref);
    expect(claude).toEqual({
      component: 'claude', reference: '2.1.312', referenceNote: 'the newest version anywhere in the fleet',
      counts: { current: 2, behind: 1, outdated: 1, ahead: 0, missing: 1, unknown: 0 },
      spread: [{ version: '2.1.312', hosts: 2 }, { version: '2.1.292', hosts: 1 }, { version: '2.0.1', hosts: 1 }],
    });
    expect(termag.counts).toMatchObject({ current: 1, behind: 1 });
    expect(termag.spread).toEqual([{ version: 'aaaaaaaaaaaa', hosts: 1 }, { version: 'bbbbbbbbbbbb', hosts: 1 }]);
  });

  it('over online hosts leaves offline boxes out of counts and spread, keeps the orchestrator, and keeps the reference', () => {
    const [claude, termag] = summarize(['claude', 'termag'], hosts.filter(isOnline), ref);
    expect(claude.counts).toEqual({ current: 2, behind: 0, outdated: 0, ahead: 0, missing: 1, unknown: 0 });
    expect(claude.spread).toEqual([{ version: '2.1.312', hosts: 2 }]);
    expect(claude.reference).toBe('2.1.312');
    expect(termag.counts).toMatchObject({ current: 1, behind: 0 });
    expect(termag.spread).toEqual([{ version: 'aaaaaaaaaaaa', hosts: 1 }]);
  });

  it('lists a component no online host has, with zero counts', () => {
    const [only] = summarize(['envoy'], [host('box-stopped', 'box', false, { envoy: cell('1.30.0', 'current') })].filter(isOnline), ref);
    expect(only.counts).toEqual({ current: 0, behind: 0, outdated: 0, ahead: 0, missing: 0, unknown: 0 });
    expect(only.spread).toEqual([]);
  });
});

describe('summaryAnswer (MCP software_summary)', () => {
  const all = summarize(['claude'], hosts, ref);
  const online = { summary: summarize(['claude'], hosts.filter(isOnline), ref), offline: 2 };
  const m = { summary: all, online, targets: { boxCommit: null }, collector: { lastError: null } };

  it('both, the default, keeps the old `summary` and adds `online`, and says which is which', () => {
    const out = summaryAnswer(m, 'both');
    expect(out).toEqual({ hosts: 'both', counted: 'summary: every host, including 2 offline; online.summary: online hosts only', summary: all, online, targets: m.targets, collector: m.collector });
  });

  it('online returns only the online counts', () => {
    const out = summaryAnswer(m, 'online');
    expect(out).toEqual({ hosts: 'online', counted: 'online hosts only; 2 offline left out', online, targets: m.targets, collector: m.collector });
    expect('summary' in out).toBe(false);
  });

  it('all returns every host, as the tool did before, with the offline count', () => {
    const out = summaryAnswer(m, 'all');
    expect(out).toEqual({ hosts: 'all', counted: 'every host, including 2 offline (their inventories may be days old)', summary: all, offline: 2, targets: m.targets, collector: m.collector });
    expect('online' in out).toBe(false);
  });
});
