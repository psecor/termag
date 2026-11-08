/**
 * routes/cliBriefings.ts over the database: the same services as
 * /api/briefings (routes/briefings.ts), for the person a device sign-in names.
 */
import { prisma } from '../db';
import { prismaDismissals, type DismissalStore } from '../services/briefing/dismissals';
import { startBriefing } from '../services/briefing/runner';
import { readSchedule } from '../services/briefing/schedule';
import { latestFor, listFor, viewById } from '../services/briefing/store';
import { safeTimeZone } from '../services/briefing/window';
import type { CliBriefings } from './cliBriefings';

export function createPrismaCliBriefings(dismissals: DismissalStore = prismaDismissals): CliBriefings {
  return {
    async latest(user) {
      // A failed read of the marks still answers the briefing, with nothing hidden.
      const [views, marks] = await Promise.all([latestFor(user.id), dismissals.list(user.id, new Date()).catch(() => [])]);
      return { ...views, dismissals: marks };
    },
    dismiss: (user, input) => dismissals.dismiss(user.id, input, new Date()),
    restore: (user, key) => dismissals.restore(user.id, key),
    async run(user, tzRaw) {
      const owner = await prisma.user.findUnique({ where: { id: user.id }, select: { briefingSchedule: true } });
      const tz = safeTimeZone(tzRaw ?? readSchedule(owner?.briefingSchedule).timezone);
      const out = await startBriefing({ user, trigger: 'manual', tz });
      if (out.kind === 'duplicate') return { status: 409, body: { error: 'A briefing is already being created', code: 'conflict' } };
      return { status: out.kind === 'already_running' ? 200 : 202, body: await viewById(user.id, out.id) };
    },
    list: async (user, limit) => ({ briefings: await listFor(user.id, limit) }),
    one: (user, id) => viewById(user.id, id),
    async schedule(user) {
      const owner = await prisma.user.findUnique({ where: { id: user.id }, select: { briefingSchedule: true } });
      return readSchedule(owner?.briefingSchedule);
    },
    async saveSchedule(user, schedule) {
      await prisma.user.update({ where: { id: user.id }, data: { briefingSchedule: schedule as object } });
      return schedule;
    },
  };
}
