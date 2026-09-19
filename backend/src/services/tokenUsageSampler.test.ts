import { describe, it, expect } from 'vitest';
import { normalizeScanResponse, resolveRows, buildUsageResponse, emptyDay, UsageRowAgg } from './tokenUsageSampler';

const day = (input: number, calls = 1) => ({ input, output: 0, cacheRead: 0, cacheCreate: 0, calls });
const tok = (d: { input: number; output: number; cacheRead: number; cacheCreate: number }) => d.input + d.output + d.cacheRead + d.cacheCreate;

describe('normalizeScanResponse', () => {
  it('schema 2 → one row per (provider, bucket, date), skipping errored dirs', () => {
    const n = normalizeScanResponse({
      schema: 2, scannedAt: '2026-09-19T00:00:00Z',
      days: {}, providers: {},
      sources: {
        claude: {
          buckets: [
            { dir: '-home-u-termag-projects-a', cwdHint: '/home/u/termag/projects/a', days: { '2026-09-18': day(10), '2026-09-19': day(20) } },
            { dir: '-home-u-bad', cwdHint: null, days: { '2026-09-19': day(99) } },
          ],
          errors: [{ dir: '-home-u-bad', file: 'x.jsonl', error: 'EACCES' }],
          stats: {},
        },
        codex: { buckets: [{ cwdHint: null, days: { '2026-09-19': day(5) } }], errors: [], stats: {} },
      },
    });
    expect(n.schema).toBe(2);
    expect(n.rows.map(r => [r.provider, r.date, r.sourceKey, r.day.input])).toEqual([
      ['claude', '2026-09-18', '-home-u-termag-projects-a', 10],
      ['claude', '2026-09-19', '-home-u-termag-projects-a', 20],
      ['codex', '2026-09-19', '', 5],
    ]);
    expect(n.skippedDirs.has('-home-u-bad')).toBe(true);
  });
  it('schema 1 → per provider per day with empty sourceKey; bare days → provider "unknown"', () => {
    const n = normalizeScanResponse({ days: { '2026-09-19': day(7) }, providers: { claude: { '2026-09-19': day(7) } } });
    expect(n.schema).toBe(1);
    expect(n.rows).toEqual([{ provider: 'claude', date: '2026-09-19', sourceKey: '', cwdHint: null, dir: null, agentSchema: 1, day: day(7) }]);
    expect(normalizeScanResponse({ days: { '2026-09-19': day(1) } }).rows[0].provider).toBe('unknown');
    expect(normalizeScanResponse(null).rows).toEqual([]);
  });
  it('ignores malformed dates and non-numeric fields', () => {
    const n = normalizeScanResponse({ providers: { claude: { nope: day(1), '2026-09-19': { input: 'x', calls: 2 } } } });
    expect(n.rows).toHaveLength(1);
    expect(n.rows[0].day).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 2 });
  });
});

describe('resolveRows', () => {
  it('attributes schema-2 rows via cwdHint/dir; schema-1 rows stay unattributed', () => {
    const projects = [{ id: 'a', name: 'a', workstreams: [] }];
    const rows = resolveRows([
      { provider: 'claude', date: 'd', sourceKey: 'k', cwdHint: '/home/u/termag/projects/a', dir: '-home-u-termag-projects-a', agentSchema: 2, day: day(1) },
      { provider: 'claude', date: 'd', sourceKey: '', cwdHint: null, dir: null, agentSchema: 1, day: day(1) },
    ], 'u', projects);
    expect(rows.map(r => r.projectId)).toEqual(['a', null]);
    expect(rows[0].workstream).toBe('main');
  });
});

describe('buildUsageResponse', () => {
  const projects = [{ id: 'a', name: 'alpha', color: '#111', kind: 'normal' }, { id: 'b', name: 'beta', color: null, kind: 'normal' }];
  const rows: UsageRowAgg[] = [
    { projectId: 'a', workstream: 'main', provider: 'claude', date: '2026-09-19', estimated: false, day: day(100) },
    { projectId: 'a', workstream: 'feature', provider: 'claude', date: '2026-09-19', estimated: false, day: day(50) },
    { projectId: 'b', workstream: 'main', provider: 'codex', date: '2026-09-19', estimated: false, day: day(30) },
    { projectId: null, workstream: null, provider: 'claude', date: '2026-09-19', estimated: false, day: day(20) },
    { projectId: 'gone', workstream: 'main', provider: 'claude', date: '2026-09-18', estimated: false, day: day(5) }, // deleted project → unattributed
  ];
  const now = Date.parse('2026-09-19T12:00:00Z');
  it('sum(projects) + unattributed == days, minus estimates', () => {
    const r = buildUsageResponse(rows, projects, { providerIds: ['cursor'], days: { '2026-09-19': day(1000) } }, [], new Date(now - 60_000), now);
    const sumProjects = r.projects.reduce((s, p) => s + Object.values(p.days).reduce((a, d) => a + tok(d), 0), 0);
    const sumUnattr = Object.values(r.unattributed).reduce((a, d) => a + tok(d), 0);
    const sumDays = Object.values(r.days).reduce((a, d) => a + tok(d), 0);
    const est = Object.values(r.providers.cursor).reduce((a, d) => a + tok(d), 0);
    expect(sumProjects + sumUnattr).toBe(sumDays - est);
    expect(sumUnattr).toBe(25);
    expect(r.projects.map(p => `${p.name}/${p.workstream}`)).toEqual(['alpha/feature', 'alpha/main', 'beta/main']);
    expect(r.providers.claude['2026-09-19'].input).toBe(170);
    expect(r.staleSince).toBeNull();
  });
  it('staleSince set when the newest scan is older than 15 min; null with no scans', () => {
    expect(buildUsageResponse([], projects, { providerIds: [], days: {} }, [], new Date(now - 16 * 60_000), now).staleSince).toBe(new Date(now - 16 * 60_000).toISOString());
    expect(buildUsageResponse([], projects, { providerIds: [], days: {} }, [], null, now).staleSince).toBeNull();
    expect(emptyDay()).toEqual(day(0, 0));
  });
});
