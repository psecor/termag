/**
 * What an ask's turn runs on
 * as one string: a Claude tier (`opus`,
 * `sonnet`, `haiku`) on the default backend, or `fireworks:<model id>` on
 * Fireworks. `termag ask --model` sends it, `AgentMessage.model` keeps it, and
 * the inbox's MODEL column shows it, so the backend is always visible next to
 * the model. The thread's chat keeps the same choice as a chat does
 * (Workflow.backend and Workflow.model, `askChoiceOf` / `askModelOf`).
 *
 * Pure: the flag reads and the box's capabilities come in as arguments.
 */
import { ASK_CHAT_CAPABILITY } from './agentMessages';
import { CHAT_BACKEND_CAPABILITY } from './chatRunner';
import { parseClaudeChatModel, type ChatChoice, type ClaudeChatTier } from './claudeChatModel';
import { FIREWORKS_CAPABILITY, type FireworksModels } from './fireworksGateway';

/** The agent's ask-chat.js passes an ask-run's backend (and a person's message's) to the chat runner, which runs an ask's turn on it. */
export const ASK_BACKEND_CAPABILITY = 'ask-backend-v1';

/** The rejection code of every Fireworks ask that cannot run as asked (never run on Claude instead). */
export const FIREWORKS_UNAVAILABLE_CODE = 'fireworks_unavailable';

export const FIREWORKS_PREFIX = 'fireworks:';

/** `fireworks:<id>` as the CLI may send it: a full id, or its last segment (`kimi-k3`), resolved against the flag's list. */
const FIREWORKS_ASKED = /^[A-Za-z0-9._/-]{1,200}$/;

export type AskModel = ClaudeChatTier | `fireworks:${string}` | 'fireworks';

export const ASK_MODEL_ERROR = 'model must be opus, sonnet or haiku, or fireworks:<model> for a Fireworks model (e.g. fireworks:kimi-k3)';

/** A `model` as `POST /ask` takes it: null for none, a tier, `fireworks` (the flag's default) or `fireworks:<id>`. */
export function parseAskModel(value: unknown): { ok: true; model: AskModel | null } | { ok: false; error: string } {
  if (typeof value === 'string' && (value === 'fireworks' || value.startsWith(FIREWORKS_PREFIX))) {
    if (value === 'fireworks') return { ok: true, model: 'fireworks' };
    const id = value.slice(FIREWORKS_PREFIX.length);
    if (!FIREWORKS_ASKED.test(id)) return { ok: false, error: ASK_MODEL_ERROR };
    return { ok: true, model: `fireworks:${id}` };
  }
  const tier = parseClaudeChatModel(value);
  if (!tier.ok) return { ok: false, error: ASK_MODEL_ERROR };
  return { ok: true, model: tier.model };
}

export function isFireworksAskModel(model: string | null | undefined): model is 'fireworks' | `fireworks:${string}` {
  return typeof model === 'string' && (model === 'fireworks' || model.startsWith(FIREWORKS_PREFIX));
}

/** An ask model as a chat's choice: a tier on the default backend, or Fireworks and its id (null: the flag's default). */
export function askChoiceOf(model: string | null | undefined): ChatChoice | null {
  if (model == null || model === '') return null;
  if (model === 'fireworks') return { backend: 'fireworks', model: null };
  if (model.startsWith(FIREWORKS_PREFIX)) return { backend: 'fireworks', model: model.slice(FIREWORKS_PREFIX.length) || null };
  const tier = parseClaudeChatModel(model);
  return tier.ok && tier.model ? { backend: null, model: tier.model } : null;
}

/** A chat's choice as an ask model, the inverse of askChoiceOf: null for no tier on the default backend. */
export function askModelOf(choice: ChatChoice | null | undefined): AskModel | null {
  if (!choice) return null;
  if (choice.backend === 'fireworks') return choice.model ? `fireworks:${choice.model}` : 'fireworks';
  const tier = parseClaudeChatModel(choice.model);
  return tier.ok ? tier.model : null;
}

