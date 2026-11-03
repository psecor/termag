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
 * Someone with no role in the space (or without spaces-enabled) still gets
 * the file when it is shared with termag (services/spaces/sharedFiles.ts),
 * with a presigned URL that works for SHARED_READ_TTL_S, logged as file.get
 * via 'share'. An unknown space, no role and no share, a malformed path and
 * a missing file are all the same 404, so a link can't be used to probe for
 * space or file names. Only people follow links: there is no bearer path
 * here, box agents use `termag space get`.
 *
 * A link to a folder, `<space>/<dir>/` (or `<space>/` for the root), or a
 * path with no file that is a folder, sends a viewer to the space's explorer
 * with that folder shown (spaceFolderPagePath), not a 404, where the simple
 * UI has that page for them (simple-ui-enabled and
 * simple-ui-side-panel-enabled; otherwise still a 404). Only a member:
 * a share is of one file, so for anyone else a folder is the same 404.
 */
import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/errors';
import { takeToken, type Bucket } from '../middleware/rateLimit';
import { resolveSpaceAccess, roleAtLeast, type SpaceAccess } from '../services/spaces/spaceAccess';
import { SpacesUnavailableError } from '../services/spaces/spaceConfig';
import { HTML_LINK_HEADERS, HTML_LINK_MAX_BYTES, fileLinkResponseHeaders, isHtmlLink, parseSpaceFileLink } from '../services/spaces/spaceLinks';
import type { PresignerIdentity, SpaceObjects } from '../services/spaces/spaceObjects';
import { SpacePathError, downloadResponseHeaders, normalizeFilePath, normalizePrefix, objectKey, viewResponseHeaders } from '../services/spaces/spacePaths';
import type { SpaceRecord, SpaceStore } from '../services/spaces/spaceStore';
import { SHARED_READ_TTL_S, resolveSharedFile } from '../services/spaces/sharedFiles';
import { PRESIGNS_PER_MINUTE, shareView } from './spaces';

export interface SpaceFilesRouterDeps {
  store: Pick<SpaceStore, 'findSpace' | 'memberRoles' | 'grantedBoxIds' | 'claimInvites' | 'recordEvent' | 'ldUser' | 'fileShare'>;
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
  /**
   * Whether this email still signs in to termag (ALLOWED_USERS), for a
   * non-member's read of a shared file; unset, shared files are not served.
   */
  viewerAllowed?: (email: string) => boolean;
  /**
   * The page that shows folder `dir` ('' or ending in `/`) of `space` to this
   * user, or null where they have none (the simple UI's Files is off for
   * them); unset or null, a folder's link is a 404.
   */
  folderPage?: (userId: string, space: string, dir: string) => Promise<string | null>;
  /** The file-sharing kill switch; defaults to SPACE_FILE_SHARING_DISABLED. */
  sharingDisabled?: () => boolean;
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

