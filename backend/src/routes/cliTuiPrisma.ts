/** CliTui over the functions the cookie routes call (routes/projects.ts, routes/sessions.ts). */
import type { CliTui } from './cliTui';
import { captureFor, listProjectsFor } from './projects';
import { listSessionRowsFor } from './sessions';

export const prismaCliTui: CliTui = {
  lobby: (user) => listProjectsFor(user.id),
  sessions: (user, boxId) => listSessionRowsFor(user.id, boxId),
  capture: (user, projectId, role, query) => captureFor(user.id, projectId, role, query, 'cli'),
};
