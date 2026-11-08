/** CliPrs (routes/cliPrs.ts) over the cookie routes' own handlers. */
import { prisma } from '../db';
import type { CliPrs } from './cliPrs';
import { boxDirectory, fullUser } from './cliLifecyclePrisma';
import { bakeNow, prWorkstreamFor, prsWrites } from './prs';

export const prismaCliPrs: CliPrs = {
  writes: prsWrites(),
  bake: userId => bakeNow(userId),
  async prWorkstream(user, params, body) {
    // The desktop's thread is the agent there: nothing idles in tmux beside it.
    const result = await prWorkstreamFor(await fullUser(user), params, body, { provider: 'claude-chat' });
    if (result.status !== 201) return result;
    const created = result.body as { id: string; name: string; branch: string; sessionLaunchWarnings?: string[] };
    const projectId = (body as { projectId: string }).projectId;
    const where = await boxDirectory(user.id, projectId, created.name);
    return {
      status: 201,
      body: {
        workstream: { id: created.id, name: created.name, branch: created.branch, directory: where.directory, exists: where.exists },
        warnings: created.sessionLaunchWarnings ?? [],
      },
    };
  },
};
