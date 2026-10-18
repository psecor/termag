/**
 * The spaces API: one router, mounted twice by
 * index.ts:
 *
 *   /termag/api/spaces          browser, behind requireAuth (a user)
 *   /termag/api/cli/v1/spaces   CLI, behind cliBearer: a device login acts as
 *                               the user, a box's tmag_ token as the box
 *
 * Every route first checks the `spaces-enabled` flag for the user (the box's
 * owner, for a box) and answers 404 when it is off. Adding a member or an
 * invite also needs `spaces-sharing-enabled` for the owner adding them (403
 * `sharing_disabled` without it), so with that flag off a space has only its
 * owner and only the owner's boxes. A space the caller has no
 * role in is also a 404, so names don't leak. Bytes never pass through here:
 * reads and writes are presigned S3 URLs (services/spaces/spaceObjects.ts).
 *
 * A box can read and write files but never manage: creating, renaming or
 * deleting a space and changing members or boxes need a person (a browser
 * session or a device login).
 */
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { asyncHandler } from '../middleware/errors';
import { takeToken, type Bucket } from '../middleware/rateLimit';
import {
  canAddBox, canManage, canRemoveBox, isSpaceRole, resolveSpaceAccess, roleAtLeast, wouldRemoveLastOwner,
  type SpaceAccess, type SpaceCaller, type SpaceRole,
} from '../services/spaces/spaceAccess';
import { SpacesUnavailableError } from '../services/spaces/spaceConfig';
import { ancestorsOf, childBoxesOf, type InheritanceRows } from '../services/spaces/spaceInheritance';
import { PART_TTL_S, PUT_TTL_S, type SpaceObjects } from '../services/spaces/spaceObjects';
import {
  SpacePathError, downloadResponseHeaders, movedPath, normalizeFilePath, normalizePrefix, objectKey, pathOfKey,
  uploadContentType, validateSpaceName,
} from '../services/spaces/spacePaths';
import { LastOwnerError, SpaceNameTakenError, type ChargeRef, type SpaceRecord, type SpaceStore } from '../services/spaces/spaceStore';

export const SINGLE_PUT_MAX_BYTES = 64 * 1024 * 1024;
export const PART_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;
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
  /** The S3 side; rejects with SpacesUnavailableError when the AWS identity can't be read. */
  objects: () => Promise<SpaceObjects>;
  /** The spaces-enabled flag for this user. */
  enabled: (userId: string) => Promise<boolean>;
  /** The spaces-sharing-enabled flag for this user: off, adding members and invites is refused. */
  sharing: (userId: string) => Promise<boolean>;
  /** Who is calling, from whatever the mount authenticated; null is a 401. */
  caller: (req: Request, res: Response) => SpaceCaller | null;
  now?: () => number;
}

interface Loaded { space: SpaceRecord; access: SpaceAccess }

const NO_ROWS: InheritanceRows = {};

class HttpFailure extends Error {
  constructor(readonly status: number, message: string, readonly code: string) { super(message); }
}

function fail(status: number, message: string, code: string): never {
  throw new HttpFailure(status, message, code);
}

function notFound(): never {
  fail(404, 'Not found', 'not_found');
}

function handler(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return asyncHandler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HttpFailure) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
      if (err instanceof SpacePathError) { res.status(400).json({ error: err.message, code: err.code }); return; }
      if (err instanceof SpaceNameTakenError) { res.status(409).json({ error: err.message, code: err.code }); return; }
      if (err instanceof LastOwnerError) { res.status(400).json({ error: err.message, code: err.code }); return; }
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

function baseName(path: string): string {
  const bare = path.endsWith('/') ? path.slice(0, -1) : path;
  return bare.slice(bare.lastIndexOf('/') + 1);
}

