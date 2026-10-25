/**
 * Spend under /api/admin/spend. Mounted inside
 * adminRouter, so requireAdmin and the rate limit already ran. Reads work with
 * an admin token; replacing the model needs a signed-in session, like the
 * other admin writes.
 */
import { Router } from 'express';
import { asyncHandler } from '../../middleware/errors';
import { requireAdminSession } from '../../middleware/admin';
import { parseRange } from '../../services/admin/range';
import { parseConfig, parsePools, parsePrices } from '../../services/admin/spend/config';
import { getSpendConfig, saveSpendConfig, spendReport, spendTrendReport, TREND_MAX_WEEKS } from '../../services/admin/spend/queries';

export function spendRouter(): Router {
  const router = Router();

  router.get('/spend/report', asyncHandler(async (req, res) => {
    const range = parseRange(req.query as Record<string, unknown>);
    if ('error' in range) { res.status(400).json({ error: range.error }); return; }
    const active = req.query.active === '1' || req.query.active === 'true';
    res.json(await spendReport(range, active));
  }));

  router.get('/spend/trend', asyncHandler(async (req, res) => {
    const raw = req.query.weeks;
    const weeks = raw === undefined || raw === '' ? 12 : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!(weeks >= 1 && weeks <= TREND_MAX_WEEKS)) { res.status(400).json({ error: `weeks must be 1 to ${TREND_MAX_WEEKS}` }); return; }
    res.json(await spendTrendReport(weeks));
  }));

  router.get('/spend/config', asyncHandler(async (_req, res) => { res.json(await getSpendConfig()); }));

  // Replace the whole model: settings, the price table and the pools.
  router.put('/spend/config', requireAdminSession, asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const config = parseConfig(body.config);
    if ('error' in config) { res.status(400).json({ error: config.error }); return; }
    const prices = parsePrices(body.prices);
    if ('error' in prices) { res.status(400).json({ error: prices.error }); return; }
    const pools = parsePools(body.pools);
    if ('error' in pools) { res.status(400).json({ error: pools.error }); return; }
    res.json(await saveSpendConfig({ config, prices, pools }));
  }));

  return router;
}
