/**
 * Optimistic concurrency for every space file write.
 * A writer says which version it read (`ifMatch`, an ETag) or
 * that the file must not exist yet (`ifNoneMatch: '*'`), and a write that
 * would replace anything else is refused with 412 `changed`. Nothing is
 * written then, and the answer says what the file is now and who wrote it.
 *
 * The orchestrator checks three times, so the guard doesn't rest on storage
 * alone (S3, and Floci 2.1.0 on the e2e stack, enforce a signed PUT's If-Match;
 * not every S3-compatible store does, nor every path):
 *   1. before it signs: the file's current version (HEAD) must match;
 *   2. when the write is confirmed (`files/uploaded`, multipart `complete`):
 *      the version the new one landed on must be the one expected. If it
 *      isn't, the orchestrator puts that version back as the current one, so
 *      the confirmed write never stays over a newer one (the refused bytes
 *      stay in the bucket's history);
 *   3. for a move or a single-file delete: the version is checked by HEAD
 *      just before (a move's copy also signs CopySourceIfMatch).
 * A write that skips the confirm (a raw presigned PUT) is caught only by S3's
 * own conditional, where S3 enforces it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PutCondition } from './spaceMemory';

export interface ObjectVersionInfo { versionId: string | null; etag: string | null; lastModified: Date | null; deleteMarker: boolean }

/** Null when the current version (`etag`, null for no file) satisfies the condition, else what it is now. */
export function currentConflict(condition: PutCondition | null, current: { etag: string | null } | null): { now: string | null } | null {
  if (!condition) return null;
  const now = current?.etag ?? null;
  if (condition.ifNoneMatch) return now === null ? null : { now };
  return now !== null && sameEtag(now, condition.ifMatch!) ? null : { now };
}

/** ETags compare without their quotes (and a weak `W/`), as S3 and browsers may send them either way. */
export function sameEtag(a: string, b: string): boolean {
  const bare = (s: string) => s.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return bare(a) === bare(b);
}

export type LandedCheck =
  | { ok: true }
  | { ok: false; now: string | null; restore: { kind: 'version'; versionId: string } | null };

/** A version id a store without history gives (S3 says "null" for an unversioned bucket's objects). */
export const isRealVersionId = (id: string | null) => id !== null && id !== '' && id !== 'null';

/**
 * The proof a conditional PUT carries (its signed `x-amz-meta-termag-upload`
 * header, which S3 keeps on the version it makes): who it was signed for,
 * for which path and condition, under the server's secret. A confirm may act
 * on a version (restore the one under it) only when that version carries the
 * confirming caller's proof: a client's word for which ETag is its write
 * never puts anyone's version back (Security Agent, #769).
 */
export function uploadProof(secret: string, f: { spaceId: string; path: string; caller: string; condition: PutCondition }): string {
  const cond = f.condition.ifNoneMatch ? 'new' : sameEtagKey(f.condition.ifMatch!);
  return createHmac('sha256', secret).update(`space-upload|${f.spaceId}|${f.path}|${f.caller}|${cond}`).digest('hex').slice(0, 40);
}

const sameEtagKey = (etag: string) => etag.trim().replace(/^W\//, '').replace(/^"|"$/g, '');

export function uploadProofHolds(secret: string, proof: string | null, f: Parameters<typeof uploadProof>[1]): boolean {
  if (!proof) return false;
  const want = Buffer.from(uploadProof(secret, f));
  const got = Buffer.from(proof);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Whether a write landed on the version its writer expected. `versions` are
 * the key's, newest first (delete markers included); `ours` is the ETag the
 * write produced. It never loses a write: it answers a conflict only when it
 * can see, in real version history, a newer and different version from
 * someone else right under ours, and `restore` puts that version back only
 * while ours is still the current one. Every case it can't be sure of passes,
 * and the checks before signing and S3's own conditional stay the guard:
 *   - a store without version history (one listed version, or ids "null");
 *   - a write whose ETag isn't known or isn't among the versions;
 *   - the file removed after it was read (a delete marker is no one's newer
 *     version: the write stands);
 *   - versions with ours's bytes right under it (the same writer retrying, or
 *     someone else writing the same content).
 * It never removes anything.
 */
export function landedCheck(condition: PutCondition | null, versions: ObjectVersionInfo[], ours: string | null): LandedCheck {
  const ok = { ok: true as const };
  if (!condition || !ours) return ok;
  const real = versions.filter(v => v.deleteMarker || isRealVersionId(v.versionId));
  if (real.length < 2 || real.length !== versions.length) return ok;
  const at = real.findIndex(v => !v.deleteMarker && v.etag !== null && sameEtag(v.etag, ours));
  if (at < 0) return ok;
  let below = at + 1;
  while (below < real.length && !real[below].deleteMarker && real[below].etag !== null && sameEtag(real[below].etag!, ours)) below++;
  const before = real[below] ?? null;
  if (!before || before.deleteMarker || before.etag === null) return ok;
  // The version right under ours is what it replaced: the one expected, or someone else's.
  if (condition.ifMatch && sameEtag(before.etag, condition.ifMatch)) return ok;
  return { ok: false, now: before.etag, restore: at === 0 && before.versionId ? { kind: 'version', versionId: before.versionId } : null };
}

/** The 412 a refused write answers, in the words the CLI and the browser show. */
export function changedBody(space: string, path: string, yours: PutCondition, now: string | null, last: { by: string | null; box: string | null; at: Date } | null) {
  const mine = yours.ifNoneMatch ? 'new' : yours.ifMatch!;
  const who = last ? ` by ${last.by ?? 'someone'}${last.box ? ` (${last.box})` : ''} at ${last.at.toISOString()}` : '';
  return {
    error: now === null && yours.ifNoneMatch === undefined
      ? `${space}:${path} changed since you read it (yours ${mine}, now gone${who})`
      : yours.ifNoneMatch
        ? `${space}:${path} already exists (now ${now}${who})`
        : `${space}:${path} changed since you read it (yours ${mine}, now ${now}${who})`,
    code: 'changed',
    path, yours: mine, now,
    ...(last ? { by: last.by, box: last.box, at: last.at.toISOString() } : {}),
  };
}
