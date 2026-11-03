import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./agentRegistry', () => ({}));
vi.mock('./boxUpdate', () => ({ BOX_UPDATE_CAPABILITY: 'box-update-v1', noteClaimUpdated: vi.fn() }));
vi.mock('./termagVersion', () => ({ termagVersion: async () => ({ sha: null, source: 'unknown' }) }));

const { CLAIM_UPDATE_MIN_RUN_MS, CLAIM_UPDATE_TIMEOUT_MS, claimUpdateDecision, expireStaleClaimUpdates, runClaimUpdate, startClaimUpdate } = await import('./claimUpdate');
const { claimUpdateSettled, resetClaimUpdateGate } = await import('./claimUpdateGate');
const { claimUpdateOpensPolicy, CLAIM_UPDATE_POLICY_MS } = await import('./boxUpdatePolicy');
const { noteClaimUpdated } = await import('./boxUpdate');

const OLD = 'a'.repeat(40);
const MAIN = 'b'.repeat(40);
const CAPABLE = ['credentials-v1', 'box-update-v1'];
const box = { id: 'box1', name: 'ada-box', kind: 'ec2', userId: 'u_ada' };

type Report = { outcome: string; detail: string | null; commit: string | null };

/**
 * A box and its agent in memory, on a clock the test moves: `sleep` advances
 * it, so a 150-second wait takes no time. `script` runs the box's side at the
 * RPC: what it reports and whether the agent comes back as a new connection.
 */
function fakeBox(opts: {
  commit?: string | null;
  capabilities?: string[];
  target?: string | null;
  /** After how many ms the report lands, or never. */
  reportAfter?: number | null;
  report?: Report;
  /** The agent says hello again this long after the report (a restart or the redial), or never. */
  reconnectAfter?: number | null;
  rpcFails?: string;
}) {
  let now = 0;
  let conn: object = {};
  let commit = opts.commit === undefined ? OLD : opts.commit;
  let capabilities = opts.capabilities ?? CAPABLE;
  let sentAt: number | null = null;
  const log: string[] = [];
  const rows: Array<{ status: string; detail: string }> = [];
  const report = opts.report ?? { outcome: 'updated', detail: 'pull=pulled:3 reconcile=reconciled deps=unchanged agent=restarted', commit: MAIN };
  const reportAt = () => (sentAt === null || opts.reportAfter === null ? null : sentAt + (opts.reportAfter ?? 20_000));
  const helloAt = () => {
    const r = reportAt();
    return r === null || opts.reconnectAfter === null ? null : r + (opts.reconnectAfter ?? 5_000);
  };
  let redialed = false;
  let helloed = false;
  // The next hello: the restart's, or the redial's.
  const tick = () => {
    const h = helloAt();
    const restarts = /agent=restarted/.test(report.detail ?? '');
    if (!helloed && h !== null && now >= h && (restarts || redialed)) {
      helloed = true;
      conn = {};
      if (restarts) commit = MAIN;
      capabilities = [...CAPABLE, 'fireworks-menu-v1'];
      log.push('hello');
    }
  };
  const fx = {
    now: () => now,
    sleep: async (ms: number) => { now += ms; tick(); },
    targetCommit: async () => (opts.target === undefined ? MAIN : opts.target),
    agent: () => ({ conn, capabilities, agentCommit: commit, helloReceived: true }),
    settled: () => true,
    begin: async (_id: string, detail: string) => { rows.push({ status: 'updating', detail }); },
    sendUpdate: async (_id: string, target: string) => {
      log.push(`box-update ${target.slice(0, 4)}`);
      if (opts.rpcFails) throw new Error(opts.rpcFails);
      sentAt = now;
    },
    report: async () => {
      const r = reportAt();
      return r !== null && now >= r ? report : null;
    },
    redial: () => { redialed = true; log.push('redial'); },
    finish: async (_id: string, result: { status: string; detail: string }) => { rows.push({ status: result.status, detail: result.detail }); },
  };
  return { fx, log, rows, advance: (ms: number) => { now += ms; }, get redialed() { return redialed; }, get commit() { return commit; }, get capabilities() { return capabilities; } };
}

