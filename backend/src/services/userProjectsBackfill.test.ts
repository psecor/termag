import { describe, it, expect } from 'vitest';
import { formatBackfillPlan, parseBackfillArgs } from './userProjectsBackfill';

describe('the backfill script', () => {
  it('takes --dry-run and --user', () => {
    expect(parseBackfillArgs([])).toEqual({ ok: true, dryRun: false, user: null });
    expect(parseBackfillArgs(['--dry-run', '--user', 'ada@example.com'])).toEqual({ ok: true, dryRun: true, user: 'ada@example.com' });
    expect(parseBackfillArgs(['--user=ada@example.com'])).toEqual({ ok: true, dryRun: false, user: 'ada@example.com' });
    expect(parseBackfillArgs(['--user'])).toMatchObject({ ok: false });
    // Blank, as `--user="$EMAIL"` with EMAIL unset gives: refused, never everyone.
    expect(parseBackfillArgs(['--user='])).toMatchObject({ ok: false });
    expect(parseBackfillArgs(['--user=  '])).toMatchObject({ ok: false });
    expect(parseBackfillArgs(['--user', '  '])).toMatchObject({ ok: false });
    expect(parseBackfillArgs(['--user', '--dry-run'])).toMatchObject({ ok: false });
    expect(parseBackfillArgs(['--apply'])).toMatchObject({ ok: false });
  });

  it("prints each group's name, repo set and checkouts", () => {
    const out = formatBackfillPlan('ada@example.com', [
      { repoSetKey: 'example-org/termag', repos: [], checkoutIds: ['a', 'b'], existing: null, name: 'termag' },
      { repoSetKey: '', repos: [], checkoutIds: ['c'], existing: { id: 'p', name: 'Scratch' }, name: 'Scratch' },
    ], { attached: 4, projects: 1 });
    expect(out).toBe([
      'ada@example.com: 2 groups, 3 checkouts to attach (already: 1 project, 4 checkouts attached)',
      '  new   termag   example-org/termag  2 checkouts',
      '  joins Scratch  (no repository)     1 checkout',
    ].join('\n'));
    expect(formatBackfillPlan('bo@example.com', [], { attached: 0, projects: 0 }))
      .toBe('bo@example.com: 0 groups, 0 checkouts to attach (already: 0 projects, 0 checkouts attached)');
  });
});
