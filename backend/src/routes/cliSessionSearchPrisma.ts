/** routes/cliSessionSearch.ts over the database: /api/sessions/search's own search. */
import { prisma } from '../db';
import { desktopAppEnabled } from '../services/desktopAppFlag';
import type { CliSessionSearch } from './cliSessionSearch';
import { searchFor } from './sessions';

export function createPrismaCliSessionSearch(): CliSessionSearch {
  return {
    async enabled(user) {
      const owner = await prisma.user.findUnique({ where: { id: user.id } });
      return !!owner && await desktopAppEnabled(owner);
    },
    search: (user, query, callerId) => searchFor(user.id, query, callerId),
  };
}
