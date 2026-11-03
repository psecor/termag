import { prisma } from '../db';
import type { CliDotfiles } from '../routes/cliDotfiles';
import { boolVariation } from './featureFlags';
import { NEW_BOX_DOTFILES_FLAG } from './newBoxDotfiles';

/** The same read and write as web Settings (GET /auth/me, PUT /auth/me/preferences). */
export const prismaCliDotfiles: CliDotfiles = {
  async read(userId) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return {
      dotfilesRepoUrl: user.dotfilesRepoUrl,
      newBoxes: await boolVariation(NEW_BOX_DOTFILES_FLAG, user, false),
    };
  },
  async save(userId, url) {
    await prisma.user.update({ where: { id: userId }, data: { dotfilesRepoUrl: url } });
  },
};
