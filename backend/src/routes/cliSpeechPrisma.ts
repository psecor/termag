/** CliSpeech (routes/cliSpeech.ts) over the web build's speech/ folder and the person's desktop-app-enabled. */
import { join } from 'path';
import { prisma } from '../db';
import { boolVariation } from '../services/featureFlags';
import { DESKTOP_APP_FLAG } from '../services/desktopAppFlag';
import type { CliSpeech } from './cliSpeech';

export function prismaCliSpeech(frontendDist: string): CliSpeech {
  return {
    dir: join(frontendDist, 'speech'),
    async desktopOn(cliUser) {
      const user = await prisma.user.findUnique({ where: { id: cliUser.id } });
      return user ? boolVariation(DESKTOP_APP_FLAG, user, false) : false;
    },
  };
}
