/**
 * The spaces API: one router, mounted twice by
 * index.ts:
 *
 *   /termag/api/spaces          browser, behind requireAuth (a user)
 *   /termag/api/cli/v1/spaces   CLI, behind cliBearer: a device login acts as
 *                               the user, a box's tmag_ token as the box
 *
 * A space the caller has no
 * role in is also a 404, so names don't leak. Bytes never pass through here:
 * reads and writes are presigned S3 URLs (services/spaces/spaceObjects.ts).
 *
 * A box can read and write files but never manage: creating, renaming or
 * deleting a space and changing members or boxes need a person (a browser
 * session or a device login). A box may share a file with termag, as an
 * editor or owner can (sharedFiles.ts).
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { asyncHandler } from '../middleware/errors';
import { takeToken, type Bucket } from '../middleware/rateLimit';
import {
  canAddBox, canManage, canRemoveBox, isSpaceRole, roleAtLeast, wouldRemoveLastOwner,
  type SpaceAccess, type SpaceCaller, type SpaceRole,
} from '../services/spaces/spaceAccess';
import { SpacesUnavailableError } from '../services/spaces/spaceConfig';
import { ancestorsOf, childBoxesOf } from '../services/spaces/spaceInheritance';
import { PART_TTL_S, PUT_TTL_S, VIEW_TTL_S, type PresignerIdentity, type SpaceObjects } from '../services/spaces/spaceObjects';
import {
  SpacePathError, downloadResponseHeaders, movedPath, normalizeFilePath, normalizePrefix, objectKey, pathOfKey,
  uploadContentType, validateSpaceName, viewResponseHeaders,
} from '../services/spaces/spacePaths';
import {
  MEMORY_LOG_MAX, MemoryRequestError, lastWriters, logEntries, noteOf, putConditionOf, sinceOf, type MemoryActor,
} from '../services/spaces/spaceMemory';
import { uploadProof } from '../services/spaces/spaceVersions';
import {
  LastOwnerError, SpaceNameTakenError, type FileShareRecord, type SpaceEventRecord, type SpaceRecord, type SpaceStore,
} from '../services/spaces/spaceStore';
import { canShareFiles, sharingDisabled } from '../services/spaces/sharedFiles';
import type { FileChange } from '../services/spaces/spaceFileBus';
import {
  MAX_FILE_BYTES, SpaceOpError, declaredSize, fail, notFound, preconditionFailed, proofCaller, spaceFileOps,
  type EventExtra, type Loaded, type SpaceOpContext,
} from '../services/spaces/spaceFileOps';

export const SINGLE_PUT_MAX_BYTES = 64 * 1024 * 1024;
export const PART_BYTES = 64 * 1024 * 1024;
export { MAX_FILE_BYTES };
export const MAX_MOVE_OBJECTS = 1000;
export const PRESIGNS_PER_MINUTE = 600;
const MAX_PARTS_PER_BATCH = 100;
/** A move's copies finish inside the request; this only covers a recount listing S3 while they run. */
const MOVE_CHARGE_S = 5 * 60;

/**
 * Who a /api/cli/v1 credential is to spaces. A box's tmag_ token acts as that
 * box; one bound to no box (the orchestrator's per-user agent) acts as its
 * user, as it does on the rest of the CLI API.
 */
export function spaceCallerFromCli(auth: { user: { id: string }; credential: { kind: string; boxId?: string | null } }): SpaceCaller {
  return auth.credential.kind === 'box' && auth.credential.boxId
    ? { kind: 'box', userId: auth.user.id, instanceId: auth.credential.boxId }
    : { kind: 'user', userId: auth.user.id };
}

export interface SpacesRouterDeps {
  store: SpaceStore;
  /**
   * The S3 side, over a presigner session named for who acts (CloudTrail
   * records it); rejects with SpacesUnavailableError when the AWS identity
   * can't be read.
   */
  objects: (identity: PresignerIdentity) => Promise<SpaceObjects>;
  /**
   * A file was put, moved or removed (spaceFileBus.ts sends it to every
   * process); called after the change's event is recorded, never awaited.
   */
  onFileChange?: (change: FileChange) => void;
  /** A member's role was lowered or they left (services/automations/spaceSync.ts recheckMirrorsForMember). */
  onMemberChanged?: (spaceName: string, userId: string) => Promise<void>;
  /** Who is calling, from whatever the mount authenticated; null is a 401. */
  caller: (req: Request, res: Response) => SpaceCaller | null;
  /** The absolute browser link to a file (routes/spaceFiles.ts); unset, `files/link` answers 404. */
  fileLink?: (space: string, path: string) => string;
  /** The secret a conditional PUT's proof is made with (spaceVersions.ts uploadProof); defaults to SESSION_SECRET. */
  uploadSecret?: () => string;
  /** The file-sharing kill switch (services/spaces/sharedFiles.ts); defaults to SPACE_FILE_SHARING_DISABLED. */
  sharingDisabled?: () => boolean;
  now?: () => number;
}

