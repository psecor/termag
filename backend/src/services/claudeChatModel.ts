/**
 * The Claude models a simple-UI chat may launch with.
 *
 * Termag's gateway allows one model per family, pinned in CLAUDE_BEDROCK_MODELS
 * and these are the models:
 *   opus   Claude Opus 5.5    us.anthropic.claude-opus-5-5
 *   sonnet Claude Sonnet 5.5  us.anthropic.claude-sonnet-5-5
 *   haiku  Claude Haiku 4.5   us.anthropic.claude-haiku-4-5-20251001-v1:0
 * Claude Code accepts `--model opus|sonnet|haiku` and resolves each alias
 * through ANTHROPIC_DEFAULT_*_MODEL, which the gateway settings set to those
 * profiles. It also accepts the profile id itself.
 *
 * There is no Auto: it was never a router termag owns, only an omitted
 * `--model` flag that let Claude Code fall back to its own default. Every
 * turn now launches on one of the three tiers. A project with no stored
 * tier (never chosen, or made before this) starts on Sonnet
 * (DEFAULT_CLAUDE_CHAT_TIER), resolved here, not written back until a
 * message actually picks one.
 */
import { getClaudeGatewayConfig } from './claudeGateway';
import type { FireworksModels } from './fireworksGateway';

export const CLAUDE_CHAT_TIERS = ['opus', 'sonnet', 'haiku'] as const;
export type ClaudeChatTier = (typeof CLAUDE_CHAT_TIERS)[number];

/** What a session with no stored tier runs on. */
export const DEFAULT_CLAUDE_CHAT_TIER: ClaudeChatTier = 'sonnet';

/** A `--model` value the chat runner may put on `claude -p`: a tier alias or a US Anthropic profile id. */
const LAUNCH_MODEL = /^(opus|sonnet|haiku|us\.anthropic\.claude-[A-Za-z0-9._:-]{1,80})$/;

/** `null`/absent means no tier is stored, not Auto: resolve it with `resolvedChatTier`. */
export function parseClaudeChatModel(value: unknown): { ok: true; model: ClaudeChatTier | null } | { ok: false; error: string } {
  if (value == null || value === '') return { ok: true, model: null };
  if (typeof value === 'string' && (CLAUDE_CHAT_TIERS as readonly string[]).includes(value)) {
    return { ok: true, model: value as ClaudeChatTier };
  }
  return { ok: false, error: 'model must be opus, sonnet or haiku' };
}

/** A stored value (possibly unset or unreadable) as a concrete tier: Sonnet when there is none. */
export function resolvedChatTier(stored: unknown): ClaudeChatTier {
  const parsed = parseClaudeChatModel(stored);
  return parsed.ok && parsed.model ? parsed.model : DEFAULT_CLAUDE_CHAT_TIER;
}

/**
 * The `--model` argument for a chat turn, always a concrete tier: when the
 * gateway is configured, its pinned profile id, which is what the gateway
 * allowlist accepts; otherwise the tier alias, which Claude Code accepts on
 * its own.
 */
export function claudeLaunchModel(tier: ClaudeChatTier, env: NodeJS.ProcessEnv = process.env): string {
  const pinned = getClaudeGatewayConfig(env)?.models[tier];
  return pinned ?? tier;
}

/** What a chat runs on (its Workflow.backend and Workflow.model): null and a tier or null, or a backend and one of its models. */
export interface ChatChoice {
  backend: string | null;
  model: string | null;
}

/** A stored choice as the chat reads it: a default-backend model that is not a tier is Auto. */
export function storedChatChoice(backend: string | null | undefined, model: string | null | undefined): ChatChoice {
  if (backend === 'fireworks') return { backend, model: model ?? null };
  const tier = parseClaudeChatModel(model);
  return { backend: null, model: tier.ok ? tier.model : null };
}

/**
 * What a chat message's turn runs on. A send with neither
 * `model` nor `backend` keeps the chat's stored choice; a send with either
 * switches to it from this turn on (`changed` says the workflow row should be
 * updated). No `backend` is the default backend, whose `model` is a tier;
 * none (or an empty one) keeps the stored tier, or on a chat coming back from
 * Fireworks is no tier, which launches on Sonnet. "auto" is a 400 there. On
 * fireworks, `model` must be one of the sender's fireworks-models
 * (`fireworks`, null when Fireworks is off for them); auto or none is its
 * default. Turns already run are not touched.
 */
export function chatTurnChoice(
  stored: ChatChoice,
  sent: { model?: unknown; backend?: unknown },
  fireworks: FireworksModels | null,
): { ok: true; choice: ChatChoice; changed: boolean } | { ok: false; error: string } {
  if (sent.model === undefined && sent.backend === undefined) return { ok: true, choice: stored, changed: false };
  let choice: ChatChoice;
  if (sent.backend == null || sent.backend === '') {
    const picked = parseClaudeChatModel(sent.model);
    if (!picked.ok) return picked;
    choice = { backend: null, model: picked.model ?? (stored.backend ? null : stored.model) };
  } else if (sent.backend === 'fireworks') {
    if (!fireworks) return { ok: false, error: 'Fireworks models are not on for you' };
    const id = sent.model == null || sent.model === '' || sent.model === 'auto' ? null : sent.model;
    if (id !== null && !fireworks.models.some(m => m.id === id)) return { ok: false, error: 'that model is not one of your Fireworks models' };
    choice = { backend: 'fireworks', model: id as string | null };
  } else {
    return { ok: false, error: 'backend must be fireworks, or omitted for the default' };
  }
  return { ok: true, choice, changed: choice.backend !== stored.backend || choice.model !== stored.model };
}

/** The model string a chat-send may hand the box, or null if it is somehow not one of the three tiers or a pinned profile. */
export function claudeModelArg(model: string | null | undefined): string | null {
  return typeof model === 'string' && LAUNCH_MODEL.test(model) ? model : null;
}
