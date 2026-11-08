/** routes/cliSessionSearch.ts over the database: /api/sessions/search's own search. */
import { prisma } from '../db';
import type { CliSessionSearch } from './cliSessionSearch';
import { searchFor } from './sessions';

export function createPrismaCliSessionSearch(): CliSessionSearch {
  return {
    search: (user, query, callerId) => searchFor(user.id, query, callerId),
  };
}
