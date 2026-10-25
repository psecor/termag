import { Router, RequestHandler } from 'express';
import { requireAuthOrAgentToken } from '../middleware/auth';
import { PROVIDERS, SELECTABLE_PROVIDER_IDS } from '../providers/registry';
import { fireworksOfferedTo } from '../services/fireworksFlag';
import { backendChoices } from '../services/modelChoices';

/**
 * GET /api/providers — the agent providers a client may offer in a picker.
 *
 * Serves the SELECTABLE subset of the registry so clients without their own
 * copy (the TUI, scripts) don't hardcode a fourth list. Display-only fields;
 * launch commands and poller config stay server side. Bearer tokens are
 * accepted because the TUI runs on a client token, not a browser session.
 */
export function providersRouter(): Router {
  const router = Router();
  const list: RequestHandler = (_req, res) => {
    res.json({
      providers: SELECTABLE_PROVIDER_IDS.map(id => {
        const p = PROVIDERS[id];
        return { id, displayName: p.displayName, badge: p.badge, color: p.color, usagePrecision: p.usagePrecision };
      }),
    });
  };
  router.get('/', requireAuthOrAgentToken, list);

  // GET /api/providers/models — per harness, the model backends this viewer
  // may pick and each one's models (services/modelChoices.ts).
  // Fireworks only on an orchestrator with the gateway
  // route and while fireworks-enabled is on for them, with their
  // fireworks-models list, which the gateway's check also reads.
  const models: RequestHandler = async (req, res) => {
    res.json({ providers: backendChoices(await fireworksOfferedTo(req.user!)) });
  };
  router.get('/models', requireAuthOrAgentToken, models);
  return router;
}
