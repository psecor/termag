/**
 * Space file operations with no HTTP in them (milestone M4): loading a space for a caller, recording its events,
 * the quota, and the conditional-write checks. routes/spaces.ts is a thin
 * layer over these; the Slack surface calls them directly, as the requester.
 *
 * Every operation takes its caller explicitly. One that records an event
 * takes a SpaceOpContext, which also says which surface the request came
 * from and, for a write done for someone else, on whose behalf.
 *
 * A refusal is a SpaceOpError carrying the HTTP status, message and code the
 * spaces API answers with, so the router's answers are unchanged.
 */
import { resolveSpaceAccess, roleAtLeast, type SpaceAccess, type SpaceCaller, type SpaceRole } from './spaceAccess';
import { ancestorsOf } from './spaceInheritance';
import type { PresignerIdentity, SpaceObjects } from './spaceObjects';
import { objectKey } from './spacePaths';
import type { PutCondition } from './spaceMemory';
import { changedBody, currentConflict, isRealVersionId, landedCheck, sameEtag, uploadProofHolds } from './spaceVersions';
import type { ChargeRef, SpaceRecord, SpaceStore } from './spaceStore';
import { fileChangeOf, type FileChange } from './spaceFileBus';

/** Where a request came from; null (or unset) is the web UI and CLI, as for every event before M3. */
export type SpaceSurface = 'slack';

/** Who acts, and for whom. */
export interface SpaceOpContext {
  caller: SpaceCaller;
  surface?: SpaceSurface | null;
  /** The space member a Slack-originated write is done for (tech spec §7, §9). */
  onBehalfOfUserId?: string | null;
}

export interface Loaded { space: SpaceRecord; access: SpaceAccess }

export interface EventExtra {
  path?: string | null;
  bytes?: number | bigint | null;
  /** A put's new version, for the live change; not stored. */
  etag?: string | null;
  versionId?: string | null;
  note?: string | null;
}

/** A refusal, with the status and body the spaces API answers it with. */
export class SpaceOpError extends Error {
  constructor(readonly status: number, message: string, readonly code: string, readonly extra: Record<string, unknown> = {}) { super(message); }
}

export function fail(status: number, message: string, code: string, extra: Record<string, unknown> = {}): never {
  throw new SpaceOpError(status, message, code, extra);
}

export function notFound(): never {
  fail(404, 'Not found', 'not_found');
}

export const MAX_FILE_BYTES = 5 * 1024 * 1024 * 1024;

/** Whether storage refused a conditional request (412 PreconditionFailed). */
export function preconditionFailed(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.$metadata?.httpStatusCode === 412 || e?.name === 'PreconditionFailed';
}

/** Who a proof is signed for: a person, or one of their boxes. */
export function proofCaller(c: SpaceCaller): string {
  return c.kind === 'box' ? `${c.userId}/${c.instanceId}` : c.userId;
}

/** A declared upload size, checked against the per-file limit. */
export function declaredSize(size: unknown): number {
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) fail(400, 'size (bytes) is required', 'invalid_size');
  if (size > MAX_FILE_BYTES) fail(413, 'Files are limited to 5 GiB', 'file_too_large');
  return size;
}

export interface SpaceFileOpsDeps {
  store: SpaceStore;
  /** The S3 side, over a presigner session named for who acts (routes/spaces.ts SpacesRouterDeps.objects). */
  objects: (identity: PresignerIdentity) => Promise<SpaceObjects>;
  /** A file was put, moved or removed; called after the change's event is recorded, never awaited. */
  onFileChange?: (change: FileChange) => void;
  /** The secret a conditional PUT's proof is made with; defaults to SESSION_SECRET. */
  uploadSecret?: () => string;
}

export type SpaceFileOps = ReturnType<typeof spaceFileOps>;

