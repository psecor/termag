/**
 * Fireworks through the termag gateway. Boxes' pi and
 * Claude Code reach Fireworks' open-weight models at the gateway's /fireworks
 * route with the box's own agent token; the gateway checks that token, and the
 * call's model, with the orchestrator on every call (routes/fireworksAuthz.ts),
 * and puts the shared inference key in its place, so no box holds it.
 *
 * Off unless FIREWORKS_GATEWAY_URL is set, and per user behind
 * fireworks-enabled. Which models are offered and allowed is the
 * fireworks-models flag (parseFireworksModels), not deployment config, so a
 * model change is a flag edit.
 */

export const FIREWORKS_FLAG = 'fireworks-enabled';
export const FIREWORKS_MODELS_FLAG = 'fireworks-models';

// The box takes the fireworks delivery, and has `termag-credentials
// launch-settings` and termag-pi-fireworks to start agents on it.
export const FIREWORKS_CAPABILITY = 'fireworks-v1';

export interface FireworksGatewayConfig {
  // https://<gateway>/fireworks; Fireworks' own paths go under it (/inference/v1/...).
  baseUrl: string;
}

export function getFireworksGatewayConfig(env: NodeJS.ProcessEnv = process.env): FireworksGatewayConfig | null {
  const baseUrl = env.FIREWORKS_GATEWAY_URL?.trim().replace(/\/+$/, '');
  return baseUrl?.startsWith('https://') ? { baseUrl } : null;
}

/** What a box gets (termag-credentials apply fireworks): the gateway's base, nothing secret, no model list. */
export function fireworksDelivery(cfg: FireworksGatewayConfig): Record<string, unknown> {
  return { baseUrl: cfg.baseUrl };
}

// The shape the gateway's Lua filter passes on and the box script accepts:
// a Fireworks model or router id.
export const FIREWORKS_MODEL_ID = /^accounts\/[a-z0-9-]+\/(?:models|routers)\/[A-Za-z0-9._-]+$/;

export interface FireworksModel {
  id: string;
  label: string;
  // Context window in tokens, when the flag gives one.
  context: number | null;
}

/** The fireworks-models flag's value, for one viewer or box. */
export interface FireworksModels {
  models: FireworksModel[];
  // What a launch with no model picked starts on, and Claude Code's small/fast model.
  defaultModel: string;
  fastModel: string;
}

/**
 * The fireworks-models flag value:
 *   { "default": "<id>", "fast": "<id>", "models": [{ "id": "<id>", "label"?: "...", "context"?: <tokens> }] }
 * A model with a bad id is dropped; default is the first model when missing or
 * not listed, fast the default when missing or not listed. Null when nothing
 * usable is left (or the flag is off, its fallback): then no model is allowed.
 */
export function parseFireworksModels(value: unknown): FireworksModels | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { default?: unknown; fast?: unknown; models?: unknown };
  if (!Array.isArray(v.models)) return null;
  const models: FireworksModel[] = [];
  for (const m of v.models as unknown[]) {
    const { id, label, context } = (m ?? {}) as { id?: unknown; label?: unknown; context?: unknown };
    if (typeof id !== 'string' || !FIREWORKS_MODEL_ID.test(id) || models.some(x => x.id === id)) continue;
    const ctx = typeof context === 'number' && Number.isInteger(context) && context >= 1000 && context <= 100_000_000 ? context : null;
    models.push({ id, label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : id.split('/').pop()!, context: ctx });
  }
  if (models.length === 0) return null;
  const listed = (x: unknown) => (typeof x === 'string' && models.some(m => m.id === x) ? x : null);
  const defaultModel = listed(v.default) ?? models[0].id;
  return { models, defaultModel, fastModel: listed(v.fast) ?? defaultModel };
}

/** A model's context window from the list, or null. */
export function fireworksContext(fw: FireworksModels, id: string): number | null {
  return fw.models.find(m => m.id === id)?.context ?? null;
}
