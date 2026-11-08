/**
 * CliPreviewLinks (routes/cliPreviewLinks.ts) over the browser routes'
 * service (services/previewLinks.ts): the project id rides in the body or the
 * query, since the CLI's routes aren't under /projects/:id.
 */
import {
  extendPreviewLinkFor, listOwnPreviewLinksFor, listPreviewLinksFor, publishPreviewLinkFor, removePreviewLinkViewerFor, revokePreviewLinkFor,
  type PreviewLinkCaller,
} from '../services/previewLinks';
import {
  confirmationStatusFor, defaultConfirmationDeps, extendFromBoxFor, publishFromBoxFor, type ConfirmationDeps,
} from '../services/previewLinkConfirmations';
import type { CliUser } from '../services/cliStore';
import type { CliPreviewLinks } from './cliPreviewLinks';
import type { RouteResult } from './routeResult';

const PROJECT_ID = /^[a-z0-9]{8,40}$/;
const badProject: RouteResult = { status: 400, body: { error: 'project must be a project id', code: 'invalid_request' } };

export function createCliPreviewLinks(confirm: ConfirmationDeps): CliPreviewLinks {
  const deps = confirm.links;
  const caller = (u: CliUser): PreviewLinkCaller => ({ id: u.id, googleEmail: u.googleEmail });
  return {
    list: async (user, query) => {
      const project = (query as { project?: unknown } | null)?.project;
      if (project === undefined) return listOwnPreviewLinksFor(deps, caller(user));
      if (typeof project !== 'string' || !PROJECT_ID.test(project)) return badProject;
      return listPreviewLinksFor(deps, caller(user), project);
    },
    publish: async (user, body, origin) => {
      const project = (body as { project?: unknown } | null)?.project;
      if (typeof project !== 'string' || !PROJECT_ID.test(project)) return badProject;
      // A sign-in made on a box: wider audiences wait for a confirm in the browser.
      if (origin.issuedOnBoxId) return publishFromBoxFor(confirm, caller(user), project, body, origin.issuedOnBoxId);
      return publishPreviewLinkFor(deps, caller(user), project, body);
    },
    extend: (user, linkId, body, origin) => (origin.issuedOnBoxId
      ? extendFromBoxFor(confirm, caller(user), linkId, body, origin.issuedOnBoxId)
      : extendPreviewLinkFor(deps, caller(user), linkId, body)),
    revoke: (user, linkId) => revokePreviewLinkFor(deps, caller(user), linkId),
    removeViewer: (user, linkId, userId) => removePreviewLinkViewerFor(deps, caller(user), linkId, userId),
    confirmation: (user, id) => confirmationStatusFor(confirm, caller(user), id),
  };
}

export const prismaCliPreviewLinks = createCliPreviewLinks(defaultConfirmationDeps);

