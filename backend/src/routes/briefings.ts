import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { requireAuth, requireAuthOrAgentToken } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { buildLedger } from '../services/briefing/ledger';
import { DismissInputError, parseDismissInput, prismaDismissals, type DismissalStore } from '../services/briefing/dismissals';
import { LEDGER_CACHE_LIVE_TTL_MS, LEDGER_CACHE_TTL_MS, cachedLedger, ledgerCacheKey } from '../services/briefing/ledgerCache';
import { ledgerIndex, ledgerSession } from '../services/briefing/ledgerView';
import { briefingJob } from '../services/briefing/prompt';
import { parseResultBody, recordResult, rememberLedger, runningRowForBox, startBriefing } from '../services/briefing/runner';
import { parseScheduleBody, readSchedule } from '../services/briefing/schedule';
import { deliverBriefingDm } from '../services/briefing/slack';
import { latestFor, listFor, previousDone, viewById } from '../services/briefing/store';
import { resolveWindow, safeTimeZone } from '../services/briefing/window';
import type { BriefingWindow, Ledger } from '../services/briefing/types';

// The daily briefing:
//
//   GET  /ledger          the ledger's index; ?projectId=&workstream= one session in full;
//                         ?view=full all of it (cookie or agent token; MCP activity_ledger)
//   GET  /latest          newest done briefing + a newer unfinished one + the user's
//                         Done/Defer marks (MCP latest_briefing)
//   PUT  /dismissals      Done or Defer a day on an item ({ key, action })     (cookie)
//   DELETE /dismissals?key=  bring it back
//   GET  /                history
//   GET  /:id             one briefing
//   POST /run             start one now                           (cookie)
//   GET  /schedule        the opt-in schedule                     (cookie)
//   PUT  /schedule
//   GET  /:id/job         the review's instructions               (box token of the box it runs on)
//   POST /:id/result      the review's answer                     (same)

const LEDGER_MIN_INTERVAL_MS = 5_000;
const ledgerCalls = new Map<string, number>();

/** Above parseResultBody's 200k-character cap, so that check is the one that answers. */
export const BRIEFING_RESULT_BODY_LIMIT = '1mb';

/** Tests. */
export function clearLedgerCalls(): void {
  ledgerCalls.clear();
}

class LedgerRateLimited extends Error {}

const queryString = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** Forget callers whose last ledger is past the interval, so the map stays small. */
export function pruneLedgerCalls(calls: Map<string, number>, now: number): void {
  for (const [k, at] of calls) if (now - at >= LEDGER_MIN_INTERVAL_MS) calls.delete(k);
}

