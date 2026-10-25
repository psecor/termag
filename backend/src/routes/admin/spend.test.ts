import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { DEFAULT_CONFIG, DEFAULT_PRICES } from '../../services/admin/spend/config';
import type { Pool } from '../../services/admin/spend/model';
// A sample of the pools an admin would set up, for these tests only; the
// figures are made up.
const EPD = 'Engineering';
const SAMPLE_POOLS: Array<Omit<Pool, 'id'>> = [
  { name: 'Cursor', kind: 'contract', providers: ['cursor'], annualUsd: 120_000, boxes: null, boxCostUsd: null, usersPerBox: null,
    share: 'proportional', shareValue: null, populationLabel: EPD, populationSize: 120, allocation: 'even', startDate: null, endDate: null,
    note: 'Sample contract.', sort: 10 },
  { name: 'Devin', kind: 'contract', providers: ['devin'], annualUsd: 30_000, boxes: null, boxCostUsd: null, usersPerBox: null,
    share: 'proportional', shareValue: null, populationLabel: EPD, populationSize: 120, allocation: 'even', startDate: null, endDate: null,
    note: 'Sample contract.', sort: 20 },
  { name: 'Inference box', kind: 'infra', providers: ['pi'], annualUsd: null, boxes: 1, boxCostUsd: 50_000, usersPerBox: 30,
    share: 'full', shareValue: null, populationLabel: null, populationSize: null, allocation: 'by-tokens', startDate: null, endDate: null,
    note: 'One inference box shared by every model on it.', sort: 30 },
];


// The spend routes' validation and the session-only write.
// The queries are mocked; queries.test.ts covers what they do with the database.

const spendReport = vi.fn(async () => ({ ok: 'report' }));
const spendTrendReport = vi.fn(async (weeks: number) => ({ weeks }));
const getSpendConfig = vi.fn(async () => ({ ok: 'config' }));
const saveSpendConfig = vi.fn(async () => ({ ok: 'saved' }));
vi.mock('../../db', () => ({ prisma: {} }));
vi.mock('../../services/admin/spend/queries', () => ({ spendReport, spendTrendReport, getSpendConfig, saveSpendConfig, TREND_MAX_WEEKS: 52 }));

const { spendRouter } = await import('./spend');

let server: Server;
let base = '';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // x-test-token stands in for requireAdmin accepting an admin token instead of a session.
  app.use((req, _res, next) => { if (req.headers['x-test-token']) (req as { adminTokenId?: string }).adminTokenId = 't1'; next(); });
  app.use(spendRouter());
  server = await new Promise<Server>(r => { const s = app.listen(0, () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => vi.clearAllMocks());

const put = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/spend/config`, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const good = { config: DEFAULT_CONFIG, prices: DEFAULT_PRICES, pools: SAMPLE_POOLS };

describe('PUT /spend/config', () => {
  it('saves a valid model from a session', async () => {
    const r = await put(good);
    expect(r.status).toBe(200);
    expect(saveSpendConfig).toHaveBeenCalledTimes(1);
  });
  it('refuses an admin token', async () => {
    const r = await put(good, { 'x-test-token': '1' });
    expect(r.status).toBe(403);
    expect(saveSpendConfig).not.toHaveBeenCalled();
  });
  it('rejects a bad config, price table or pool list without saving', async () => {
    for (const body of [
      { ...good, config: { ...DEFAULT_CONFIG, loadedCostUsd: -1 } },
      { ...good, prices: [DEFAULT_PRICES[0], DEFAULT_PRICES[0]] },
      { ...good, pools: [{ ...SAMPLE_POOLS[0], id: 'p1' }, { ...SAMPLE_POOLS[1], id: 'p1' }] },
      { ...good, pools: 'cursor' },
    ]) {
      const r = await put(body);
      expect(r.status).toBe(400);
      expect(await r.json()).toHaveProperty('error');
    }
    expect(saveSpendConfig).not.toHaveBeenCalled();
  });
});

describe('GET /spend/trend and /spend/report', () => {
  it('defaults to 12 weeks and bounds weeks to 1..52', async () => {
    expect(await (await fetch(`${base}/spend/trend`)).json()).toEqual({ weeks: 12 });
    for (const w of ['0', '53', 'abc', '2.5']) expect((await fetch(`${base}/spend/trend?weeks=${w}`)).status).toBe(400);
    expect(spendTrendReport).toHaveBeenCalledTimes(1);
  });
  it('rejects a bad range and passes the active toggle', async () => {
    expect((await fetch(`${base}/spend/report?from=2026-10-10&to=2026-10-01`)).status).toBe(400);
    expect((await fetch(`${base}/spend/report?from=2026-10-01&to=2026-10-10&active=1`)).status).toBe(200);
    expect(spendReport).toHaveBeenCalledWith(expect.objectContaining({ days: 10 }), true);
  });
});