/** The ids a refusal lists, short: each model's last segment, as `--model fireworks:<it>` takes it. */
function offeredList(fw: FireworksModels): string {
  return fw.models.map(m => `fireworks:${m.id.split('/').pop()}`).join(', ');
}

/**
 * A Fireworks ask model as its full id, against the models listed for the
 * asker and the target box (`fireworks-models`): `fireworks` is the list's
 * default, `fireworks:<id>` must be one of them, named by its full id or — as
 * a short name only — its last segment. A full id is matched exactly: another
 * account's model that ends the same way is a different model, and a thread's
 * stored full id must not pass on it. Refused when none are listed, or with
 * the ones that are.
 */
export function resolveFireworksAskModel(
  model: string,
  fireworks: FireworksModels | null,
  box: string,
): { ok: true; model: `fireworks:${string}`; id: string } | { ok: false; error: string } {
  if (!fireworks || !fireworks.models.length) {
    return { ok: false, error: `fireworks-models lists no Fireworks models for you on ${box}; use a Claude model (--model opus|sonnet|haiku)` };
  }
  const asked = model === 'fireworks' ? null : model.slice(FIREWORKS_PREFIX.length);
  if (asked === null) {
    const id = fireworks.defaultModel;
    return { ok: true, model: `fireworks:${id}`, id };
  }
  const found = fireworks.models.find(m => m.id === asked)
    ?? (asked.includes('/') ? undefined : fireworks.models.find(m => m.id.split('/').pop() === asked));
  if (!found) return { ok: false, error: `${asked} is not one of your Fireworks models on ${box}: ${offeredList(fireworks)}` };
  return { ok: true, model: `fireworks:${found.id}`, id: found.id };
}

/** What decides whether an ask may run on Fireworks, read by the caller. `caps` null: the box isn't connected, so not known yet. */
export interface AskFireworksFacts {
  box: string;
  /** ask-model-choice-enabled for the asker and box: `--model` at all. */
  modelChoiceOn: boolean;
  /** ask-fireworks-enabled for the asker and box. */
  fireworksOn: boolean;
  /** The orchestrator has the gateway's Fireworks route (FIREWORKS_GATEWAY_URL). */
  gatewayConfigured: boolean;
  caps: readonly string[] | null;
}

/**
 * Why this ask cannot run on Fireworks, or null when it can as far as the
 * orchestrator knows (the box still checks its own setup: a box where
 * `termag-credentials` has no Fireworks settings ends the turn with the
 * reason). Each case is a refusal, never a run on Claude instead.
 */
export function askFireworksRefusal(f: AskFireworksFacts): string | null {
  const back = 'or ask on a Claude model (--model opus|sonnet|haiku)';
  if (!f.modelChoiceOn) return `choosing the model is not on for you on ${f.box} yet (flag ask-model-choice-enabled); ask without --model, ${back}`;
  if (!f.fireworksOn) return `asks on Fireworks are not on for you on ${f.box} yet (flag ask-fireworks-enabled); ${back.replace(/^or /, '')}`;
  if (!f.gatewayConfigured) return `this orchestrator has no Fireworks gateway (FIREWORKS_GATEWAY_URL), so no box can run Fireworks; ${back.replace(/^or /, '')}`;
  if (!f.caps) return null;
  const missing = [
    !f.caps.includes(ASK_CHAT_CAPABILITY) && ASK_CHAT_CAPABILITY,
    !f.caps.includes(ASK_BACKEND_CAPABILITY) && ASK_BACKEND_CAPABILITY,
    !f.caps.includes(CHAT_BACKEND_CAPABILITY) && CHAT_BACKEND_CAPABILITY,
    !f.caps.includes(FIREWORKS_CAPABILITY) && FIREWORKS_CAPABILITY,
  ].filter(Boolean);
  if (missing.length) {
    return `${f.box}'s agent cannot run an ask on Fireworks yet (it lacks ${missing.join(', ')}); update the box (termag-box-update), ${back}`;
  }
  return null;
}
