/**
 * What termag turns on for the signed-in person, for the desktop app to show
 * or hide whole features (GET /api/cli/v1/whoami `features`). Each is the
 * flag termag's own server gates the feature on, evaluated for the person.
 */
import { prisma } from '../db';
import { AUTOMATIONS_FLAG } from '../services/automations/scheduler';
import type { CliUser } from '../services/cliStore';
import { desktopLiveChatEnabled } from '../services/desktopAppFlag';
import { boolVariation } from '../services/featureFlags';

export interface CliFeatures {
  /** automations-enabled, which /api/automations gates on: the desktop's Schedule at start. */
  automations: boolean;
  /** desktop-live-chat-enabled, which the CLI's chat send and interrupt gate on (routes/cliChats.ts). */
  liveChat: boolean;
}

export async function cliFeaturesFor(user: CliUser): Promise<CliFeatures> {
  const row = await prisma.user.findUnique({ where: { id: user.id } });
  if (!row) return { automations: false, liveChat: false };
  const [automations, liveChat] = await Promise.all([
    boolVariation(AUTOMATIONS_FLAG, row, false),
    desktopLiveChatEnabled(row),
  ]);
  return { automations, liveChat };
}