function handler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return asyncHandler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof SpaceOpError) { res.status(err.status).json({ error: err.message, code: err.code, ...err.extra }); return; }
      if (err instanceof SpacePathError) { res.status(400).json({ error: err.message, code: err.code }); return; }
      if (err instanceof SpaceNameTakenError) { res.status(409).json({ error: err.message, code: err.code }); return; }
      if (err instanceof LastOwnerError) { res.status(400).json({ error: err.message, code: err.code }); return; }
      if (err instanceof MemoryRequestError) { res.status(400).json({ error: err.message, code: err.code }); return; }
      if (err instanceof SpacesUnavailableError) {
        res.status(503).json({ error: 'Spaces storage is unavailable right now', code: err.code });
        return;
      }
      throw err;
    }
  });
}

function spaceView(space: SpaceRecord, access: SpaceAccess | null) {
  return {
    id: space.id,
    name: space.name,
    description: space.description,
    createdAt: space.createdAt.toISOString(),
    usedBytes: Number(space.usedBytes),
    quotaBytes: Number(space.quotaBytes),
    ...(access ? {
      role: access.role,
      readOnly: access.readOnly,
      ...(access.boxAccess ? { access: access.boxAccess } : {}),
    } : {}),
  };
}

function bodyOf(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
}

/** A file's sharing state for the file view's Share button. */
export function shareView(share: FileShareRecord | null) {
  return share
    ? { shared: true, sharedAt: share.createdAt.toISOString(), sharedBy: share.sharedBy ? { displayName: share.sharedBy.displayName, email: share.sharedBy.email } : null }
    : { shared: false };
}

function baseName(path: string): string {
  const bare = path.endsWith('/') ? path.slice(0, -1) : path;
  return bare.slice(bare.lastIndexOf('/') + 1);
}