  async function sharedOf(userId: string, ref: string, path: string): Promise<{ space: SpaceRecord; shared: true } | null> {
    if (!deps.viewerAllowed) return null;
    const hit = await resolveSharedFile({ store, viewerAllowed: deps.viewerAllowed, disabled: deps.sharingDisabled }, userId, ref, path);
    return hit ? { space: hit.space, shared: true } : null;
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
    const link = parseSpaceFileLink(req.path);
    if (!link) { notFound(); return; }
    try {
      const folderLink = link.path === '' || link.path.endsWith('/');
      const path = folderLink ? null : normalizeFilePath(link.path);
      const member = await deps.enabled(userId) ? await accessOf(userId, link.space) : null;
      const viewer = member && roleAtLeast(member.access.role, 'viewer') ? member.space : null;
      // A member's link to a folder, or to a path that is one: its explorer. Never a share's.
      const objectsOf = async () => {
        const user = await store.ldUser(userId);
        return deps.objects({ kind: 'user', userId, email: user?.googleEmail ?? null });
      };
      const toFolder = async (dir: string, objects?: SpaceObjects): Promise<boolean> => {
        if (!viewer || !deps.folderPage) return false;
        objects ??= await objectsOf();
        const listed = dir === '' ? null : await objects.list(objectKey(viewer.id, dir), { max: 1 });
        if (listed && listed.prefixes.length === 0 && listed.files.length === 0) return false;
        const page = await deps.folderPage(userId, viewer.name, dir);
        if (!page) return false;
        res.redirect(302, page);
        return true;
      };
      if (path == null) {
        if (!await toFolder(normalizePrefix(link.path))) notFound();
        return;
      }
      const found = viewer
        ? { space: viewer, shared: false }
        : await sharedOf(userId, link.space, path);
      if (!found) { notFound(); return; }
      const key = objectKey(found.space.id, path);
      if (!takeToken(buckets, userId, PRESIGNS_PER_MINUTE, PRESIGNS_PER_MINUTE / 60, now())) {
        plain(res, 429, 'Too many requests; slow down');
        return;
      }
      const objects = await objectsOf();
      const head = await objects.head(key);
      if (!head) {
        if (!await toFolder(`${path}/`, objects)) notFound();
        return;
      }
      const recordGet = (bytes: number) => store.recordEvent({
        spaceId: found.space.id, actorUserId: userId, actorInstanceId: null, via: found.shared ? 'share' : null, action: 'file.get', path, bytes,
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
      const { url } = await objects.presignGet(key, fileLinkResponseHeaders(path), found.shared ? SHARED_READ_TTL_S : undefined);
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

/**
 * The simple UI's file view for someone who isn't a member of the space but
 * can read a file shared with termag, mounted by index.ts at
 * `/termag/api/shared-files` behind requireAuth:
 *
 *   POST /view { space, path }   the same answer as the spaces API's
 *                                files/download with view, signed for
 *                                SHARED_READ_TTL_S, plus who shared it
 *
 * Read only: nothing else is reachable through a share. Not shared is a 404.
 * No spaces flag here either, as for a link.
 */
export function sharedFileApiRouter(deps: Pick<SpaceFilesRouterDeps, 'store' | 'objects' | 'userId' | 'viewerAllowed' | 'sharingDisabled' | 'now'>): Router {
  const router = Router();
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const buckets = new Map<string, Bucket>();

  router.post('/view', asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const userId = deps.userId(req);
    if (!userId) { res.status(401).json({ error: 'Unauthorized', code: 'auth_required' }); return; }
    const notFound = () => res.status(404).json({ error: 'Not found', code: 'file_not_found' });
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    try {
      const path = normalizeFilePath(body.path);
      const hit = deps.viewerAllowed && typeof body.space === 'string'
        ? await resolveSharedFile({ store, viewerAllowed: deps.viewerAllowed, disabled: deps.sharingDisabled }, userId, body.space, path)
        : null;
      if (!hit) { notFound(); return; }
      if (!takeToken(buckets, userId, PRESIGNS_PER_MINUTE, PRESIGNS_PER_MINUTE / 60, now())) {
        res.status(429).json({ error: 'Too many requests; slow down', code: 'rate_limited' });
        return;
      }
      const user = await store.ldUser(userId);
      const objects = await deps.objects({ kind: 'user', userId, email: user?.googleEmail ?? null });
      const key = objectKey(hit.space.id, path);
      const head = await objects.head(key);
      if (!head) { notFound(); return; }
      const view = viewResponseHeaders(path);
      const url = await objects.presignGet(key, view ?? downloadResponseHeaders(path, false), SHARED_READ_TTL_S);
      await store.recordEvent({ spaceId: hit.space.id, actorUserId: userId, actorInstanceId: null, via: 'share', action: 'file.get', path, bytes: head.size });
      res.json({
        ...url, size: head.size, contentType: head.contentType,
        view: view ? { contentType: view.contentType, render: view.render } : null,
        share: { ...shareView(hit.share), canShare: false },
      });
    } catch (err) {
      if (err instanceof SpacePathError) { notFound(); return; }
      if (err instanceof SpacesUnavailableError) { res.status(503).json({ error: 'Spaces storage is unavailable right now', code: err.code }); return; }
      throw err;
    }
  }));

  return router;
}
