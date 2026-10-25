import { describe, it, expect } from 'vitest';
import { Instance, User } from '@prisma/client';
import {
  type BoxClaimAck,
  type ClaimEffects,
  type ClaimRequest,
  boxClaimPayload,
  claimAwaitsOnClaimReport,
  claimIsStalled,
  claimWarmBox,
  isNameConflict,
} from './warmPoolClaim';

const OWNER: User = {
  id: 'user_ada',
  googleId: 'google-ada',
  googleEmail: 'ada@example.com',
  unixUsername: 'ada',
  displayName: 'Ada Lovelace',
  defaultAgentProvider: 'claude',
  dotfilesRepoUrl: null,
  slackUserId: null,
  discordUserId: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const REQUEST: ClaimRequest = { owner: OWNER, boxName: 'ada-heavy', currentHash: 'sha-current', parentInstanceId: null };

const CLAIMED_AT = new Date('2026-09-22T12:00:00.000Z');

/**
 * A row as the claim statement returns it: already owned, already `ready`,
 * with its side effects still outstanding. That is what the loop is handed.
 */
function claimedRow(id: string): Instance {
  return {
    id,
    userId: OWNER.id,
    name: REQUEST.boxName,
    kind: 'ec2',
    ec2InstanceId: `i-${id}`,
    region: 'us-east-1',
    hostname: `ip-10-0-0-1.${id}`,
    hostUnixUser: 'termag',
    hostHome: '/home/termag',
    securityGroupId: `sg-${id}`,
    iamRoleName: `termag-box-${id}`,
    status: 'ready',
    provisioningError: null,
    createdAt: new Date('2026-09-22T11:00:00.000Z'),
    terminatedAt: null,
    lastConnectedAt: new Date('2026-09-22T11:05:00.000Z'),
    readyAt: null,
    poolSpecHash: REQUEST.currentHash,
    warmedAt: new Date('2026-09-22T11:06:00.000Z'),
    claimedAt: CLAIMED_AT,
    agentDisconnectedAt: null,
    onWarmStatus: 'succeeded',
    onWarmLog: null,
    onClaimStatus: 'pending',
    onClaimError: null,
  };
}

interface EffectLog {
  takes: ClaimRequest[];
  takeLiveIds: string[][];
  configured: Array<{ instanceId: string; ownerId: string }>;
  abandoned: Array<{ instanceId: string; reason: string }>;
  settled: string[];
  welcomed: Array<{ instanceId: string; ownerId: string }>;
  order: string[];
}

/**
 * A pool that hands out `candidates` in order and then runs dry, where the
 * boxes named in `rpcFailsFor` accept the claim in Postgres and then refuse
 * the RPC. Every call is recorded so a test can assert what the loop did as
 * well as what it returned.
 */
function fakePool(
  candidates: Instance[],
  rpcFailsFor: string[] = [],
  live: string[] = candidates.map((c) => c.id),
  ack: BoxClaimAck = { reportsOnClaim: true },
): { effects: ClaimEffects; log: EffectLog } {
  const queue = [...candidates];
  const log: EffectLog = { takes: [], takeLiveIds: [], configured: [], abandoned: [], settled: [], welcomed: [], order: [] };

  const effects: ClaimEffects = {
    liveInstanceIds() {
      return [...live];
    },
    async takeWarmBox(req, liveIds) {
      log.takes.push(req);
      log.takeLiveIds.push(liveIds);
      return queue.shift() ?? null;
    },
    async configureBox(instance, owner) {
      log.configured.push({ instanceId: instance.id, ownerId: owner.id });
      if (rpcFailsFor.includes(instance.id)) throw new Error('Instance agent not connected');
      return ack;
    },
    async abandonBox(instanceId, reason) {
      log.abandoned.push({ instanceId, reason });
    },
    async settleClaim(instanceId) {
      log.settled.push(instanceId);
      log.order.push(`settle ${instanceId}`);
    },
    async welcomeOwner(instance, owner) {
      log.welcomed.push({ instanceId: instance.id, ownerId: owner.id });
      log.order.push(`welcome ${instance.id}`);
    },
  };

  return { effects, log };
}

describe('claimWarmBox', () => {
  it('takes nothing when this process holds no warm box agent, however Postgres reads', async () => {
    // After a restart, or on another replica, a row can still look connected
    // while no socket here reaches it. Taking it would fail a healthy box.
    const { effects, log } = fakePool([claimedRow('box_1')], [], []);

    expect(await claimWarmBox(REQUEST, effects)).toEqual({
      claimed: false,
      reason: 'no-warm-box',
      candidatesTried: 0,
    });
    expect(log.takes).toEqual([]);
    expect(log.abandoned).toEqual([]);
  });

  it('limits the claim statement to the boxes whose agent this process holds', async () => {
    const { effects, log } = fakePool([claimedRow('box_1')], [], ['box_1', 'box_7']);

    await claimWarmBox(REQUEST, effects);
    expect(log.takeLiveIds).toEqual([['box_1', 'box_7']]);
  });

  it('takes only the live boxes the request says are eligible, and nothing when none is (B3)', async () => {
    const { effects, log } = fakePool([claimedRow('box_7')], [], ['box_1', 'box_7']);

    await claimWarmBox({ ...REQUEST, eligible: (id) => id === 'box_7' }, effects);
    expect(log.takeLiveIds).toEqual([['box_7']]);

    const dry = fakePool([claimedRow('box_1')], [], ['box_1']);
    expect(await claimWarmBox({ ...REQUEST, eligible: () => false }, dry.effects)).toEqual({
      claimed: false,
      reason: 'no-warm-box',
      candidatesTried: 0,
    });
    expect(dry.log.takes).toEqual([]);
  });

  it("welcomes the owner onto the box handed over, after the claim settles, and no other", async () => {
    const second = claimedRow('box_2');
    const { effects, log } = fakePool([claimedRow('box_1'), second], ['box_1']);

    await claimWarmBox(REQUEST, effects);
    expect(log.welcomed).toEqual([{ instanceId: 'box_2', ownerId: 'user_ada' }]);
    expect(log.order).toEqual(['settle box_2', 'welcome box_2']);
  });

  it('welcomes nobody when every candidate fails', async () => {
    const { effects, log } = fakePool(['box_1', 'box_2', 'box_3'].map(claimedRow), ['box_1', 'box_2', 'box_3']);

    await claimWarmBox(REQUEST, effects);
    expect(log.welcomed).toEqual([]);
  });

  it('reports a drained pool without touching anything', async () => {
    const { effects, log } = fakePool([], [], ['box_1']);

    expect(await claimWarmBox(REQUEST, effects)).toEqual({
      claimed: false,
      reason: 'no-warm-box',
      candidatesTried: 0,
    });
    expect(log.takes).toEqual([REQUEST]);
    expect(log.configured).toEqual([]);
    expect(log.abandoned).toEqual([]);
    expect(log.settled).toEqual([]);
  });

  it('hands over the one warm box and settles its claim', async () => {
    const box = claimedRow('box_1');
    const { effects, log } = fakePool([box]);

    expect(await claimWarmBox(REQUEST, effects)).toEqual({
      claimed: true,
      instance: box,
      candidatesTried: 1,
    });
    expect(log.configured).toEqual([{ instanceId: 'box_1', ownerId: 'user_ada' }]);
    expect(log.settled).toEqual(['box_1']);
    expect(log.abandoned).toEqual([]);
  });

  it('leaves a dotfiles claim pending for the on-claim run', async () => {
    const owner = { ...OWNER, dotfilesRepoUrl: 'https://github.com/ada/dotfiles' };
    const box = claimedRow('box_dots');
    const { effects, log } = fakePool([box]);

    expect(await claimWarmBox({ ...REQUEST, owner }, effects)).toEqual({
      claimed: true,
      instance: box,
      candidatesTried: 1,
    });
    expect(log.settled).toEqual([]);
  });

  it('settles a dotfiles claim on the ack when the agent will not report on it', async () => {
    // A box whose agent predates dotfiles on claim acks box-claim, writes no
    // URL and starts no run. Left pending, the row would never leave it.
    const owner = { ...OWNER, dotfilesRepoUrl: 'https://github.com/ada/dotfiles' };
    const { effects, log } = fakePool([claimedRow('box_old_agent')], [], undefined, { reportsOnClaim: false });

    await claimWarmBox({ ...REQUEST, owner }, effects);
    expect(log.settled).toEqual(['box_old_agent']);
  });

  it('box-claim carries the repo URL and no GitHub token', () => {
    const payload = boxClaimPayload({
      displayName: 'Ada Lovelace',
      googleEmail: 'ada@example.com',
      dotfilesRepoUrl: 'https://github.com/ada/dotfiles',
    });
    expect(payload).toEqual({
      ownerName: 'Ada Lovelace',
      ownerEmail: 'ada@example.com',
      dotfilesRepoUrl: 'https://github.com/ada/dotfiles',
    });
    expect(payload).not.toHaveProperty('githubToken');
  });

  it('abandons a box whose RPC fails and hands over the next one', async () => {
    const second = claimedRow('box_2');
    const { effects, log } = fakePool([claimedRow('box_1'), second], ['box_1']);

    expect(await claimWarmBox(REQUEST, effects)).toEqual({
      claimed: true,
      instance: second,
      candidatesTried: 2,
    });
    expect(log.abandoned).toEqual([{ instanceId: 'box_1', reason: 'claim RPC failed' }]);
    expect(log.settled).toEqual(['box_2']);
  });

  it('gives up after three failed candidates and leaves the fourth alone', async () => {
    const boxes = ['box_1', 'box_2', 'box_3', 'box_4'].map(claimedRow);
    const { effects, log } = fakePool(boxes, ['box_1', 'box_2', 'box_3', 'box_4']);

    expect(await claimWarmBox(REQUEST, effects)).toEqual({
      claimed: false,
      reason: 'every-candidate-failed',
      candidatesTried: 3,
    });
    expect(log.configured.map((c) => c.instanceId)).toEqual(['box_1', 'box_2', 'box_3']);
    expect(log.abandoned).toEqual([
      { instanceId: 'box_1', reason: 'claim RPC failed' },
      { instanceId: 'box_2', reason: 'claim RPC failed' },
      { instanceId: 'box_3', reason: 'claim RPC failed' },
    ]);
    expect(log.settled).toEqual([]);
  });

  it('reports a pool that ran dry behind a failed candidate as no-warm-box', async () => {
    const { effects, log } = fakePool([claimedRow('box_1')], ['box_1']);

    expect(await claimWarmBox(REQUEST, effects)).toEqual({
      claimed: false,
      reason: 'no-warm-box',
      candidatesTried: 1,
    });
    expect(log.abandoned).toEqual([{ instanceId: 'box_1', reason: 'claim RPC failed' }]);
  });
});

describe('claimAwaitsOnClaimReport', () => {
  const dots = { dotfilesRepoUrl: 'https://github.com/ada/dotfiles' };

  it('waits only with dotfiles and an agent that reports on them', () => {
    expect(claimAwaitsOnClaimReport(dots, { reportsOnClaim: true })).toBe(true);
    expect(claimAwaitsOnClaimReport(dots, { reportsOnClaim: false })).toBe(false);
    expect(claimAwaitsOnClaimReport({ dotfilesRepoUrl: null }, { reportsOnClaim: true })).toBe(false);
  });
});

describe('claimIsStalled', () => {
  const TWO_MINUTES = 2 * 60 * 1000;

  function at(offsetMs: number): Date {
    return new Date(CLAIMED_AT.getTime() + offsetMs);
  }

  it('is false one millisecond before two minutes', () => {
    expect(claimIsStalled({ claimedAt: CLAIMED_AT }, at(TWO_MINUTES - 1), TWO_MINUTES)).toBe(false);
  });

  it('is true at exactly two minutes', () => {
    expect(claimIsStalled({ claimedAt: CLAIMED_AT }, at(TWO_MINUTES), TWO_MINUTES)).toBe(true);
  });

  it('is true an hour later', () => {
    expect(claimIsStalled({ claimedAt: CLAIMED_AT }, at(60 * 60 * 1000), TWO_MINUTES)).toBe(true);
  });

  it('is false for a row that was never claimed', () => {
    expect(claimIsStalled({ claimedAt: null }, at(60 * 60 * 1000), TWO_MINUTES)).toBe(false);
  });
});

describe('isNameConflict', () => {
  it('recognises the unique violation Prisma reports for its own writes', () => {
    expect(isNameConflict({ code: 'P2002', meta: { target: ['userId', 'name'] } })).toBe(true);
  });

  it('recognises the SQLSTATE the claim statement fails with', () => {
    expect(isNameConflict({
      code: 'P2010',
      meta: { code: '23505', message: 'duplicate key value violates unique constraint' },
    })).toBe(true);
  });

  it('recognises a bare SQLSTATE from the driver adapter', () => {
    expect(isNameConflict({ code: '23505' })).toBe(true);
  });

  it('leaves another raw failure alone', () => {
    expect(isNameConflict({ code: 'P2010', meta: { code: '42P01' } })).toBe(false);
  });

  it('leaves an ordinary error alone', () => {
    expect(isNameConflict(new Error('Instance agent not connected'))).toBe(false);
    expect(isNameConflict(null)).toBe(false);
  });
});