export function spacesRouter(deps: SpacesRouterDeps): Router {
  const router = Router();
  const { store } = deps;
  const now = deps.now ?? Date.now;
  const presignBuckets = new Map<string, Bucket>();

  function callerOf(res: Response): SpaceCaller {
    return res.locals.spaceCaller as SpaceCaller;
  }

  router.use(asyncHandler(async (req, res, next) => {
    const caller = deps.caller(req, res);
    if (!caller) { res.status(401).json({ error: 'Unauthorized', code: 'auth_required' }); return; }
    if (!await deps.enabled(caller.userId)) { res.status(404).json({ error: 'Not found', code: 'not_found' }); return; }
    res.locals.spaceCaller = caller;
    next();
  }));

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

  async function accessFor(caller: SpaceCaller, space: SpaceRecord): Promise<SpaceAccess | null> {
    const [members, grantedBoxIds] = await Promise.all([store.memberRoles(space.id), store.grantedBoxIds(space.id)]);
    if (caller.kind === 'user') return resolveSpaceAccess(caller, { space, members, grantedBoxIds });
    const box = await store.box(caller.instanceId);
    const ancestors = box ? await ancestorsOf(box, id => store.box(id), NO_ROWS) : [];
    return resolveSpaceAccess(caller, { space, members, grantedBoxIds, box, ancestors });
  }

  async function load(req: Request, res: Response, needed: SpaceRole): Promise<Loaded> {
    const caller = callerOf(res);
    const ref = String(req.params.space ?? '');
    let space = await store.findSpace(ref);
    let access = space ? await accessFor(caller, space) : null;
    if (!access && caller.kind === 'user' && await store.claimInvites(caller.userId) > 0) {
      space = await store.findSpace(ref);
      access = space ? await accessFor(caller, space) : null;
    }
    if (!space || !access) notFound();
    if (!roleAtLeast(access.role, needed)) {
      if (access.readOnly && roleAtLeast(access.memberRole, needed)) {
        fail(403, `${space.name} is read-only: it has no owner`, 'read_only');
      }
      fail(403, `You are a ${access.role} of ${space.name}; this needs ${needed}`, 'forbidden');
    }
    return { space, access };
  }

  function event(res: Response, space: SpaceRecord, access: SpaceAccess | null, action: string, extra: { path?: string | null; bytes?: number | bigint | null } = {}) {
    const caller = callerOf(res);
    return store.recordEvent({
      spaceId: space.id,
      actorUserId: caller.userId,
      actorInstanceId: caller.kind === 'box' ? caller.instanceId : null,
      via: access?.boxAccess?.kind === 'inherited' ? access.boxAccess.via : null,
      action,
      ...extra,
    });
  }

  // ---- spaces ----

  router.get('/', handler(async (_req, res) => {
    const caller = callerOf(res);
    if (caller.kind === 'user') {
      await store.claimInvites(caller.userId);
      const rows = await store.spacesOfUser(caller.userId);
      const spaces = await Promise.all(rows.map(async r => spaceView(r.space, await accessFor(caller, r.space))));
      res.json({ spaces });
      return;
    }
    const box = await store.box(caller.instanceId);
    if (!box) { res.json({ spaces: [] }); return; }
    const ancestors = await ancestorsOf(box, id => store.box(id), NO_ROWS);
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
      sharing: await deps.sharing(caller.userId),
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
    const [members, invites, sharing] = await Promise.all([
      store.members(space.id), canManage(access) ? store.invites(space.id) : [], deps.sharing(callerOf(res).userId),
    ]);
    res.json({
      sharing,
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
    if (!await deps.sharing(caller.userId)) {
      fail(403, 'Sharing spaces with other people is not turned on for you yet', 'sharing_disabled');
    }
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
    const grants = (await store.grants(space.id)).filter(g => g.box.status !== 'terminated');
    const candidates = caller.kind === 'user' ? await store.boxesOwnedBy(caller.userId) : [];
    const boxes = grants.map(g => ({
      id: g.box.id, name: g.box.name, kind: g.box.kind, status: g.box.status, ownerEmail: g.box.ownerEmail,
      mine: g.box.userId === caller.userId,
      children: childBoxesOf(g.box.id, candidates, NO_ROWS).map(c => ({ id: c.id, name: c.name, via: g.box.id })),
    }));
    res.json({ boxes });
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
    const objects = await deps.objects();
    const listed = await objects.list(objectKey(space.id, prefix), { cursor, delimiter: !recursive });
    res.json({
      prefix,
      dirs: listed.prefixes.map(k => pathOfKey(space.id, k)).filter((p): p is string => p !== null)
        .map(path => ({ name: baseName(path), path })),
      files: listed.files.flatMap(f => {
        const path = pathOfKey(space.id, f.key);
        return path === null || path.endsWith('/') ? [] : [{ name: baseName(path), path, size: f.size, modifiedAt: f.modifiedAt, etag: f.etag }];
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
    const objects = await deps.objects();
    const key = objectKey(space.id, path);
    const head = await objects.head(key);
    if (!head) fail(404, `No file ${path} in ${space.name}`, 'file_not_found');
    const url = await objects.presignGet(key, downloadResponseHeaders(path, body.inline === true));
    await event(res, space, access, 'file.get', { path, bytes: head.size });
    res.json({ ...url, size: head.size, contentType: head.contentType });
  }));

  router.post('/:space/files/upload', handler(async (req, res) => {
    const caller = callerOf(res);
    const { space } = await load(req, res, 'editor');
    const body = bodyOf(req);
    const path = normalizeFilePath(body.path);
    const size = await checkDeclaredSize(space, body.size);
    const contentType = uploadContentType(body.contentType);
    const key = objectKey(space.id, path);
    throttle(caller);
    const objects = await deps.objects();
    if (size <= SINGLE_PUT_MAX_BYTES) {
      await charge(space, size, PUT_TTL_S, { key });
      const put = await objects.presignPut(key, size, contentType);
      res.json({ kind: 'single', path, ...put });
      return;
    }
    const uploadId = await objects.createMultipart(key, contentType);
    res.json({ kind: 'multipart', path, uploadId, partBytes: PART_BYTES, partCount: Math.ceil(size / PART_BYTES) });
  }));

  function overQuota(space: SpaceRecord): never {
    fail(413, `${space.name} is over its quota (${space.usedBytes} of ${space.quotaBytes} bytes, history included)`, 'quota_exceeded');
  }

  /** A read-only pre-check, for a request that writes nothing yet (a multipart create). */
  function checkQuota(space: SpaceRecord, size: number): void {
    if (space.usedBytes + BigInt(size) > space.quotaBytes) overQuota(space);
  }

  /** Charges bytes about to be written against the quota, atomically, or refuses; kept through a recount for `liveS`. */
  async function charge(space: SpaceRecord, size: number, liveS: number, ref: ChargeRef | null): Promise<void> {
    if (!await store.chargeBytes(space.id, BigInt(size), new Date(Date.now() + liveS * 1000), ref)) overQuota(space);
  }

  function declaredSize(size: unknown): number {
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) fail(400, 'size (bytes) is required', 'invalid_size');
    if (size > MAX_FILE_BYTES) fail(413, 'Files are limited to 5 GiB', 'file_too_large');
    return size;
  }

  async function checkDeclaredSize(space: SpaceRecord, size: unknown): Promise<number> {
    const n = declaredSize(size);
    checkQuota(space, n);
    return n;
  }

  /**
   * Records a stored object's file.put once. usedBytes was already charged
   * when its URLs were signed (each bound to its content length), so a client
   * that never confirms can't write past the quota; URLs signed and not used
   * stay charged until the hourly recount. A confirm for a version already
   * recorded (its last-modified time is not after the newest file.put for the
   * path) records nothing.
   */
  async function recordPut(res: Response, loaded: Loaded, path: string, objects: SpaceObjects): Promise<number> {
    const head = await objects.head(objectKey(loaded.space.id, path));
    if (!head) fail(409, `${path} was not uploaded`, 'not_uploaded');
    const counted = head.lastModified ? await store.lastPutAt(loaded.space.id, path) : null;
    if (counted && head.lastModified && counted >= head.lastModified) return head.size;
    await event(res, loaded.space, loaded.access, 'file.put', { path, bytes: head.size });
    return head.size;
  }

  router.post('/:space/files/uploaded', handler(async (req, res) => {
    const loaded = await load(req, res, 'editor');
    throttle(callerOf(res));
    const path = normalizeFilePath(bodyOf(req).path);
    const size = await recordPut(res, loaded, path, await deps.objects());
    res.json({ ok: true, path, size });
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
    const parts = await (await deps.objects()).presignParts(objectKey(space.id, path), String(req.params.uploadId), sized);
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
    const objects = await deps.objects();
    await objects.completeMultipart(objectKey(loaded.space.id, path), String(req.params.uploadId), parts as Array<{ partNumber: number; etag: string }>);
    const size = await recordPut(res, loaded, path, objects);
    res.json({ ok: true, path, size });
  }));

  router.delete('/:space/uploads/:uploadId', handler(async (req, res) => {
    const { space } = await load(req, res, 'editor');
    const path = normalizeFilePath(req.query.path);
    await (await deps.objects()).abortMultipart(objectKey(space.id, path), String(req.params.uploadId));
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
    const objects = await deps.objects();

    let sources: Array<{ key: string; size: number }>;
    if (isDir) {
      const found = await keysUnder(objects, objectKey(space.id, from), MAX_MOVE_OBJECTS);
      if (found.more) fail(413, `Moving a folder is limited to ${MAX_MOVE_OBJECTS} files`, 'move_too_large');
      sources = found.keys;
    } else {
      const head = await objects.head(objectKey(space.id, from));
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
      await objects.copy(s.key, dest);
      moved.push(s.key);
    }
    const failed = await objects.deleteKeys(moved);
    await event(res, space, access, 'file.mv', { path: `${from} -> ${to}`, bytes: total });
    res.json({ ok: failed.length === 0, moved: moved.length, failed: failed.map(k => pathOfKey(space.id, k)) });
  }));

  router.delete('/:space/files', handler(async (req, res) => {
    const { space, access } = await load(req, res, 'editor');
    const recursive = req.query.recursive === '1' || req.query.recursive === 'true';
    const objects = await deps.objects();
    let keys: string[];
    let label: string;
    if (recursive) {
      const prefix = normalizePrefix(req.query.path);
      if (!prefix) fail(400, 'Deleting the whole space is DELETE /spaces/:space', 'invalid_path');
      keys = (await keysUnder(objects, objectKey(space.id, prefix), Number.POSITIVE_INFINITY)).keys.map(k => k.key);
      label = prefix;
    } else {
      const path = normalizeFilePath(req.query.path);
      if (!await objects.head(objectKey(space.id, path))) fail(404, `No file ${path} in ${space.name}`, 'file_not_found');
      keys = [objectKey(space.id, path)];
      label = path;
    }
    const failed = keys.length ? await objects.deleteKeys(keys) : [];
    await event(res, space, access, 'file.rm', { path: label });
    res.json({ ok: failed.length === 0, deleted: keys.length - failed.length, failed: failed.map(k => pathOfKey(space.id, k)) });
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
      })),
    });
  }));

  router.use(handler(async () => notFound()));

  return router;
}