export function spaceFileOps(deps: SpaceFileOpsDeps) {
  const { store } = deps;

  const proofSecret = () => (deps.uploadSecret ? deps.uploadSecret() : process.env.SESSION_SECRET ?? 'dev-secret');

  /** The caller's access to a space, or null when they have none (a 404 to them). */
  async function accessFor(caller: SpaceCaller, space: SpaceRecord): Promise<SpaceAccess | null> {
    const [members, grantedBoxIds] = await Promise.all([store.memberRoles(space.id), store.grantedBoxIds(space.id)]);
    if (caller.kind === 'user') return resolveSpaceAccess(caller, { space, members, grantedBoxIds });
    const box = await store.box(caller.instanceId);
    const ancestors = box ? await ancestorsOf(box, id => store.box(id)) : [];
    return resolveSpaceAccess(caller, { space, members, grantedBoxIds, box, ancestors });
  }

  /**
   * The space `ref` (an id or name) with the caller's access, refused unless
   * they hold `needed`. A person with pending invites claims them and looks
   * again. A space they have no role in is a 404, so names don't leak.
   */
  async function load(caller: SpaceCaller, ref: string, needed: SpaceRole): Promise<Loaded> {
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

  /** The S3 side, signing as the caller (a person, or a box with its owner). */
  async function objectsFor(caller: SpaceCaller): Promise<SpaceObjects> {
    if (caller.kind === 'box') {
      const box = await store.box(caller.instanceId);
      return deps.objects({
        kind: 'box', instanceId: caller.instanceId, name: box?.name ?? null, ownerUserId: caller.userId, ownerEmail: box?.ownerEmail ?? null,
      });
    }
    const user = await store.ldUser(caller.userId);
    return deps.objects({ kind: 'user', userId: caller.userId, email: user?.googleEmail ?? null });
  }

  /** Records the event; a file.put, file.mv or file.rm also goes out as a live change (`etag`: a put's new version). */
  async function event(ctx: SpaceOpContext, space: SpaceRecord, access: SpaceAccess | null, action: string, { etag, ...extra }: EventExtra = {}) {
    const { caller } = ctx;
    await store.recordEvent({
      spaceId: space.id,
      actorUserId: caller.userId,
      actorInstanceId: caller.kind === 'box' ? caller.instanceId : null,
      via: access?.boxAccess?.kind === 'inherited' ? access.boxAccess.via : null,
      action,
      ...extra,
      // Where the request came from and whom it was for (tech spec §3.2, §9);
      // null for the web UI and the CLI (routes/spaces.ts ctxOf).
      surface: ctx.surface ?? null,
      onBehalfOfUserId: ctx.onBehalfOfUserId ?? null,
    });
    const change = deps.onFileChange ? fileChangeOf(space.id, action, extra.path ?? null, etag ?? null) : null;
    if (change) deps.onFileChange!(change);
  }

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

  /** A declared upload size, within the per-file limit and the space's quota. */
  function checkDeclaredSize(space: SpaceRecord, size: unknown): number {
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
  async function recordPut(ctx: SpaceOpContext, loaded: Loaded, path: string, objects: SpaceObjects, note: string | null = null) {
    const head = await objects.head(objectKey(loaded.space.id, path));
    if (!head) fail(409, `${path} was not uploaded`, 'not_uploaded');
    const counted = head.lastModified ? await store.lastPutAt(loaded.space.id, path) : null;
    if (counted && head.lastModified && counted >= head.lastModified) return head;
    await event(ctx, loaded.space, loaded.access, 'file.put', { path, bytes: head.size, etag: head.etag, versionId: head.versionId ?? null, note });
    return head;
  }

  /** 412 `changed`, with who wrote the file last and when, unless the current version satisfies the condition. */
  async function refuseIfChanged(loaded: Loaded, path: string, condition: PutCondition, current: { etag?: string | null } | null): Promise<void> {
    const conflict = currentConflict(condition, current ? { etag: current.etag ?? null } : null);
    if (conflict) await failChanged(loaded, path, condition, conflict.now);
  }

  /** The 412 `changed`, naming the path's last writer and `now`, the version current now. */
  async function failChanged(loaded: Loaded, path: string, condition: PutCondition, now: string | null): Promise<never> {
    const last = await store.lastWrite(loaded.space.id, path);
    let who: { by: string | null; box: string | null; at: Date } | null = null;
    if (last) {
      const member = (await store.members(loaded.space.id)).find(m => m.userId === last.actorUserId);
      const box = last.actorInstanceId ? (await store.box(last.actorInstanceId))?.name ?? null : null;
      who = { by: member?.user.email ?? null, box, at: last.at };
    }
    const { error, code, ...extra } = changedBody(loaded.space.name, path, condition, now, who);
    fail(412, error, code, extra);
  }

  /**
   * The confirm's check (spaceVersions.ts landedCheck): the write landed on
   * the version its writer expected, or the version it replaced is put back
   * and the answer is 412. For any storage that ignored the condition.
   *
   * `ours` is the version this confirm says it wrote. From a multipart
   * complete it is S3's answer (`trusted`). From a single PUT's confirm it is
   * the client's word, so the version must carry this caller's proof for
   * this path and condition (uploadProof, signed into the PUT) before
   * anything acts on it: a confirm naming someone else's version is 412,
   * with nothing copied and nothing recorded. A restore copies only while
   * ours is still the current version (CopyObject If-Match): a write that
   * landed after the check stays, and the 412 names it. A restore that
   * happens is recorded (`file.put.reverted`), goes out as a live change, and
   * its 412 names the restored copy's ETag, the version current now.
   */
  async function checkLanded(
    ctx: SpaceOpContext, loaded: Loaded, path: string, objects: SpaceObjects, condition: PutCondition | null, ours: string | null, trusted = false,
  ): Promise<void> {
    if (!condition) return;
    const key = objectKey(loaded.space.id, path);
    const versions = await objects.versionsOf(key, 10);
    const named = ours ? versions.find(v => !v.deleteMarker && v.etag !== null && sameEtag(v.etag, ours)) : undefined;
    if (!trusted && named && isRealVersionId(named.versionId)) {
      const proof = await objects.uploadProofOf(key, named.versionId!);
      if (!uploadProofHolds(proofSecret(), proof, { spaceId: loaded.space.id, path, caller: proofCaller(ctx.caller), condition })) {
        await failChanged(loaded, path, condition, versions.find(v => !v.deleteMarker)?.etag ?? null);
      }
    }
    const check = landedCheck(condition, versions, ours);
    if (check.ok) return;
    if (check.restore?.kind === 'version') {
      let restored: string | null = null;
      try {
        restored = (await objects.restoreVersion(key, check.restore.versionId, named?.etag ?? ours)).etag;
      } catch (err) {
        if (!preconditionFailed(err)) throw err;
        // Someone wrote after the check: theirs stays current, and is what the 412 names.
        await failChanged(loaded, path, condition, (await objects.head(key))?.etag ?? null);
      }
      const now = restored ?? (await objects.head(key))?.etag ?? check.now;
      await event(ctx, loaded.space, loaded.access, 'file.put.reverted', { path, etag: now });
      await failChanged(loaded, path, condition, now);
    }
    await failChanged(loaded, path, condition, check.now);
  }

  return {
    accessFor, load, objectsFor, event, checkQuota, charge, checkDeclaredSize, recordPut, refuseIfChanged, failChanged, checkLanded, proofSecret,
  };
}
