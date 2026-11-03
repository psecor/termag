/**
 * CliPreviewShares (routes/cliPreviewShares.ts) over the browser routes' own
 * handlers (routes/previewShares.ts, routes/users.ts) and their deps. All it
 * adds is the desktop's flag, `desktop-app-enabled`, read for the owner and
 * the project's box as the desktop's workstream routes read it
 * (routes/cliLifecyclePrisma.ts). The owner check, the preview-share flags,
 * the validation and the answers past it are the handlers'.
 */
import type { Instance, User } from '@prisma/client';
import type { CliUser } from '../services/cliStore';
import { desktopAppEnabled } from '../services/desktopAppFlag';
import { searchPeople } from '../services/userSearch';
import type { CliPreviewShares } from './cliPreviewShares';
import {
  createLinkShareFor, createShareFor, defaultPreviewShareRouteDeps, extendShareFor, listSharesFor, revokeShareFor, stackCheckFor,
  type PreviewShareRouteDeps,
} from './previewShares';
import type { RouteResult } from './routeResult';
import { searchPeopleFor, type UsersRouteDeps } from './users';

/** The CLI router's own 404 (routes/cliApi.ts): with the desktop off, the route isn't there. */
const DESKTOP_OFF: RouteResult = {
  status: 404,
  body: { error: 'No such CLI endpoint; this termag CLI may be newer than the orchestrator', code: 'not_found' },
};

export interface CliPreviewShareDeps {
  shares: PreviewShareRouteDeps;
  people: UsersRouteDeps;
  /** desktop-app-enabled for a person and a box, or the person alone where no box is in play (services/desktopAppFlag.ts). */
  desktopOn(user: User, box?: Instance): Promise<boolean>;
}

export function createCliPreviewShares(deps: CliPreviewShareDeps): CliPreviewShares {
  const { shares } = deps;
  // A project of the caller's on a box, with the desktop on for them and it;
  // anything else is the 404 of a route that isn't there, as for a box-less
  // project on the desktop's workstream routes.
  const gated = async (user: CliUser, projectId: string, run: () => Promise<RouteResult>): Promise<RouteResult> => {
    const [project, owner] = await Promise.all([shares.findOwnedProject(user.id, projectId), shares.findUser(user.id)]);
    if (!project?.instance || !owner || !(await deps.desktopOn(owner, project.instance))) return DESKTOP_OFF;
    return run();
  };

  return {
    create: (user, id, body) => gated(user, id, () => createShareFor(shares, user, id, body)),
    list: (user, id) => gated(user, id, () => listSharesFor(shares, user, id)),
    stackCheck: (user, id, query) => gated(user, id, () => stackCheckFor(shares, user, id, query)),
    extend: (user, id, shareId, body) => gated(user, id, () => extendShareFor(shares, user, id, shareId, body)),
    revoke: (user, id, shareId) => gated(user, id, () => revokeShareFor(shares, user, id, shareId)),
    createLink: (user, id, body) => gated(user, id, () => createLinkShareFor(shares, user, id, body)),
    searchPeople: async (user, query) => {
      const person = await shares.findUser(user.id);
      if (!person || !(await deps.desktopOn(person))) return DESKTOP_OFF;
      return searchPeopleFor(deps.people, user.id, query);
    },
  };
}

export const prismaCliPreviewShares = createCliPreviewShares({
  shares: defaultPreviewShareRouteDeps,
  people: { search: searchPeople },
  desktopOn: desktopAppEnabled,
});
