import { prisma } from '../db';
import { recordAudit } from '../middleware/admin';
import type { CliAdminBox } from '../routes/cliAdminBox';
import { prismaCliStore } from './cliStorePrisma';

/** routes/cliAdminBox.ts's reads, against the database. */
export const prismaCliAdminBox: CliAdminBox = {
  isAdmin: userId => prismaCliStore.isAdmin!(userId),
  async boxHasSharedProject(boxId) {
    // Any project on the box, archived ones included.
    const share = await prisma.projectShare.findFirst({ where: { project: { instanceId: boxId } }, select: { id: true } });
    return share !== null;
  },
  audit: recordAudit,
};
