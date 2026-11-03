/** routes/cliWorktime.ts over the database: /api/worktime's own reads. */
import { prisma } from '../db';
import { desktopAppEnabled } from '../services/desktopAppFlag';
import type { CliWorktime } from './cliWorktime';
import { worktimeByProjectFor, worktimeFor } from './worktime';

export function createPrismaCliWorktime(): CliWorktime {
  return {
    async enabled(user) {
      const owner = await prisma.user.findUnique({ where: { id: user.id } });
      return !!owner && await desktopAppEnabled(owner);
    },
    days: (user, days, tz) => worktimeFor(user, String(days), tz),
    projects: (user, days, tz) => worktimeByProjectFor(user, String(days), tz),
  };
}