export function spacesRouter(deps: SpacesRouterDeps): Router {
  const router = Router();
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const presignBuckets = new Map<string, Bucket>();
  // The space file operations (services/spaces/spaceFileOps.ts); this router is the HTTP layer over them.
  const ops = spaceFileOps({ store, objects: deps.objects, onFileChange: deps.onFileChange, uploadSecret: deps.uploadSecret });
  const { accessFor, checkDeclaredSize, charge, refuseIfChanged, failChanged, proofSecret } = ops;

  function callerOf(res: Response): SpaceCaller {
    return res.locals.spaceCaller as SpaceCaller;
  }

  /** The web UI and the CLI: the caller acts for themselves, on no other surface. */
  function ctxOf(res: Response): SpaceOpContext {
    return { caller: callerOf(res) };
  }

  router.use(asyncHandler(async (req, res, next) => {
    const caller = deps.caller(req, res);
    if (!caller) { res.status(401).json({ error: 'Unauthorized', code: 'auth_required' }); return; }
    res.locals.spaceCaller = caller;
    next();
  }));

  function objectsFor(res: Response): Promise<SpaceObjects> {
    return ops.objectsFor(callerOf(res));
  }

  function personOnly(caller: SpaceCaller): void {
    if (caller.kind === 'box') {
      fail(403, 'A box cannot manage spaces; run this from your laptop after `termag login`, or in the termag UI', 'box_credential');
    }
  }

  function throttle(caller: SpaceCaller, count = 1): void {
    const key = caller.kind === 'box' ? `box:${caller.instanceId}` : `user:${caller.userId}`;
    for (let i = 0; i < count; i++) {
      if (!takeToken(presignBuckets, key, PRESIGNS_PER_MINUTE, PRESIGNS_PER_MINUTE / 60, now())) {
        fail(429, 'Too many requests; slow down', 'rate_limited');
      }
    }
  }

  function load(req: Request, res: Response, needed: SpaceRole): Promise<Loaded> {
    return ops.load(callerOf(res), String(req.params.space ?? ''), needed);
  }

  function event(res: Response, space: SpaceRecord, access: SpaceAccess | null, action: string, extra?: EventExtra) {
    return ops.event(ctxOf(res), space, access, action, extra);
  }

  // ---- spaces ----

  router.get('/', handler(async (_req, res) => {
    const caller = callerOf(res);
    if (caller.kind === 'user') {
      await store.claimInvites(caller.userId);
      const rows = await store.spacesOfUser(caller.userId);
      const spaces = await Promise.all(rows.map(async r => ({ ...spaceView(r.space, await accessFor(caller, r.space)), memberCount: r.memberCount })));
      res.json({ spaces });
      return;
    }
    const box = await store.box(caller.instanceId);
    if (!box) { res.json({ spaces: [] }); return; }
    const ancestors = await ancestorsOf(box, id => store.box(id));
    const granted = await store.spacesGrantedTo([box.id, ...ancestors.map(a => a.id)]);
    const seen = new Set<string>();
    const spaces = [];
    for (const { space } of granted) {
      if (seen.has(space.id)) continue;
      seen.add(space.id);
      const access = await accessFor(caller, space);
      if (access) spaces.push(spaceView(space, access));
    }
    spaces.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ spaces });
  }));

  router.post('/', handler(async (req, res) => {
    const caller = callerOf(res);
    personOnly(caller);
    const body = bodyOf(req);
    const name = validateSpaceName(body.name);
    const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim().slice(0, 500) : null;
    const space = await store.createSpace({ name, description, userId: caller.userId });
    res.status(201).json({
      space: spaceView(space, { role: 'owner', memberRole: 'owner', readOnly: false }),
    });
  }));

  router.get('/:space', handler(async (req, res) => {
    const { space, access } = await load(req, res, 'viewer');
    res.json({ space: spaceView(space, access) });
  }));

  router.patch('/:space', handler(async (req, res) => {
    personOnly(callerOf(res));
    const { space, access } = await load(req, res, 'owner');
    const body = bodyOf(req);
    const patch: { name?: string; description?: string | null } = {};
    if (body.name !== undefined) patch.name = validateSpaceName(body.name);
    if (body.description !== undefined) {
      patch.description = typeof body.description === 'string' && body.description.trim() ? body.description.trim().slice(0, 500) : null;
    }
    const oldName = space.name;
    const updated = await store.updateSpace(space.id, patch);
    if (patch.name && patch.name !== oldName) await event(res, space, access, 'space.rename', { path: `${oldName} -> ${patch.name}` });
    res.json({ space: spaceView(updated, access) });
  }));

  router.delete('/:space', handler(async (req, res) => {
    personOnly(callerOf(res));
    const { space, access } = await load(req, res, 'owner');
    await store.markDeleted(space.id);
    await event(res, space, access, 'space.delete', { path: space.name });
    res.json({ ok: true });
  }));

  // ---- members ----

  router.get('/:space/members', handler(async (req, res) => {
    const { space, access } = await load(req, res, 'viewer');
    const [members, invites] = await Promise.all([
      store.members(space.id), canManage(access) ? store.invites(space.id) : [],
    ]);
    res.json({
      members: members.map(m => ({
        userId: m.userId, email: m.user.email, displayName: m.user.displayName, role: m.role, addedAt: m.createdAt.toISOString(),
      })),
      invites: invites.map(i => ({ id: i.id, email: i.email, role: i.role, addedAt: i.createdAt.toISOString() })),
    });
  }));

  router.post('/:space/members', handler(async (req, res) => {
    const caller = callerOf(res);
    personOnly(caller);
    const { space, access } = await load(req, res, 'owner');
    const body = bodyOf(req);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) fail(400, 'An email address is required', 'invalid_email');
    if (!isSpaceRole(body.role)) fail(400, 'role must be owner, editor or viewer', 'invalid_role');
    const self = await store.userByEmail(email);
    if (self?.id === caller.userId) fail(400, 'You are already a member', 'self');
    if (self) {
      const roles = await store.memberRoles(space.id);
      if (wouldRemoveLastOwner(roles, self.id, body.role)) fail(400, 'A space needs at least one owner', 'last_owner');
    }
    const result = await store.addMember({ spaceId: space.id, email, role: body.role, addedById: caller.userId });
    await event(res, space, access, result.kind === 'member' ? 'member.add' : 'invite.add', { path: `${email} ${body.role}` });
    res.status(201).json(result.kind === 'member'
      ? { member: { userId: result.member.userId, email: result.member.user.email, displayName: result.member.user.displayName, role: result.member.role } }
      : { invite: { id: result.invite.id, email: result.invite.email, role: result.invite.role } });
  }));

  router.patch('/:space/members/:userId', handler(async (req, res) => {
    personOnly(callerOf(res));
    const { space, access } = await load(req, res, 'owner');
    const role = bodyOf(req).role;
    if (!isSpaceRole(role)) fail(400, 'role must be owner, editor or viewer', 'invalid_role');
    const roles = await store.memberRoles(space.id);
    const userId = String(req.params.userId);
    if (!roles.has(userId)) notFound();
    if (wouldRemoveLastOwner(roles, userId, role)) fail(400, 'A space needs at least one owner', 'last_owner');
    await store.setMemberRole(space.id, userId, role);
    await event(res, space, access, 'member.role', { path: `${userId} ${role}` });
    await deps.onMemberChanged?.(space.name, userId).catch(() => {});
    res.json({ ok: true });
  }));

  router.delete('/:space/members/:userId', handler(async (req, res) => {
    const caller = callerOf(res);
    personOnly(caller);
    const userId = String(req.params.userId);
    const leaving = userId === caller.userId;
    const { space, access } = await load(req, res, leaving ? 'viewer' : 'owner');
    const roles = await store.memberRoles(space.id);
    if (!roles.has(userId)) notFound();
    if (wouldRemoveLastOwner(roles, userId, null)) fail(400, 'A space needs at least one owner; make someone else an owner first', 'last_owner');
    const { removedBoxes } = await store.removeMember(space.id, userId);
    await event(res, space, access, leaving ? 'member.leave' : 'member.remove', { path: userId });
    await deps.onMemberChanged?.(space.name, userId).catch(() => {});
    res.json({ ok: true, removedBoxes });
  }));

  router.delete('/:space/invites/:inviteId', handler(async (req, res) => {
    personOnly(callerOf(res));
    const { space, access } = await load(req, res, 'owner');
    if (!await store.removeInvite(space.id, String(req.params.inviteId))) notFound();
    await event(res, space, access, 'invite.remove', { path: String(req.params.inviteId) });
    res.json({ ok: true });
  }));

  // ---- boxes ----

  router.get('/:space/boxes', handler(async (req, res) => {
    const caller = callerOf(res);
    const { space } = await load(req, res, 'viewer');
    const all = await store.grants(space.id);
    const grants = all.filter(g => g.box.status !== 'terminated');
    const candidates = caller.kind === 'user' ? await store.boxesOwnedBy(caller.userId) : [];
    const boxes = grants.map(g => ({
      id: g.box.id, name: g.box.name, kind: g.box.kind, status: g.box.status, ownerEmail: g.box.ownerEmail,
      mine: g.box.userId === caller.userId,
      children: childBoxesOf(g.box.id, candidates).map(c => ({ id: c.id, name: c.name, via: g.box.id })),
    }));
    // Boxes whose projects stay listed here though no live grant reaches them:
    // terminated ones (recorded, or whose grants the sweep hasn't recorded and
    // pruned yet), and live children of a terminated parent.
    const reached = new Set(boxes.flatMap(b => [b.id, ...b.children.map(c => c.id)]));
    const gone = all.filter(g => g.box.status === 'terminated').map(g => g.box.id);
    const listed = [...new Set([...gone, ...await store.listedBoxes(space.id)])]
      .filter(id => !reached.has(id)).sort().map(id => ({ id }));
    res.json({ boxes, listed });
  }));

  router.post('/:space/boxes', handler(async (req, res) => {
    const caller = callerOf(res);
    personOnly(caller);
    const { space, access } = await load(req, res, 'editor');
    if (!canAddBox(access)) fail(403, 'Adding a box needs editor', 'forbidden');
    const ref = bodyOf(req).box;
    if (typeof ref !== 'string' || !ref) fail(400, 'box (an id or name) is required', 'invalid_box');
    const mine = await store.boxesOwnedBy(caller.userId);
    const box = mine.find(b => b.id === ref) ?? mine.find(b => b.name === ref);
    if (!box) fail(404, `You have no box ${JSON.stringify(ref)}`, 'box_not_found');
    await store.addGrant(space.id, box.id, caller.userId);
    await event(res, space, access, 'box.add', { path: box.name });
    res.status(201).json({ box: { id: box.id, name: box.name } });
  }));

  router.delete('/:space/boxes/:instanceId', handler(async (req, res) => {
    const caller = callerOf(res);
    personOnly(caller);
    const { space, access } = await load(req, res, 'viewer');
    const box = await store.box(String(req.params.instanceId));
    if (!box) notFound();
    if (!canRemoveBox(access, caller.userId, box.userId)) fail(403, 'Only the box\'s owner or a space owner can remove it', 'forbidden');
    if (!await store.removeGrant(space.id, box.id)) notFound();
    await event(res, space, access, 'box.remove', { path: box.name });
    res.json({ ok: true });
  }));

  // ---- files ----

  router.get('/:space/tree', handler(async (req, res) => {
    const { space } = await load(req, res, 'viewer');
    const prefix = normalizePrefix(req.query.prefix);
    const cursor = typeof req.query.cursor === 'string' && req.query.cursor ? req.query.cursor : null;
    const recursive = req.query.recursive === '1' || req.query.recursive === 'true';
    const objects = await objectsFor(res);
    const [listed, shared] = await Promise.all([
      objects.list(objectKey(space.id, prefix), { cursor, delimiter: !recursive }),
      store.sharedPaths(space.id),
    ]);
    res.json({
      prefix,
      dirs: listed.prefixes.map(k => pathOfKey(space.id, k)).filter((p): p is string => p !== null)
        .map(path => ({ name: baseName(path), path })),
      files: listed.files.flatMap(f => {
        const path = pathOfKey(space.id, f.key);
        return path === null || path.endsWith('/') ? [] : [{
          name: baseName(path), path, size: f.size, modifiedAt: f.modifiedAt, etag: f.etag, ...(shared.has(path) ? { shared: true } : {}),
        }];
      }),
      nextCursor: listed.nextCursor,
    });
  }));

  router.post('/:space/files/download', handler(async (req, res) => {
    const caller = callerOf(res);
    const { space, access } = await load(req, res, 'viewer');
    const body = bodyOf(req);
    const path = normalizeFilePath(body.path);
    throttle(caller);
    const objects = await objectsFor(res);
    const key = objectKey(space.id, path);
    const head = await objects.head(key);
    if (!head) fail(404, `No file ${path} in ${space.name}`, 'file_not_found');
    const view = body.view === true ? viewResponseHeaders(path) : null;
    const url = view
      ? await objects.presignGet(key, view, VIEW_TTL_S)
      : await objects.presignGet(key, downloadResponseHeaders(path, body.inline === true));
    await event(res, space, access, 'file.get', { path, bytes: head.size });
    res.json({
      ...url, size: head.size, contentType: head.contentType,
      // The version served, so a later write can say it read this one.
      ...(head.etag ? { etag: head.etag } : {}), ...(head.versionId ? { versionId: head.versionId } : {}),
      ...(body.view === true ? {
        view: view ? { contentType: view.contentType, render: view.render } : null,
        share: { ...shareView(await store.fileShare(space.id, path)), canShare: canShareFiles(access) },
      } : {}),
    });
  }));

  // Sharing one file read-only with anyone signed in to termag (services/spaces/sharedFiles.ts).
  // A box may share too; the row names its owner, the event the box.
  router.put('/:space/files/share', handler(async (req, res) => {
    const caller = callerOf(res);
    const { space, access } = await load(req, res, 'editor');
    if (!canShareFiles(access)) fail(403, `You can't share files in ${space.name}`, 'forbidden');
    if ((deps.sharingDisabled ?? sharingDisabled)()) fail(403, 'Sharing files is turned off on this termag', 'sharing_off');
    const path = normalizeFilePath(bodyOf(req).path);
    if (!await (await objectsFor(res)).head(objectKey(space.id, path))) fail(404, `No file ${path} in ${space.name}`, 'file_not_found');
    const before = await store.fileShare(space.id, path);
    const share = before ?? await store.addFileShare(space.id, path, caller.userId);
    if (!before) await event(res, space, access, 'file.share', { path });
    res.json(shareView(share));
  }));

  router.delete('/:space/files/share', handler(async (req, res) => {
    const { space, access } = await load(req, res, 'editor');
    if (!canShareFiles(access)) fail(403, `You can't change sharing in ${space.name}`, 'forbidden');
    const path = normalizeFilePath(req.query.path);
    if (await store.removeFileShares(space.id, { path }) > 0) await event(res, space, access, 'file.unshare', { path });
    res.json(shareView(null));
  }));

  router.post('/:space/files/link', handler(async (req, res) => {
    if (!deps.fileLink) notFound();
    const { space } = await load(req, res, 'viewer');
    const path = normalizeFilePath(bodyOf(req).path);
    const head = await (await objectsFor(res)).head(objectKey(space.id, path));
    if (!head) fail(404, `No file ${path} in ${space.name}`, 'file_not_found');
    res.json({ url: deps.fileLink(space.name, path), path, size: head.size });
  }));

  router.post('/:space/files/upload', handler(async (req, res) => {
    const caller = callerOf(res);
    const { space, access } = await load(req, res, 'editor');
    const body = bodyOf(req);
    const path = normalizeFilePath(body.path);
    const size = checkDeclaredSize(space, body.size);
    const contentType = uploadContentType(body.contentType);
    // The version the writer read: checked here, signed into the PUT, and checked again on the confirm.
    const condition = putConditionOf(body);
    const key = objectKey(space.id, path);
    throttle(caller);
    const objects = await objectsFor(res);
    if (condition) await refuseIfChanged({ space, access }, path, condition, await objects.head(key));
    if (size <= SINGLE_PUT_MAX_BYTES) {
      await charge(space, size, PUT_TTL_S, { key });
      const proof = condition ? uploadProof(proofSecret(), { spaceId: space.id, path, caller: proofCaller(caller), condition }) : null;
      const put = await objects.presignPut(key, size, contentType, condition, proof);
      // A client may PUT and never call /uploaded, so the signing is the event that is always there.
      await event(res, space, access, 'file.put.signed', { path, bytes: size });
      // `conditional` tells the CLI this orchestrator signed the condition; an older one ignores it and writes blind.
      res.json({ kind: 'single', path, ...put, ...(condition ? { conditional: true } : {}) });
      return;
    }
    const uploadId = await objects.createMultipart(key, contentType);
    // A multipart upload's condition goes again with its complete, where S3 assembles the object.
    res.json({ kind: 'multipart', path, uploadId, partBytes: PART_BYTES, partCount: Math.ceil(size / PART_BYTES), ...(condition ? { conditional: true } : {}) });
  }));

  router.post('/:space/files/uploaded', handler(async (req, res) => {
    const loaded = await load(req, res, 'editor');
    throttle(callerOf(res));
    const body = bodyOf(req);
    const path = normalizeFilePath(body.path);
    const note = noteOf(body.note);
    const condition = putConditionOf(body);
    const objects = await objectsFor(res);
    // `etag`: what the PUT answered, which finds this write among the versions.
    await ops.checkLanded(ctxOf(res), loaded, path, objects, condition, typeof body.etag === 'string' && body.etag.length <= 200 ? body.etag : null);
    const head = await ops.recordPut(ctxOf(res), loaded, path, objects, note);
    res.json({ ok: true, path, size: head.size, ...(head.etag ? { etag: head.etag } : {}), ...(head.versionId ? { versionId: head.versionId } : {}) });
  }));

  /**
   * The file's current version, for the file view's one-off checks:
   * once when it opens, and once each time
   * frames may have been missed (a reconnect, a resync). `ETag` is S3's, and
   * an `If-None-Match` that still matches is a 304 with no body. Nothing
   * polls it. No presign, so no rate limit.
   */
  router.get('/:space/files/head', handler(async (req, res) => {
    const { space } = await load(req, res, 'viewer');
    const path = normalizeFilePath(req.query.path);
    const head = await (await objectsFor(res)).head(objectKey(space.id, path));
    if (!head) fail(404, `No file ${path} in ${space.name}`, 'file_not_found');
    res.set('Cache-Control', 'no-store');
    if (head.etag) {
      res.set('ETag', head.etag);
      const sent = req.get('If-None-Match');
      if (sent && sent.split(',').map(t => t.trim()).includes(head.etag)) { res.status(304).end(); return; }
    }
    res.json({ path, size: head.size, modifiedAt: head.lastModified?.toISOString() ?? null, etag: head.etag ?? null });
  }));

  router.post('/:space/uploads/:uploadId/parts', handler(async (req, res) => {
    const caller = callerOf(res);
    const { space } = await load(req, res, 'editor');
    const body = bodyOf(req);
    const path = normalizeFilePath(body.path);
    const size = declaredSize(body.size);
    const partCount = Math.max(1, Math.ceil(size / PART_BYTES));
    const numbers = body.partNumbers;
    if (!Array.isArray(numbers) || numbers.length === 0 || numbers.length > MAX_PARTS_PER_BATCH
      || !numbers.every(n => Number.isInteger(n) && n >= 1 && n <= partCount)) {
      fail(400, `partNumbers must be 1-${MAX_PARTS_PER_BATCH} integers between 1 and ${partCount}`, 'invalid_parts');
    }
    throttle(caller, numbers.length);
    const sized = (numbers as number[]).map(n => ({ partNumber: n, size: Math.min(PART_BYTES, size - (n - 1) * PART_BYTES) }));
    const batch = sized.reduce((t, p) => t + p.size, 0);
    await charge(space, batch, PART_TTL_S, { key: objectKey(space.id, path), uploadId: String(req.params.uploadId), partNumbers: numbers as number[] });
    const parts = await (await objectsFor(res)).presignParts(objectKey(space.id, path), String(req.params.uploadId), sized);
    res.json({ parts });
  }));

  router.post('/:space/uploads/:uploadId/complete', handler(async (req, res) => {
    const loaded = await load(req, res, 'editor');
    const body = bodyOf(req);
    const path = normalizeFilePath(body.path);
    const parts = body.parts;
    if (!Array.isArray(parts) || parts.length === 0 || !parts.every(p =>
      p && typeof p === 'object' && Number.isInteger((p as { partNumber?: unknown }).partNumber)
      && typeof (p as { etag?: unknown }).etag === 'string')) {
      fail(400, 'parts must be [{partNumber, etag}]', 'invalid_parts');
    }
    const objects = await objectsFor(res);
    const condition = putConditionOf(body);
    const key = objectKey(loaded.space.id, path);
    if (condition) await refuseIfChanged(loaded, path, condition, await objects.head(key));
    let ours: string | null = null;
    try {
      ours = (await objects.completeMultipart(key, String(req.params.uploadId), parts as Array<{ partNumber: number; etag: string }>, condition)).etag;
    } catch (err) {
      if (condition && preconditionFailed(err)) await failChanged(loaded, path, condition, (await objects.head(key))?.etag ?? null);
      throw err;
    }
    await ops.checkLanded(ctxOf(res), loaded, path, objects, condition, ours, true);
    const head = await ops.recordPut(ctxOf(res), loaded, path, objects);
    res.json({ ok: true, path, size: head.size, ...(head.etag ? { etag: head.etag } : {}), ...(head.versionId ? { versionId: head.versionId } : {}) });
  }));

  router.delete('/:space/uploads/:uploadId', handler(async (req, res) => {
    const { space } = await load(req, res, 'editor');
    const path = normalizeFilePath(req.query.path);
    await (await objectsFor(res)).abortMultipart(objectKey(space.id, path), String(req.params.uploadId));
    res.json({ ok: true });
  }));

  async function keysUnder(objects: SpaceObjects, prefixKey: string, limit: number): Promise<{ keys: Array<{ key: string; size: number }>; more: boolean }> {
    const keys: Array<{ key: string; size: number }> = [];
    let cursor: string | null = null;
    do {
      const page = await objects.list(prefixKey, { cursor, delimiter: false });
      for (const f of page.files) keys.push({ key: f.key, size: f.size });
      cursor = page.nextCursor;
      if (keys.length > limit) return { keys, more: true };
    } while (cursor);
    return { keys, more: false };
  }

  router.post('/:space/files/move', handler(async (req, res) => {
    const { space, access } = await load(req, res, 'editor');
    const body = bodyOf(req);
    const isDir = typeof body.from === 'string' && body.from.endsWith('/');
    const from = isDir ? normalizePrefix(body.from) : normalizeFilePath(body.from);
    const to = isDir ? normalizePrefix(body.to) : normalizeFilePath(body.to);
    if (from === to) fail(400, 'from and to are the same', 'same_path');
    if (isDir && to.startsWith(from)) fail(400, 'Cannot move a folder into itself', 'invalid_move');
    // A file's move can name the version it read (`ifMatch`) and that the destination must be new (`ifNoneMatch`); a folder's can't.
    const condition = putConditionOf({ ifMatch: body.ifMatch });
    const destNew = body.ifNoneMatch === '*';
    if (isDir && (condition || destNew)) fail(400, 'A folder move checks no versions; move its files one by one to check them', 'invalid_condition');
    const objects = await objectsFor(res);

    let sources: Array<{ key: string; size: number }>;
    if (isDir) {
      const found = await keysUnder(objects, objectKey(space.id, from), MAX_MOVE_OBJECTS);
      if (found.more) fail(413, `Moving a folder is limited to ${MAX_MOVE_OBJECTS} files`, 'move_too_large');
      sources = found.keys;
    } else {
      const head = await objects.head(objectKey(space.id, from));
      if (condition) await refuseIfChanged({ space, access }, from, condition, head);
      if (destNew) await refuseIfChanged({ space, access }, to, { ifNoneMatch: '*' }, await objects.head(objectKey(space.id, to)));
      sources = head ? [{ key: objectKey(space.id, from), size: head.size }] : [];
    }
    if (sources.length === 0) fail(404, `Nothing at ${from} in ${space.name}`, 'file_not_found');
    if (sources.some(s => s.size > MAX_FILE_BYTES)) fail(413, 'Moving files over 5 GiB is not supported yet', 'move_too_large');
    const total = sources.reduce((n, s) => n + s.size, 0);
    await charge(space, total, MOVE_CHARGE_S, null);

    const moved: string[] = [];
    for (const s of sources) {
      const path = pathOfKey(space.id, s.key);
      if (path === null) continue;
      const dest = objectKey(space.id, movedPath(from, to, path));
      try {
        await objects.copy(s.key, dest, { sourceIfMatch: condition?.ifMatch ?? null });
      } catch (err) {
        if (condition && preconditionFailed(err)) await failChanged({ space, access }, from, condition, (await objects.head(s.key))?.etag ?? null);
        throw err;
      }
      moved.push(s.key);
    }
    const failed = await objects.deleteKeys(moved);
    // A share is of a path; the file at its new path starts private.
    await store.removeFileShares(space.id, isDir ? { prefix: from } : { path: from });
    await event(res, space, access, 'file.mv', { path: `${from} -> ${to}`, bytes: total });
    res.json({ ok: failed.length === 0, moved: moved.length, failed: failed.map(k => pathOfKey(space.id, k)) });
  }));

  router.delete('/:space/files', handler(async (req, res) => {
    const { space, access } = await load(req, res, 'editor');
    const recursive = req.query.recursive === '1' || req.query.recursive === 'true';
    const note = noteOf(req.query.note);
    // A file's delete can name the version it read; checked by HEAD just before (a recursive one checks none).
    const condition = putConditionOf({ ifMatch: req.query.ifMatch });
    if (recursive && condition) fail(400, 'A folder delete checks no versions', 'invalid_condition');
    const objects = await objectsFor(res);
    let keys: string[];
    let label: string;
    if (recursive) {
      const prefix = normalizePrefix(req.query.path);
      if (!prefix) fail(400, 'Deleting the whole space is DELETE /spaces/:space', 'invalid_path');
      keys = (await keysUnder(objects, objectKey(space.id, prefix), Number.POSITIVE_INFINITY)).keys.map(k => k.key);
      label = prefix;
    } else {
      const path = normalizeFilePath(req.query.path);
      const head = await objects.head(objectKey(space.id, path));
      if (!head) fail(404, `No file ${path} in ${space.name}`, 'file_not_found');
      if (condition) await refuseIfChanged({ space, access }, path, condition, head);
      keys = [objectKey(space.id, path)];
      label = path;
    }
    const failed = keys.length ? await objects.deleteKeys(keys) : [];
    await store.removeFileShares(space.id, recursive ? { prefix: label } : { path: label });
    await event(res, space, access, 'file.rm', { path: label, note });
    res.json({ ok: failed.length === 0, deleted: keys.length - failed.length, failed: failed.map(k => pathOfKey(space.id, k)) });
  }));

  // ---- space memory ----

  /** The names behind events: members by user id, boxes by id (looked up once each). */
  async function memoryActors(space: SpaceRecord, events: SpaceEventRecord[]) {
    const members = new Map((await store.members(space.id)).map(m => [m.userId, m.user]));
    const boxIds = [...new Set(events.flatMap(e => (e.actorInstanceId ? [e.actorInstanceId] : [])))];
    const boxes = new Map(await Promise.all(boxIds.map(async id => [id, (await store.box(id))?.name ?? null] as const)));
    return (e: SpaceEventRecord): MemoryActor => {
      const user = members.get(e.actorUserId);
      return { userId: e.actorUserId, email: user?.email ?? null, name: user?.displayName ?? null, box: e.actorInstanceId ? boxes.get(e.actorInstanceId) ?? null : null };
    };
  }

  // What the box's sync needs beside the files: the caller's role, and the last writer of each memory file.
  router.get('/:space/memory', handler(async (req, res) => {
    const { space, access } = await load(req, res, 'viewer');
    // The whole history: .termag/ events are never pruned.
    const since = new Date(0);
    const events = await store.memoryEvents(space.id, { since, limit: MEMORY_LOG_MAX * 4 });
    const writers = lastWriters(events, await memoryActors(space, events));
    res.json({
      space: space.name, role: access.role, readOnly: access.readOnly,
      writable: roleAtLeast(access.role, 'editor') && !access.readOnly,
      me: callerOf(res).userId, writers,
    });
  }));

  // `termag space memory log`: every member may read the history of the memory their agents load.
  router.get('/:space/memory/log', handler(async (req, res) => {
    const { space } = await load(req, res, 'viewer');
    const since = sinceOf(req.query.since, now()) ?? new Date(now() - 7 * 24 * 60 * 60 * 1000);
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), MEMORY_LOG_MAX);
    const events = await store.memoryEvents(space.id, { since, limit: limit * 2 });
    res.json({ space: space.name, since: since.toISOString(), entries: logEntries(events, await memoryActors(space, events)).slice(0, limit) });
  }));

  // ---- audit ----

  router.get('/:space/events', handler(async (req, res) => {
    const { space } = await load(req, res, 'owner');
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;
    const events = await store.events(space.id, { limit, before });
    res.json({
      events: events.map(e => ({
        id: e.id, at: e.at.toISOString(), action: e.action, path: e.path ?? null,
        bytes: e.bytes === null || e.bytes === undefined ? null : Number(e.bytes),
        actorUserId: e.actorUserId, actorInstanceId: e.actorInstanceId ?? null, via: e.via ?? null,
        // Spaces in Slack: 'slack' and the member the runner acted for; null on every other event.
        surface: e.surface ?? null, onBehalfOfUserId: e.onBehalfOfUserId ?? null,
        ...(e.versionId ? { versionId: e.versionId } : {}), ...(e.note ? { note: e.note } : {}),
      })),
    });
  }));

  router.use(handler(async () => notFound()));

  return router;
}
