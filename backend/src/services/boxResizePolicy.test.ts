import { describe, expect, it } from 'vitest';
import {
  blockedRefusal,
  hibernationAfterResize,
  RESIZE_STALE_MS,
  resizeAccess,
  resizeBlockers,
  resizeInFlight,
  resizePlan,
  resizeRefusal,
  resizeTypeAllowed,
  resizeView,
  type ResizeBox,
} from './boxResizePolicy';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const box = (over: Partial<ResizeBox> = {}): ResizeBox => ({
  userId: 'u1', kind: 'ec2', status: 'ready', ec2InstanceId: 'i-0abc', size: 'small', autoTerminatedAt: null,
  ...over,
});

describe('who may resize', () => {
  it('the owner, on their own box', () => {
    expect(resizeAccess({ userId: 'u1' }, { id: 'u1', isAdmin: false }, 'owner')).toBe(null);
  });

  it('nobody else on the owner routes: another user\'s box is 404, like a missing one, admins included', () => {
    expect(resizeAccess({ userId: 'u1' }, { id: 'u2', isAdmin: false }, 'owner')).toMatchObject({ status: 404 });
    expect(resizeAccess({ userId: 'u1' }, { id: 'u2', isAdmin: true }, 'owner')).toMatchObject({ status: 404 });
    expect(resizeAccess(null, { id: 'u1', isAdmin: false }, 'owner')).toMatchObject({ status: 404 });
  });

  it('an admin, on any box, from the Fleet tab, with a reason', () => {
    expect(resizeAccess({ userId: 'u1' }, { id: 'admin', isAdmin: true }, 'admin', 'webapp build needs 32 GB')).toBe(null);
    expect(resizeAccess({ userId: 'u1' }, { id: 'admin', isAdmin: true }, 'admin')).toMatchObject({ status: 400, code: 'reason_required' });
    expect(resizeAccess({ userId: 'u1' }, { id: 'admin', isAdmin: true }, 'admin', '  ')).toMatchObject({ status: 400, code: 'reason_required' });
  });

  it('not a non-admin on the admin surface', () => {
    expect(resizeAccess({ userId: 'u1' }, { id: 'u1', isAdmin: false }, 'admin', 'mine')).toMatchObject({ status: 404 });
  });
});

describe('resizeRefusal', () => {
  it('takes sizes only, never a raw instance type', () => {
    expect(resizeRefusal(box(), null, 'm8g.4xlarge', true, NOW)).toMatchObject({ status: 400, code: 'invalid_size' });
    expect(resizeRefusal(box(), null, undefined, true, NOW)).toMatchObject({ status: 400, code: 'invalid_size' });
    expect(resizeRefusal(box(), null, 'large', true, NOW)).toBe(null);
  });

  it('refuses the box it already is', () => {
    expect(resizeRefusal(box({ size: 'large' }), null, 'large', true, NOW)).toMatchObject({ status: 409, code: 'same_size' });
  });

  it('refuses external boxes, unclaimed pool boxes, and an orchestrator without AWS', () => {
    expect(resizeRefusal(box({ kind: 'external' }), null, 'large', true, NOW)).toMatchObject({ code: 'not_ec2' });
    expect(resizeRefusal(box({ userId: null, status: 'warm' }), null, 'large', true, NOW)).toMatchObject({ code: 'pool_box' });
    expect(resizeRefusal(box(), null, 'large', false, NOW)).toMatchObject({ status: 503 });
  });

  it('starts only from ready, stopped or hibernated', () => {
    for (const status of ['ready', 'stopped', 'hibernated']) expect(resizeRefusal(box({ status }), null, 'large', true, NOW)).toBe(null);
    for (const status of ['starting', 'stopping', 'hibernating', 'provisioning', 'failed']) {
      expect(resizeRefusal(box({ status }), null, 'large', true, NOW)).toMatchObject({ status: 409, code: 'box_changing' });
    }
  });

  it('one resize per box: a running one refuses a second with 409, a stale one does not', () => {
    // The box's latest resize row in box_events.
    const row = (over: Record<string, unknown> = {}) => ({ startedAt: new Date(NOW - 60_000), finishedAt: null, to: 'medium', phase: 'stopping', ...over });
    expect(resizeRefusal(box(), row(), 'large', true, NOW)).toMatchObject({ status: 409, code: 'resize_running', error: expect.stringContaining('to medium') });
    expect(resizeRefusal(box(), row({ startedAt: new Date(NOW - RESIZE_STALE_MS - 1) }), 'large', true, NOW)).toBe(null);
    expect(resizeRefusal(box(), row({ finishedAt: new Date(NOW), phase: 'done' }), 'large', true, NOW)).toBe(null);
  });
});

