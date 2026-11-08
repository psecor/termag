// The fireworks-models flag for a box's owner and the box, as launches read them,
// and for a viewer alone, as the pickers and the routes that record a choice
// read them.
import { prisma } from '../db';
import { jsonVariation } from './featureFlags';
import type { FlagUser } from './featureFlags';
import { FIREWORKS_MODELS_FLAG, getFireworksGatewayConfig, parseFireworksModels, type FireworksModels } from './fireworksGateway';

const LD_USER_SELECT = { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } as const;

async function boxContext(userId: string, instanceId: string) {
  const [user, instance] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: LD_USER_SELECT }),
    prisma.instance.findUnique({ where: { id: instanceId }, select: { id: true, name: true, kind: true } }),
  ]);
  return user && instance ? { user, instance } : null;
}

/** fireworks-models for the owner and box: the models it may call, or null (none). */
export async function fireworksModelsForBox(userId: string, instanceId: string): Promise<FireworksModels | null> {
  const ctx = await boxContext(userId, instanceId);
  if (!ctx) return null;
  return parseFireworksModels(await jsonVariation(FIREWORKS_MODELS_FLAG, ctx.user, null, ctx.instance));
}

/** fireworks-models for a viewer: the models they may pick, or null (none). */
export async function fireworksModelsForUser(user: FlagUser): Promise<FireworksModels | null> {
  return parseFireworksModels(await jsonVariation(FIREWORKS_MODELS_FLAG, user, null));
}

/**
 * What the pickers offer this viewer and the routes that record a pick allow:
 * their models on an orchestrator with the gateway route, else null. A flag
 * read that fails offers none, so a flag-source failure leaves the defaults.
 */
export async function fireworksOfferedTo(user: FlagUser): Promise<FireworksModels | null> {
  if (!getFireworksGatewayConfig()) return null;
  return fireworksModelsForUser(user).catch((err: Error) => {
    console.warn('[FIREWORKS] flags unreadable; offering no Fireworks models:', err.message);
    return null;
  });
}
