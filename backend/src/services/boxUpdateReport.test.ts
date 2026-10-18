import { describe, expect, it, vi } from 'vitest';
vi.mock('../db', () => ({ prisma: { instance: { findUnique: vi.fn(), update: vi.fn() } } }));
import { prisma } from '../db';
import { lastBoxUpdateOf, parseBoxUpdateReport, recordBoxUpdateReport, reportDetail } from './boxUpdateReport';

const now = new Date('2026-10-10T12:00:00Z');
const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40);
const body = { event: 'box-update', outcome: 'updated', pull: 'pulled:3', reconcile: 'clean', deps: 'installed', agent: 'restarted', from: SHA_A, to: SHA_B, at: '2026-10-10T11:59:30Z' };

describe('parseBoxUpdateReport', () => {
  it('takes the outcome word, a token per step, the two commits and the box clock within trust', () => {
    expect(parseBoxUpdateReport(body, now)).toEqual({ outcome: 'updated', pull: 'pulled:3', reconcile: 'clean', deps: 'installed', agent: 'restarted', hooks: null, from: SHA_A, to: SHA_B, at: new Date('2026-10-10T11:59:30Z') });
    expect(parseBoxUpdateReport({ ...body, from: undefined, to: undefined, at: undefined }, now)).toMatchObject({ from: null, to: null, at: now });
    expect(parseBoxUpdateReport({ ...body, at: '2026-10-10T09:00:00Z' }, now)).toMatchObject({ at: now });
  });
  it('takes the hooks step when a newer script sends it, and shows it in the detail', () => {
    const r = parseBoxUpdateReport({ ...body, hooks: 'updated' }, now) as Exclude<ReturnType<typeof parseBoxUpdateReport>, { error: string }>;
    expect(r.hooks).toBe('updated');
    expect(reportDetail(r)).toBe('pull=pulled:3 reconcile=clean deps=installed agent=restarted hooks=updated');
    expect(parseBoxUpdateReport({ ...body, hooks: 'Updated the hooks' }, now)).toHaveProperty('error');
  });
  it('refuses anything that is not the script\'s vocabulary', () => {
    expect(parseBoxUpdateReport({ ...body, event: 'ended' }, now)).toHaveProperty('error');
    expect(parseBoxUpdateReport({ ...body, outcome: 'great' }, now)).toHaveProperty('error');
    expect(parseBoxUpdateReport({ ...body, pull: 'pulled 3 commits from origin' }, now)).toHaveProperty('error');
    expect(parseBoxUpdateReport({ ...body, agent: 'Restarted' }, now)).toHaveProperty('error');
    expect(parseBoxUpdateReport({ ...body, from: 'abc' }, now)).toHaveProperty('error');
    expect(parseBoxUpdateReport({ ...body, at: 'noon' }, now)).toHaveProperty('error');
    expect(parseBoxUpdateReport(null, now)).toHaveProperty('error');
  });
});

describe('recordBoxUpdateReport', () => {
  it('writes the outcome, the detail line and the commit the checkout ended on, for a known box', async () => {
    vi.mocked(prisma.instance.findUnique).mockResolvedValue({ name: 'ada-box', user: { unixUsername: 'ada' } } as never);
    const r = parseBoxUpdateReport(body, now) as Exclude<ReturnType<typeof parseBoxUpdateReport>, { error: string }>;
    expect(await recordBoxUpdateReport('box-a', r)).toEqual({ boxName: 'ada-box', owner: 'ada' });
    expect(prisma.instance.update).toHaveBeenCalledWith({
      where: { id: 'box-a' },
      data: { lastUpdateAt: r.at, lastUpdateOutcome: 'updated', lastUpdateDetail: 'pull=pulled:3 reconcile=clean deps=installed agent=restarted', lastUpdateCommit: SHA_B },
    });
    expect(reportDetail(r)).toBe('pull=pulled:3 reconcile=clean deps=installed agent=restarted');
    vi.mocked(prisma.instance.findUnique).mockResolvedValue(null);
    expect(await recordBoxUpdateReport('box-x', r)).toBeNull();
  });
  it('reads a row back for the admin, null before any report', () => {
    expect(lastBoxUpdateOf({ lastUpdateAt: null, lastUpdateOutcome: null, lastUpdateDetail: null, lastUpdateCommit: null })).toBeNull();
    expect(lastBoxUpdateOf({ lastUpdateAt: now, lastUpdateOutcome: 'deferred', lastUpdateDetail: 'x', lastUpdateCommit: SHA_B })).toEqual({ at: now.toISOString(), outcome: 'deferred', detail: 'x', commit: SHA_B });
  });
});