describe('what blocks a resize', () => {
  it('a running turn blocks, says so, and force goes ahead', () => {
    const blockers = resizeBlockers({ status: 'ready' }, { busy: ['ask-run'], working: true }, NOW);
    expect(blockers.map(b => b.check)).toEqual(['working', 'ask-run']);
    const refused = blockedRefusal(blockers, false)!;
    expect(refused).toMatchObject({ status: 409, code: 'box_busy', forceable: true });
    expect(refused.error).toMatch(/an agent is working on it, and its turn stops; an ask is running on it/);
    expect(refused.error).toMatch(/two to three minutes/);
    expect(blockedRefusal(blockers, true)).toBe(null);
  });

  it('a claim in flight and a box update block even with force', () => {
    const claiming = resizeBlockers({ status: 'ready', onClaimStatus: 'running', claimedAt: new Date(NOW - 60_000) }, { busy: [], working: true }, NOW);
    expect(blockedRefusal(claiming, true)).toMatchObject({ forceable: false, error: expect.stringMatching(/warm-pool claim/) });
    const updating = resizeBlockers({ status: 'ready' }, { busy: ['box-update'], working: false }, NOW);
    expect(blockedRefusal(updating, true)).toMatchObject({ forceable: false, error: expect.stringMatching(/box update/) });
  });

  it('an old claim, and a box that is down, block nothing', () => {
    expect(resizeBlockers({ status: 'ready', onClaimStatus: 'pending', claimedAt: new Date(NOW - 2 * 3_600_000) }, { busy: [], working: false }, NOW)).toEqual([]);
    expect(resizeBlockers({ status: 'stopped' }, { busy: ['claude-runner'], working: true }, NOW)).toEqual([]);
  });

  it('a busy check that failed is a forceable blocker, not a pass', () => {
    const [b] = resizeBlockers({ status: 'ready' }, { busy: ['ssh-failed'], working: false }, NOW);
    expect(b).toMatchObject({ check: 'ssh-failed', forceable: true, reason: expect.stringMatching(/could not check ssh/) });
  });
});

describe('resizePlan', () => {
  it('a running box comes back up; a stopped or hibernated one stays down', () => {
    expect(resizePlan({ status: 'ready', size: 'small' }, 'large', ['a', 'b'])).toMatchObject({ fromStatus: 'ready', startAfter: true, from: 'small' });
    expect(resizePlan({ status: 'stopped', size: null }, 'large', ['a'])).toMatchObject({ startAfter: false, from: null });
    expect(resizePlan({ status: 'hibernated', size: 'medium' }, 'small', ['a'])).toMatchObject({ fromStatus: 'hibernated', startAfter: false });
  });
});

describe('hibernationAfterResize: DescribeInstanceTypes may not answer (Bugbot on #877)', () => {
  const t = (memoryMiB: number, hibernationSupported = true) => ({ memoryMiB, hibernationSupported });
  const none = new Map<string, { memoryMiB: number; hibernationSupported: boolean }>();
  it("with EC2's answer: keeps it going down or across in RAM, loses it going up or to a type that cannot", () => {
    expect(hibernationAfterResize('m8g.xlarge', 'm8g.large', new Map([['m8g.xlarge', t(16384)], ['m8g.large', t(8192)]]))).toBe(true);
    expect(hibernationAfterResize('m8g.large', 'm8g.2xlarge', new Map([['m8g.large', t(8192)], ['m8g.2xlarge', t(32768)]]))).toBe(false);
    expect(hibernationAfterResize('m8g.xlarge', 'm8g.large', new Map([['m8g.xlarge', t(16384)], ['m8g.large', t(8192, false)]]))).toBe(false);
  });
  it('without an answer, a downsize or a move across still fits the swap file: it keeps hibernation', () => {
    expect(hibernationAfterResize('m8g.xlarge', 'm8g.large', none)).toBe(true);
    expect(hibernationAfterResize('m8g.2xlarge', 'r8g.xlarge', none)).toBe(true);
    expect(hibernationAfterResize('r7g.large', 'm7g.xlarge', none)).toBe(true);
  });
  it('without an answer, an upsize in RAM by the name still loses it', () => {
    expect(hibernationAfterResize('m8g.large', 'm8g.2xlarge', none)).toBe(false);
    expect(hibernationAfterResize('m8g.xlarge', 'r8g.xlarge', none)).toBe(false);
  });
  it('an answer without memory falls back to the name', () => {
    expect(hibernationAfterResize('m8g.xlarge', 'm8g.large', new Map([['m8g.xlarge', t(0)], ['m8g.large', t(0)]]))).toBe(true);
  });
  it("can't tell (a type its name doesn't size): null, and the flag is left as it was", () => {
    expect(hibernationAfterResize('m9g.2xlarge', 'm8g.xlarge', none)).toBe(null);
    expect(hibernationAfterResize('t4g.large', 'm8g.large', none)).toBe(null);
  });
});

