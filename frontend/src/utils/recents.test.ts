import { describe, it, expect } from 'vitest';
import type { RecentRow } from '../services/api';
import {
  agentActivityLabel, filterRecents, groupRecentsByDay, isCurrentRecent, recentHref, recentsBucket,
} from './recents';

// Fixed local "now": a Wednesday at 15:00 local time.
const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime();
const H = 3_600_000;

function row(over: Partial<RecentRow> = {}): RecentRow {
  return {
    projectId: 'p1', projectName: 'termag', workstream: 'main', owner: 'me', access: 'owner',
    instanceId: null, archived: false, color: null, lastVisitedAt: new Date(NOW - H).toISOString(),
    status: 'idle', statusUpdatedAt: null, lastActiveAt: new Date(NOW - 2 * H).toISOString(), provider: 'claude',
    ...over,
  };
}

describe('recentHref', () => {
  it('omits ws for main and includes it otherwise, url-encoded', () => {
    expect(recentHref({ projectId: 'abc', workstream: 'main' })).toBe('/?project=abc');
    expect(recentHref({ projectId: 'abc', workstream: 'fix/x y' })).toBe('/?project=abc&ws=fix%2Fx%20y');
  });
});

describe('recentsBucket / groupRecentsByDay', () => {
  it('buckets by local calendar day, not by 24h windows', () => {
    expect(recentsBucket(NOW - 14 * H, NOW)).toBe('Today');          // 01:00 today
    expect(recentsBucket(NOW - 16 * H, NOW)).toBe('Yesterday');      // 23:00 yesterday
    expect(recentsBucket(NOW - 40 * H, NOW)).toBe('Earlier');
  });

  it('groups in Today/Yesterday/Earlier order and omits empty buckets', () => {
    const rows = [
      row({ projectId: 'a', lastVisitedAt: new Date(NOW - H).toISOString() }),
      row({ projectId: 'b', lastVisitedAt: new Date(NOW - 50 * H).toISOString() }),
    ];
    const g = groupRecentsByDay(rows, NOW);
    expect(g.map(x => x.label)).toEqual(['Today', 'Earlier']);
    expect(g[0].rows.map(r => r.projectId)).toEqual(['a']);
  });
});

describe('filterRecents', () => {
  const rows = [
    row({ projectId: 'live' }),
    row({ projectId: 'old', archived: true }),
    row({ projectId: 'tower', kind: 'metaterm', projectName: 'MetaTerm' }),
    row({ projectId: 'ws', workstream: 'feature-x', projectName: 'shop' }),
  ];

  it('drops archived and MetaTerm by default (switcher semantics)', () => {
    expect(filterRecents(rows).map(r => r.projectId)).toEqual(['live', 'ws']);
  });

  it('can include archived (dashboard semantics)', () => {
    expect(filterRecents(rows, { includeArchived: true }).map(r => r.projectId)).toEqual(['live', 'old', 'ws']);
  });

  it('matches the query against project name and workstream, case-insensitively', () => {
    expect(filterRecents(rows, { query: 'FEATURE' }).map(r => r.projectId)).toEqual(['ws']);
    expect(filterRecents(rows, { query: 'shop' }).map(r => r.projectId)).toEqual(['ws']);
    expect(filterRecents(rows, { query: 'nope' })).toEqual([]);
  });
});

describe('isCurrentRecent', () => {
  it('treats a missing workstream as main', () => {
    expect(isCurrentRecent({ projectId: 'p', workstream: 'main' }, 'p', '')).toBe(true);
    expect(isCurrentRecent({ projectId: 'p', workstream: 'x' }, 'p', 'main')).toBe(false);
    expect(isCurrentRecent({ projectId: 'p', workstream: 'main' }, 'q', 'main')).toBe(false);
  });
});

describe('agentActivityLabel', () => {
  const age = (ms: number) => `${Math.round(ms / H)}h`;
  it('describes live states without an age, and quiet states with one', () => {
    expect(agentActivityLabel(row({ status: 'working' }), NOW, age)).toBe('agent working now');
    expect(agentActivityLabel(row({ status: 'waiting' }), NOW, age)).toBe('agent waiting on you');
    expect(agentActivityLabel(row({ status: 'idle' }), NOW, age)).toBe('agent idle · active 2h ago');
    expect(agentActivityLabel(row({ status: 'not_running' }), NOW, age)).toBe('agent not running · last active 2h ago');
  });
});