beforeEach(() => {
  resetClaimUpdateGate();
  vi.mocked(noteClaimUpdated).mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('claimUpdateDecision', () => {
  const facts = { managed: true, capabilities: CAPABLE, agentCommit: OLD, targetCommit: MAIN };
  it('updates a box whose agent runs another commit than the orchestrator', () => {
    expect(claimUpdateDecision(facts)).toEqual({ update: true });
    // An agent that cannot say its commit may be stale: the box's script knows whether there is anything to pull.
    expect(claimUpdateDecision({ ...facts, agentCommit: null })).toEqual({ update: true });
  });
  it('leaves a box already on the orchestrator\'s commit alone', () => {
    expect(claimUpdateDecision({ ...facts, agentCommit: MAIN })).toMatchObject({ update: false, status: 'current' });
  });
  it('skips what it cannot update, saying why', () => {
    expect(claimUpdateDecision({ ...facts, managed: false })).toMatchObject({ update: false, status: 'skipped' });
    expect(claimUpdateDecision({ ...facts, targetCommit: null })).toMatchObject({ update: false, status: 'skipped' });
    expect(claimUpdateDecision({ ...facts, capabilities: ['credentials-v1'] })).toMatchObject({
      update: false, status: 'skipped', reason: 'the agent predates box-update-v1',
    });
  });
});

describe('runClaimUpdate', () => {
  it('updates a stale claimed box and waits for its restarted agent\'s hello', async () => {
    const b = fakeBox({});
    const result = await runClaimUpdate(box, b.fx);
    expect(result).toMatchObject({ status: 'updated', detail: `${OLD.slice(0, 12)} → ${MAIN.slice(0, 12)}` });
    expect(b.log).toEqual([`box-update ${MAIN.slice(0, 4)}`, 'hello']);
    expect(b.rows.map(r => r.status)).toEqual(['updating', 'updated']);
    // The report at 20 s, the hello 5 s later: the claim's wait.
    expect(result.ms).toBe(25_000);
  });

  it('leaves an up-to-date box alone: no RPC, no wait', async () => {
    const b = fakeBox({ commit: MAIN });
    const result = await runClaimUpdate(box, b.fx);
    expect(result).toMatchObject({ status: 'current', ms: 0 });
    expect(b.log).toEqual([]);
    expect(b.rows.map(r => r.status)).toEqual(['current']);
  });

  it('times out without a report, with the reason, never past the bound', async () => {
    const b = fakeBox({ reportAfter: null });
    const result = await runClaimUpdate(box, b.fx);
    expect(result.status).toBe('timed-out');
    expect(result.detail).toBe(`no report from termag-box-update within ${CLAIM_UPDATE_TIMEOUT_MS / 1000} s`);
    expect(result.ms).toBeLessThanOrEqual(CLAIM_UPDATE_TIMEOUT_MS + 1_000);
    expect(b.rows.at(-1)).toEqual({ status: 'timed-out', detail: result.detail });
  });

  it('times out when the restarted agent never says hello', async () => {
    const b = fakeBox({ reconnectAfter: null });
    const result = await runClaimUpdate(box, b.fx);
    expect(result.status).toBe('timed-out');
    expect(result.detail).toMatch(/^updated \(pull=pulled:3 .*\), but the agent did not say hello again within 150 s$/);
  });

  it('fails at once when the RPC fails, with its error', async () => {
    const b = fakeBox({ rpcFails: 'termag-box-update.service is not installed on this box' });
    const result = await runClaimUpdate(box, b.fx);
    expect(result).toMatchObject({ status: 'failed', detail: 'box-update failed: termag-box-update.service is not installed on this box', ms: 0 });
  });

  it('reports a run that failed, and does not wait for a hello that will not come', async () => {
    const b = fakeBox({ report: { outcome: 'failed', detail: 'pull=fetch-failed reconcile=clean deps=unchanged agent=unchanged', commit: OLD } });
    const result = await runClaimUpdate(box, b.fx);
    expect(result).toMatchObject({ status: 'failed', detail: 'failed (pull=fetch-failed reconcile=clean deps=unchanged agent=unchanged)', ms: 20_000 });
    expect(b.redialed).toBe(false);
  });

  it('redials an agent whose scripts were reinstalled without a restart, for the capabilities they carry', async () => {
    const b = fakeBox({ report: { outcome: 'current', detail: 'pull=current reconcile=reconciled deps=unchanged agent=unchanged', commit: MAIN } });
    const result = await runClaimUpdate(box, b.fx);
    expect(b.log).toEqual([`box-update ${MAIN.slice(0, 4)}`, 'redial', 'hello']);
    expect(b.capabilities).toContain('fireworks-menu-v1');
    expect(result).toMatchObject({ status: 'current', ms: 25_000 });
  });
});

describe('startClaimUpdate', () => {
  it('holds a launch on the claimed box until the update is done, after the credential delivery', async () => {
    const b = fakeBox({});
    const order: string[] = [];
    let delivered!: () => void;
    const delivery = new Promise<void>(r => { delivered = r; });
    const started = await startClaimUpdate(box, { unixUsername: 'ada' }, delivery, b.fx);
    // Known, and on the row, before the claim answers.
    expect(started.updating).toBe(true);
    expect(b.rows).toEqual([{ status: 'updating', detail: `${OLD.slice(0, 12)} → ${MAIN.slice(0, 12)}` }]);
    const launch = claimUpdateSettled('box1').then(() => order.push(`launch on ${b.commit.slice(0, 4)}`));
    await new Promise(r => setTimeout(r, 0));
    expect(b.log).toEqual([]); // the RPC waits for the delivery
    order.push('delivered');
    delivered();
    await started.done;
    await launch;
    expect(order).toEqual(['delivered', `launch on ${MAIN.slice(0, 4)}`]);
    expect(noteClaimUpdated).toHaveBeenCalledWith('box1');
  });

  it('lets the launch go on the old commit after a timeout, and logs why', async () => {
    const b = fakeBox({ reportAfter: null });
    const warn = vi.spyOn(console, 'warn');
    const result = await (await startClaimUpdate(box, { unixUsername: 'ada' }, Promise.resolve(), b.fx)).done;
    await claimUpdateSettled('box1');
    expect(result.status).toBe('timed-out');
    expect(b.commit).toBe(OLD);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[CLAIM-UPDATE\] ada-box \(ada\): timed-out after 15\d(\.\d)?s: no report .*; launching on the commit it has$/));
    expect(noteClaimUpdated).not.toHaveBeenCalled();
  });
});