export function briefingsRouter(dismissals: DismissalStore = prismaDismissals): Router {
  const router = Router();

  const ledger: RequestHandler = async (req, res) => {
    const user = req.user!;
    const briefingId = queryString(req.query.briefing);
    let window: BriefingWindow;
    if (briefingId) {
      const row = await prisma.briefing.findFirst({ where: { id: briefingId, userId: user.id } });
      if (!row) { res.status(404).json({ error: 'No such briefing' }); return; }
      window = { since: row.since.toISOString(), until: row.until.toISOString(), tz: row.tz, label: row.windowLabel, basis: 'explicit', previousBriefingAt: null };
    } else {
      const sinceRaw = queryString(req.query.since);
      const since = sinceRaw ? new Date(sinceRaw) : null;
      if (since && Number.isNaN(since.getTime())) { res.status(400).json({ error: 'since must be an ISO date-time' }); return; }
      const tz = safeTimeZone(queryString(req.query.tz) ?? readSchedule(user.briefingSchedule).timezone);
      window = resolveWindow({ now: new Date(), tz, previous: await previousDone(user.id), since });
    }

    // The index and each session come from one cached build; only a build
    // fans out to the boxes, so only a build is rate limited.
    let full: Ledger;
    try {
      const build = async () => {
        const l = await buildLedger(user, window);
        if (briefingId) await rememberLedger(user.id, briefingId, l);
        return l;
      };
      full = await cachedLedger(ledgerCacheKey(user.id, window, briefingId), build, () => {
        const rateKey = `${user.id}:${req.agentInstanceId ?? 'browser'}`;
        const now = Date.now();
        if (now - (ledgerCalls.get(rateKey) ?? 0) < LEDGER_MIN_INTERVAL_MS) throw new LedgerRateLimited();
        pruneLedgerCalls(ledgerCalls, now);
        ledgerCalls.set(rateKey, now);
      }, Date.now(), briefingId ? LEDGER_CACHE_TTL_MS : LEDGER_CACHE_LIVE_TTL_MS);
    } catch (err) {
      if (!(err instanceof LedgerRateLimited)) throw err;
      res.status(429).json({ error: 'Rate limited (one ledger per caller every 5 s)' });
      return;
    }

    const projectId = queryString(req.query.projectId);
    if (projectId) {
      const one = ledgerSession(full, projectId, queryString(req.query.workstream));
      if (!one) { res.status(404).json({ error: 'That session is not in this window\'s ledger' }); return; }
      res.json(one);
    } else if (req.query.view === 'full') {
      res.json(full);
    } else {
      res.json(ledgerIndex(full));
    }
  };

  const latest: RequestHandler = async (req, res) => {
    const userId = req.user!.id;
    // A failed read of the marks still answers the briefing, with nothing hidden.
    const [views, marks] = await Promise.all([latestFor(userId), dismissals.list(userId, new Date()).catch(() => [])]);
    res.json({ ...views, dismissals: marks });
  };

  const dismiss: RequestHandler = async (req, res) => {
    let input;
    try { input = parseDismissInput(req.body); } catch (err) {
      if (err instanceof DismissInputError) { res.status(400).json({ error: err.message }); return; }
      throw err;
    }
    res.json(await dismissals.dismiss(req.user!.id, input, new Date()));
  };

  const restore: RequestHandler = async (req, res) => {
    const key = queryString(req.query.key);
    if (!key || key.length > 300) { res.status(400).json({ error: 'key is required' }); return; }
    await dismissals.restore(req.user!.id, key);
    res.status(204).end();
  };

  const list: RequestHandler = async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? ''), 10) || 20));
    res.json({ briefings: await listFor(req.user!.id, limit) });
  };

  const one: RequestHandler = async (req, res) => {
    const view = await viewById(req.user!.id, req.params.id);
    if (!view) { res.status(404).json({ error: 'No such briefing' }); return; }
    res.json(view);
  };

  const run: RequestHandler = async (req, res) => {
    const user = req.user!;
    const tz = safeTimeZone((req.body as { tz?: unknown } | undefined)?.tz ?? readSchedule(user.briefingSchedule).timezone);
    const out = await startBriefing({ user, trigger: 'manual', tz });
    if (out.kind === 'duplicate') { res.status(409).json({ error: 'A briefing is already being created' }); return; }
    const view = await viewById(user.id, out.id);
    res.status(out.kind === 'already_running' ? 200 : 202).json(view);
  };

  const getSchedule: RequestHandler = async (req, res) => {
    res.json(readSchedule(req.user!.briefingSchedule));
  };

  const putSchedule: RequestHandler = async (req, res) => {
    const parsed = parseScheduleBody(req.body);
    if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return; }
    await prisma.user.update({ where: { id: req.user!.id }, data: { briefingSchedule: parsed as object } });
    res.json(parsed);
  };

  // Box routes: the token must belong to the box the run was placed on.
  const job: RequestHandler = async (req, res) => {
    const row = await runningRowForBox(req.user!.id, req.agentInstanceId, req.params.id);
    if (!row) { res.status(404).json({ error: 'No such briefing for this box' }); return; }
    if (row.status !== 'running') { res.status(409).json({ error: `Briefing is ${row.status}` }); return; }
    res.json(briefingJob(row.id));
  };

  const result: RequestHandler = async (req, res) => {
    const body = parseResultBody(req.body);
    if ('error' in body) { res.status(400).json({ error: body.error }); return; }
    const out = await recordResult(req.user!, req.agentInstanceId, req.params.id, body, deliverBriefingDm);
    if (out.status === 204) res.status(204).end();
    else if (out.status === 400) res.status(400).json({ error: out.error });
    else res.status(out.status).json({ error: out.status === 404 ? 'No such briefing for this box' : 'Briefing already finished' });
  };

  router.get('/ledger', requireAuthOrAgentToken, asyncHandler(ledger));
  router.get('/latest', requireAuthOrAgentToken, asyncHandler(latest));
  router.get('/schedule', requireAuth, asyncHandler(getSchedule));
  router.put('/schedule', requireAuth, asyncHandler(putSchedule));
  router.put('/dismissals', requireAuth, asyncHandler(dismiss));
  router.delete('/dismissals', requireAuth, asyncHandler(restore));
  router.post('/run', requireAuth, asyncHandler(run));
  router.get('/', requireAuth, asyncHandler(list));
  router.get('/:id/job', requireAuthOrAgentToken, asyncHandler(job));
  router.post('/:id/result', requireAuthOrAgentToken, asyncHandler(result));
  router.get('/:id', requireAuth, asyncHandler(one));
  return router;
}
