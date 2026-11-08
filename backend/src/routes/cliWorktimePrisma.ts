/** routes/cliWorktime.ts over the database: /api/worktime's own reads. */
import { prisma } from '../db';
import type { CliWorktime } from './cliWorktime';
import { worktimeByProjectFor, worktimeFor } from './worktime';

export function createPrismaCliWorktime(): CliWorktime {
  return {
    days: (user, days, tz) => worktimeFor(user, String(days), tz),
    projects: (user, days, tz) => worktimeByProjectFor(user, String(days), tz),
  };
}
