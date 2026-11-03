/**
 * What an automation's runs start on: the
 * backend and model on its main workstream's agent row, which every run's
 * workstream copies when it is made (routes/workstreams.ts createWorkstreamFor)
 * and the run's launch reads (runner.ts). Create puts the first choice there
 * (createProjectFor's initialAgent); a PATCH carrying `backend` or `model`
 * rewrites it, so the next run starts on it and a run already made keeps its
 * own row. The agent itself (claude-chat) is not a choice: an automation's
 * runs are Claude in the chat runner (projectKindTraits.canSwitchAgent).
 */
import { prisma } from '../../db';
import { isBackendFor } from '../../providers/registry';
import { storedChatChoice, type ChatChoice } from '../claudeChatModel';
import type { FireworksModels } from '../fireworksGateway';
import { isModelFor } from '../modelChoices';

export interface MainAgentRow { id: string; provider: string | null; backend: string | null; model: string | null }

/** Main's agent row, or null on a project that somehow has none. */
export async function mainAgentRow(projectId: string): Promise<MainAgentRow | null> {
  return prisma.workflow.findFirst({
    where: { projectId, type: 'agent', workstream: { name: 'main' } },
    select: { id: true, provider: true, backend: true, model: true },
  });
}

/** Whether a create or PATCH body names a model choice at all. */
export function namesModelChoice(body: Record<string, unknown>): boolean {
  return body.backend !== undefined || body.model !== undefined;
}

/**
 * A PATCH's `backend` and `model` as the row's new choice, validated as
 * createProjectFor validates a create's: the backend must be one the agent
 * can run on (the registry's `backends`), Fireworks only while the owner is
 * offered it (`fireworks`, null when not), and the model one of that
 * backend's (services/modelChoices.ts). Both are read together: no
 * `backend` (or null) is the default backend, whose model is a Claude tier
 * or null for Sonnet; `fireworks` with no model is the flag's default.
 */
export function parseModelChoice(
  body: Record<string, unknown>, provider: string, fireworks: FireworksModels | null,
): { ok: true; choice: ChatChoice } | { ok: false; error: string } {
  const backend = body.backend == null || body.backend === '' ? null : body.backend;
  if (backend !== null && (typeof backend !== 'string' || !isBackendFor(provider, backend))) {
    return { ok: false, error: 'that agent cannot run on that model backend' };
  }
  if (backend === 'fireworks' && !fireworks) return { ok: false, error: 'Fireworks models are not on for you' };
  const model = body.model == null || body.model === '' ? null : body.model;
  if (model !== null && (typeof model !== 'string' || !isModelFor(provider, backend, model, fireworks))) {
    return { ok: false, error: 'that model is not offered for that agent and backend' };
  }
  return { ok: true, choice: { backend, model } };
}

/** The view's `chatProvider`, `backend` and `model`: main's row as the chat reads it. */
export function modelView(row: MainAgentRow | null): { chatProvider: string | null; backend: string | null; model: string | null } {
  if (!row) return { chatProvider: null, backend: null, model: null };
  const choice = storedChatChoice(row.backend, row.model);
  return { chatProvider: row.provider, backend: choice.backend, model: choice.model };
}
