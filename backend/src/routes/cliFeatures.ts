/**
 * What termag turns on for the signed-in person, for the desktop app to show
 * or hide whole features (GET /api/cli/v1/whoami `features`). Each is the
 * flag termag's own server gates the feature on, evaluated for the person.
 */
import { prisma } from '../db';
import { AUTOMATIONS_FLAG } from '../services/automations/scheduler';
import type { CliUser } from '../services/cliStore';
import { boolVariation } from '../services/featureFlags';

export interface CliFeatures {
  /** automations-enabled, which /api/automations gates on: the desktop's Schedule at start. */
  automations: boolean;
}

export async function cliFeaturesFor(user: CliUser): Promise<CliFeatures> {
  const row = await prisma.user.findUnique({ where: { id: user.id } });
  return { automations: row ? await boolVariation(AUTOMATIONS_FLAG, row, false) : false };
}