describe('resizeBlockers and a disk grow', () => {
  it('leaves out the disk-grow busy check: the resize waits for the grow instead of refusing (#1214)', () => {
    expect(resizeBlockers({ status: 'ready', onClaimStatus: null, claimedAt: null } as never, { busy: ['disk-grow'], working: false })).toEqual([]);
  });
});

describe('resizeView, from the box_events row', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    startedAt: new Date(NOW), finishedAt: null, from: 'small', to: 'large', phase: 'requested', error: null,
    actorRole: 'owner', reason: null, detail: { fromStatus: 'ready' }, ...over,
  });

  it('a row open for more than an hour reads as cut off, not running', () => {
    const view = resizeView(row({ startedAt: new Date(NOW - RESIZE_STALE_MS - 1), phase: 'stopping' }), NOW)!;
    expect(view).toMatchObject({ running: false, phase: 'failed', error: expect.stringMatching(/cut off/) });
    expect(resizeInFlight({ startedAt: new Date(NOW - 1000), finishedAt: null }, NOW)).toBe(true);
  });

  it('reads requested as waiting for the disk when the resize was asked while a grow ran (Cursor on #1214)', () => {
    expect(resizeView(row({ detail: { fromStatus: 'ready', withDisk: true } }), NOW)!.phase).toBe('disk');
    expect(resizeView(row({ detail: { fromStatus: 'ready' } }), NOW)!.phase).toBe('stopping');
  });

  it('reads requested as the first step, and done as how it ended', () => {
    expect(resizeView(row(), NOW)).toMatchObject({ phase: 'stopping', running: true, fromStatus: 'ready', from: 'small', to: 'large' });
    expect(resizeView(row({ detail: { fromStatus: 'hibernated' } }), NOW)!.phase).toBe('resuming');
    expect(resizeView(row({ phase: 'done', finishedAt: new Date(NOW), detail: { fromStatus: 'stopped', end: 'stopped' } }), NOW)!.phase).toBe('stopped');
    expect(resizeView(row({ phase: 'done', finishedAt: new Date(NOW), detail: { fromStatus: 'ready', end: 'ready' } }), NOW)!.phase).toBe('ready');
    expect(resizeView(row({ phase: 'failed', finishedAt: new Date(NOW), error: 'no capacity' }), NOW)).toMatchObject({ phase: 'failed', error: 'no capacity' });
  });

  it("marks an admin's resize with its reason; no row is no resize", () => {
    expect(resizeView(row({ actorRole: 'admin', reason: 'out of memory' }), NOW)).toMatchObject({ byAdmin: true, reason: 'out of memory' });
    expect(resizeView(null, NOW)).toBe(null);
  });
});


describe('resizeTypeAllowed: Graviton m and r, up to 8 vCPU and 32 GiB', () => {
  it('takes every size\'s first type and the m/r fallbacks within the cap', () => {
    for (const t of ['m8g.large', 'm8g.xlarge', 'm8g.2xlarge', 'm7g.2xlarge', 'r8g.large', 'r8g.xlarge', 'r7g.xlarge']) {
      expect(resizeTypeAllowed(t), t).toBe(true);
    }
  });

  it('skips what goes past it: 64 GiB r 2xlarge, 16 vCPU 4xlarge, and other families', () => {
    expect(resizeTypeAllowed('r8g.2xlarge', { vcpus: 8, memoryMiB: 65536 })).toBe(false);
    expect(resizeTypeAllowed('m8g.4xlarge')).toBe(false);
    // With no DescribeInstanceTypes answer, the name alone: an r 2xlarge is 64 GiB.
    expect(resizeTypeAllowed('r8g.2xlarge')).toBe(false);
    expect(resizeTypeAllowed('r7g.2xlarge')).toBe(false);
    expect(resizeTypeAllowed('r8g.xlarge')).toBe(true);
    expect(resizeTypeAllowed('m8g.2xlarge')).toBe(true);
    expect(resizeTypeAllowed('m8g.4xlarge', { vcpus: 16, memoryMiB: 65536 })).toBe(false);
    for (const t of ['m9g.2xlarge', 'm6g.2xlarge', 't4g.medium', 'c7g.large', 'm7i.large']) expect(resizeTypeAllowed(t), t).toBe(false);
  });
});
