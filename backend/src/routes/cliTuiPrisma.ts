/** CliTui over the functions the cookie routes call (routes/projects.ts, routes/sessions.ts, routes/status.ts, routes/prs.ts). */
import type { CliTui } from './cliTui';
import { captureFor, listProjectsFor } from './projects';
import { prisma } from '../db';
import { cliHandoffFor, getHandoffFor } from './handoffs';
import { prsLister } from './prs';
import { listSessionRowsFor } from './sessions';
import { heartbeatFor } from './status';

/** The full user row the cookie functions take (a CliUser carries only the identity). */
async function fullUser(id: string): Promise<Express.User> {
  const row = await prisma.user.findUnique({ where: { id } });
  if (!row) throw new Error('User not found');
  return row;
}

// Its own lister over the module's memo, so the TUI and the browser share one GitHub read per user.
const prsFor = prsLister();

export const prismaCliTui: CliTui = {
  lobby: (user) => listProjectsFor(user.id),
  sessions: (user, boxId) => listSessionRowsFor(user.id, boxId),
  capture: (user, projectId, role, query) => captureFor(user.id, projectId, role, query, 'cli'),
  heartbeat: (user, body) => heartbeatFor(user, body),
  prs: (user) => prsFor(user.id),
  handoff: async (user, projectId, body, boxId) => cliHandoffFor(await fullUser(user.id), projectId, body, boxId),
  handoffState: async (user, id) => getHandoffFor(await fullUser(user.id), id),
};
