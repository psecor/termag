/**
 * The models a workstream's agent can be started on: the
 * third choice after the harness (agent provider) and its model backend.
 * Workflow.model holds the pick; null is the backend's own default.
 *
 * - Claude Code (a pane's or the simple UI chat's) on its default backend:
 *   the opus, sonnet and haiku aliases,
 *   which Claude Code resolves itself (through the gateway's pinned profiles
 *   when the box is on the Bedrock gateway, or the owner's own login). The
 *   same ids and labels as the simple UI's model picker.
 * - Claude Code or pi on fireworks: the fireworks-models flag for the viewer
 *   or box, the same list the gateway's check allows.
 * - Anything else: the default only. pi's own model configuration lives in its
 *   broker, where the orchestrator cannot see it.
 *
 * Pure: the caller reads the flag (services/fireworksFlag.ts) and passes it.
 */

import { CHAT_PROVIDER_ID, MODEL_BACKENDS, SELECTABLE_PROVIDER_IDS, backendsFor } from '../providers/registry';
import { CLAUDE_CHAT_TIERS } from './claudeChatModel';
import { getClaudeGatewayConfig } from './claudeGateway';
import type { FireworksModels } from './fireworksGateway';

export interface ModelChoice {
  // What `--model` gets.
  id: string;
  label: string;
  // Context window in tokens, when known.
  context?: number;
}

const TIER_NAMES: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

/** "Opus 5.5" from the pinned profile us.anthropic.claude-opus-5-5, "Haiku 4.5" from …-haiku-4-5-20251001-v1:0; the bare name without one. */
export function claudeTierLabel(tier: string, profile: string | undefined): string {
  const name = TIER_NAMES[tier] ?? tier;
  const m = profile ? new RegExp(`claude-${tier}-(\\d+)(?:-(\\d))?(?:-\\d{8})?(?:-|$|:)`).exec(profile) : null;
  return m ? `${name} ${m[1]}${m[2] ? `.${m[2]}` : ''}` : name;
}

/** Claude Code, in a pane (claude) or as the simple UI's chat (claude-chat): one set of models and settings. */
export function isClaudeCode(provider: string): boolean {
  return provider === 'claude' || provider === CHAT_PROVIDER_ID;
}

export function modelChoicesFor(
  provider: string, backend: string | null | undefined, fireworks: FireworksModels | null, env: NodeJS.ProcessEnv = process.env,
): ModelChoice[] {
  if (backend === 'fireworks' && (isClaudeCode(provider) || provider === 'pi')) {
    return (fireworks?.models ?? []).map(m => ({ id: m.id, label: m.label, ...(m.context ? { context: m.context } : {}) }));
  }
  if (backend == null && isClaudeCode(provider)) {
    const pins = getClaudeGatewayConfig(env)?.models;
    return CLAUDE_CHAT_TIERS.map(t => ({ id: t, label: claudeTierLabel(t, pins?.[t]) }));
  }
  return [];
}

/** Null (the backend's default) is valid everywhere; anything else must be one of modelChoicesFor. */
export function isModelFor(
  provider: string, backend: string | null | undefined, model: string | null | undefined, fireworks: FireworksModels | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return model == null || modelChoicesFor(provider, backend, fireworks, env).some(m => m.id === model);
}

export interface BackendChoice {
  // null = the harness's default.
  id: string | null;
  label: string;
  models: ModelChoice[];
}

/**
 * What the pickers offer for each selectable harness that has a choice to
 * make (GET /api/providers/models): its default backend with that backend's
 * models, then each backend it can run on that offers this viewer a model. A
 * harness with only its default and no models is left out.
 */
export function backendChoices(fireworks: FireworksModels | null, env: NodeJS.ProcessEnv = process.env): Record<string, BackendChoice[]> {
  const out: Record<string, BackendChoice[]> = {};
  // The chat's own too: the simple UI's model picker reads it.
  for (const provider of [...SELECTABLE_PROVIDER_IDS, CHAT_PROVIDER_ID]) {
    const choices: BackendChoice[] = [{ id: null, label: 'Default', models: modelChoicesFor(provider, null, fireworks, env) }];
    for (const backend of backendsFor(provider)) {
      const models = modelChoicesFor(provider, backend, fireworks, env);
      if (models.length > 0) choices.push({ id: backend, label: MODEL_BACKENDS[backend]?.displayName ?? backend, models });
    }
    if (choices.length > 1 || choices[0].models.length > 0) out[provider] = choices;
  }
  return out;
}
