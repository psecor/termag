/**
 * Direct browser links to space files, mounted by
 * index.ts at `/termag/files` behind the cookie stack:
 *
 *   GET /termag/files/<space>/<path...>
 *
 * A signed-in viewer (or better) of the space gets a 302 to a five-minute
 * presigned S3 GET (fileLinkResponseHeaders decides inline or attachment).
 * With spaces-html-links-enabled, an HTML file of up to HTML_LINK_MAX_BYTES
 * is instead read here and answered as a sandboxed page (spaceLinks.ts).
 * Someone not signed in is sent through the normal sign-in and back here
 * (auth/postLoginReturn.ts); in okta mode the ALB's authenticate-oidc default
 * action has already done that, so a request with no user is a plain 401.
 *
 * The spaces-enabled flag off, an unknown space, no role in it, a malformed
 * path and a missing file are all the same 404, so a link can't be used to
 * probe for space or file names. Only people follow links: there is no
 * bearer path here, box agents use `termag space get`.
 */
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/errors';
import { takeToken, type Bucket } from '../middleware/rateLimit';
import { resolveSpaceAccess, roleAtLeast, type SpaceAccess } from '../services/spaces/spaceAccess';
import { SpacesUnavailableError } from '../services/spaces/spaceConfig';
import { HTML_LINK_HEADERS, HTML_LINK_MAX_BYTES, fileLinkResponseHeaders, isHtmlLink, parseSpaceFileLink } from '../services/spaces/spaceLinks';
import type { PresignerIdentity, SpaceObjects } from '../services/spaces/spaceObjects';
import { SpacePathError, normalizeFilePath, objectKey } from '../services/spaces/spacePaths';
import type { SpaceRecord, SpaceStore } from '../services/spaces/spaceStore';
import { PRESIGNS_PER_MINUTE } from './spaces';

export interface SpaceFilesRouterDeps {
  store: Pick<SpaceStore, 'findSpace' | 'memberRoles' | 'grantedBoxIds' | 'claimInvites' | 'recordEvent' | 'ldUser'>;
  objects: (identity: PresignerIdentity) => Promise<SpaceObjects>;
  /** The spaces-enabled flag for this user. */
  enabled: (userId: string) => Promise<boolean>;
  /** The spaces-html-links-enabled flag for this user; unset is off. */
  htmlEnabled?: (userId: string) => Promise<boolean>;
  /** The signed-in user, or null. */
  userId: (req: Request) => string | null;
  /**
   * Remembers `req.originalUrl` for after sign-in and returns where to send
   * the browser to sign in, or null if it couldn't be remembered. Unset in
   * okta mode, where the ALB signs people in before they get here.
   */
  signIn?: (req: Request) => Promise<string | null>;
  now?: () => number;
}

function plain(res: Response, status: number, text: string): void {
  res.status(status).type('text/plain').send(text);
}

export function spaceFilesRouter(deps: SpaceFilesRouterDeps): Router {
  const router = Router();
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  async function accessOf(userId: string, ref: string): Promise<{ space: SpaceRecord; access: SpaceAccess } | null> {
    const attempt = async () => {
      const space = await store.findSpace(ref);
      if (!space) return null;
      const [members, grantedBoxIds] = await Promise.all([store.memberRoles(space.id), store.grantedBoxIds(space.id)]);
      const access = resolveSpaceAccess({ kind: 'user', userId }, { space, members, grantedBoxIds });
      return access ? { space, access } : null;
    };
    return (await attempt()) ?? (await store.claimInvites(userId) > 0 ? attempt() : null);
  }

  // `use`, not `get('*')`: a route param would be decoded by express, which
  // answers a malformed escape with its own 400 page instead of our 404.
  router.use(asyncHandler(async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return; }
    res.set('Cache-Control', 'no-store');
    const userId = deps.userId(req);
    if (!userId) {
      const login = deps.signIn ? await deps.signIn(req) : null;
      if (login) { res.redirect(302, login); return; }
      plain(res, 401, 'Sign in to termag first, then open this link again.');
      return;
    }
    const notFound = () => plain(res, 404, 'Not found');
    if (!await deps.enabled(userId)) { notFound(); return; }
    const link = parseSpaceFileLink(req.path);
    if (!link) { notFound(); return; }
    try {
      const path = normalizeFilePath(link.path);
      const found = await accessOf(userId, link.space);
      if (!found || !roleAtLeast(found.access.role, 'viewer')) { notFound(); return; }
      const key = objectKey(found.space.id, path);
      if (!takeToken(buckets, userId, PRESIGNS_PER_MINUTE, PRESIGNS_PER_MINUTE / 60, now())) {
        plain(res, 429, 'Too many requests; slow down');
        return;
      }
      const user = await store.ldUser(userId);
      const objects = await deps.objects({ kind: 'user', userId, email: user?.googleEmail ?? null });
      const head = await objects.head(key);
      if (!head) { notFound(); return; }
      const recordGet = (bytes: number) => store.recordEvent({
        spaceId: found.space.id, actorUserId: userId, actorInstanceId: null, via: null, action: 'file.get', path, bytes,
      });
      res.set('Referrer-Policy', 'no-referrer');
      if (isHtmlLink(path) && head.size <= HTML_LINK_MAX_BYTES && await deps.htmlEnabled?.(userId)) {
        // Bounded read: the file may have grown past the cap since the HEAD.
        const body = await objects.read(key, HTML_LINK_MAX_BYTES);
        if (!body) { notFound(); return; }
        if (body.length <= HTML_LINK_MAX_BYTES) {
          await recordGet(body.length);
          res.status(200).set(HTML_LINK_HEADERS).send(body);
          return;
        }
      }
      const { url } = await objects.presignGet(key, fileLinkResponseHeaders(path));
      await recordGet(head.size);
      res.redirect(302, url);
    } catch (err) {
      if (err instanceof SpacePathError) { notFound(); return; }
      if (err instanceof SpacesUnavailableError) { plain(res, 503, 'Spaces storage is unavailable right now'); return; }
      throw err;
    }
  }));

  return router;
}
