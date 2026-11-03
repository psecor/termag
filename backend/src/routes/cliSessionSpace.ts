/**
 * GET /api/cli/v1/session-space?project=<name>&workstream=<name>: the space a
 * session on this box loads memory from (services/chatSpace.ts
 * turnMemorySpace), for the box's memory hooks (cli/src/spaceMemory.ts). A T3
 * thread's Claude runs them in its checkout, whose path names the project and
 * the workstream, so each desktop session loads its own space the way a web
 * chat's turns do, not the box's first grant.
 *
 *   200 { "space": "team" }  the session's space, which the box can load
 *   200 { "space": null }    No space, or one the box can't reach: nothing loads
 *   404 not_found            no such project or workstream on this box
 *
 * A box's own token only, for a project on that box and of its owner: a
 * device sign-in has no checkout to name (403). Like a chat's first listing,
 * the first ask fixes an unfixed session to its box's first grant.
 */
import type { RequestHandler, Response, Router } from 'express';
import { prisma } from '../db';
import { asyncHandler } from '../middleware/errors';
import { turnMemorySpace } from '../services/chatSpace';
import type { CliUser } from '../services/cliStore';
import type { CliAuth } from './cliApi';

export interface CliSessionSpace {
  /** The session's space (null: none to load), or null when the box has no such project or workstream. */
  sessionSpace(user: CliUser, boxId: string, project: string, workstream: string): Promise<{ space: string | null } | null>;
}

/** A project's and a workstream's names as termag makes them (routes/projects.ts, routes/workstreams.ts). */
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const BOX_ONLY = {
  error: "A session's space is asked by the box it runs on; a device sign-in has no session to name",
  code: 'forbidden',
};
const NOT_FOUND = { error: 'No such project or workstream on this box', code: 'not_found' };

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

export function mountCliSessionSpaceRoutes(router: Router, deps: CliSessionSpace, bearer: RequestHandler): void {
  router.get('/session-space', bearer, asyncHandler(async (req, res) => {
    const { user, credential } = cliAuth(res);
    if (credential.kind !== 'box' || !credential.boxId) { res.status(403).json(BOX_ONLY); return; }
    const project = typeof req.query.project === 'string' ? req.query.project : '';
    const workstream = typeof req.query.workstream === 'string' && req.query.workstream ? req.query.workstream : 'main';
    if (!NAME_RE.test(project) || !NAME_RE.test(workstream)) {
      res.status(400).json({ error: 'project and workstream must be names', code: 'invalid_request' });
      return;
    }
    const found = await deps.sessionSpace(user, credential.boxId, project, workstream);
    if (!found) { res.status(404).json(NOT_FOUND); return; }
    res.json(found);
  }));
}

export const prismaCliSessionSpace: CliSessionSpace = {
  async sessionSpace(user, boxId, project, workstream) {
    const row = await prisma.workstream.findFirst({
      where: { name: workstream, project: { name: project, userId: user.id, instanceId: boxId } },
      select: { id: true },
    });
    if (!row) return null;
    const space = await turnMemorySpace(row.id);
    // Unreadable: a 500, so the hook falls back to the box's default rather than load nothing.
    if (space === undefined) throw new Error(`the chat space of ${project}@${workstream} is unreadable`);
    return { space };
  },
};