// Bugbot on #1118: a delivery that eats the whole budget must not be followed
// by an update the hold no longer covers.
describe('a credential delivery that outlasts the bound', () => {
  it('sends no update when too little of the bound is left for one, and lets the launch go with the reason', async () => {
    for (const took of [CLAIM_UPDATE_TIMEOUT_MS + 1_000, CLAIM_UPDATE_TIMEOUT_MS - CLAIM_UPDATE_MIN_RUN_MS + 1]) {
      const b = fakeBox({});
      const result = await runClaimUpdate(box, b.fx, { before: Promise.resolve().then(() => b.advance(took)) });
      expect(b.log).toEqual([]);
      expect(result).toMatchObject({ status: 'timed-out', detail: 'the credential delivery left under 60 s of the 150 s bound; no update sent' });
    }
  });

  it('still updates after a delivery that leaves enough of it', async () => {
    const b = fakeBox({});
    const result = await runClaimUpdate(box, b.fx, { before: Promise.resolve().then(() => b.advance(CLAIM_UPDATE_TIMEOUT_MS - CLAIM_UPDATE_MIN_RUN_MS)) });
    expect(b.log[0]).toBe(`box-update ${MAIN.slice(0, 4)}`);
    expect(result.status).toBe('updated');
  });
});

describe('startClaimUpdate on a current box', () => {
  it('says there is no update, and holds nothing', async () => {
    const b = fakeBox({ commit: MAIN });
    const started = await startClaimUpdate(box, { unixUsername: 'ada' }, new Promise(() => {}), b.fx);
    expect(started.updating).toBe(false);
    await expect(started.done).resolves.toMatchObject({ status: 'current' });
  });
});

describe('claimUpdateOpensPolicy', () => {
  const at = new Date('2026-10-31T10:00:00Z');
  it('opens the box\'s update policy while its claim update runs, for a bounded time', () => {
    expect(claimUpdateOpensPolicy({ claimUpdateStatus: 'updating', claimUpdateStartedAt: at }, new Date(at.getTime() + 1_000))).toBe(true);
    expect(claimUpdateOpensPolicy({ claimUpdateStatus: 'updating', claimUpdateStartedAt: at }, new Date(at.getTime() + CLAIM_UPDATE_POLICY_MS))).toBe(false);
  });
  it('stays shut otherwise', () => {
    expect(claimUpdateOpensPolicy({ claimUpdateStatus: 'updated', claimUpdateStartedAt: at }, at)).toBe(false);
    expect(claimUpdateOpensPolicy({ claimUpdateStatus: null, claimUpdateStartedAt: null }, at)).toBe(false);
  });
});

// Bugbot on #1118: an orchestrator that stops mid-update leaves its row `updating`.
describe('expireStaleClaimUpdates', () => {
  it('marks a row left updating past the bound timed-out, and leaves a live one alone', async () => {
    const calls: unknown[] = [];
    const db = { instance: { updateMany: async (args: unknown) => { calls.push(args); return { count: 1 }; } } };
    const now = new Date('2026-10-31T10:00:00Z');
    await expireStaleClaimUpdates(now, db as never);
    expect(calls).toEqual([{
      where: { claimUpdateStatus: 'updating', claimUpdateStartedAt: { lt: new Date(now.getTime() - CLAIM_UPDATE_POLICY_MS) } },
      data: { claimUpdateStatus: 'timed-out', claimUpdateDetail: 'the orchestrator running it stopped before it finished' },
    }]);
  });

  it('never throws', async () => {
    const db = { instance: { updateMany: async () => { throw new Error('db down'); } } };
    await expect(expireStaleClaimUpdates(new Date(), db as never)).resolves.toBeUndefined();
  });
});
