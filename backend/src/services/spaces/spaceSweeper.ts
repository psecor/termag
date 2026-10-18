/**
 * The hourly spaces sweep, leader work (index.ts startLeaderWork):
 *
 *   - purge every version under a deleted space's prefix, then drop its row;
 *   - recount each live space's usedBytes from ListObjectVersions plus the
 *     parts of its in-progress multipart uploads, since signing charges it
 *     but nothing else lowers or corrects it, keeping on top of what S3 holds
 *     every charge whose URLs are still live (SpaceCharge) and whose bytes
 *     haven't landed yet (settledCharges); an upload left unfinished for
 *     MULTIPART_MAX_AGE_MS is aborted first (the bucket's lifecycle rule does
 *     the same after a day; this keeps the count right without waiting on it);
 *   - drop SpaceBox rows of terminated boxes (the access check refuses them
 *     already, this keeps the Members tab honest);
 *   - prune SpaceEvent rows older than 90 days.
 *
 * With no spaces at all it makes no AWS call, so a deployment that never
 * turns the flag on never needs the bucket.
 */
import type { OpenUpload, SpaceObjects } from './spaceObjects';
import { spacePrefix } from './spacePaths';
import type { LiveCharge, SpaceStore } from './spaceStore';

export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const MULTIPART_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A deleted space's uploads are all aborted, however recent. */
const ABORT_ALL = new Date(8.64e15);

export interface SweepResult { purged: number; recounted: number; uploadsAborted: number; grantsPruned: number; eventsPruned: number; errors: string[] }

export async function sweepSpaces(store: SpaceStore, objects: () => Promise<SpaceObjects>, now = Date.now()): Promise<SweepResult> {
  const result: SweepResult = { purged: 0, recounted: 0, uploadsAborted: 0, grantsPruned: 0, eventsPruned: 0, errors: [] };
  result.grantsPruned = await store.pruneTerminatedGrants();
  result.eventsPruned = await store.pruneEvents(new Date(now - EVENT_RETENTION_MS));
  await store.pruneCharges(new Date(now));

  const [deleted, live] = await Promise.all([store.deletedSpaces(), store.liveSpaces()]);
  if (deleted.length === 0 && live.length === 0) return result;
  const s3 = await objects();

  for (const space of deleted) {
    try {
      result.uploadsAborted += (await s3.sweepMultipart(spacePrefix(space.id), ABORT_ALL)).aborted;
      await s3.purgePrefix(spacePrefix(space.id));
      await store.deleteSpaceRow(space.id);
      result.purged++;
    } catch (err) {
      result.errors.push(`purge ${space.id}: ${(err as Error).message}`);
    }
  }
  for (const space of live) {
    try {
      // Read before listing, so every charged upload that is still open shows up in the listing.
      const charges = await store.liveCharges(space.id, new Date(now));
      const uploads = await s3.sweepMultipart(spacePrefix(space.id), new Date(now - MULTIPART_MAX_AGE_MS));
      result.uploadsAborted += uploads.aborted;
      const settled = await settledCharges(s3, charges, new Set(uploads.inProgress.map(u => u.uploadId)));
      const stored = await s3.sumVersions(spacePrefix(space.id)) + uncoveredPartBytes(uploads.inProgress, charges);
      await store.recountUsedBytes(space.id, stored, new Date(now), settled);
      result.recounted++;
    } catch (err) {
      result.errors.push(`recount ${space.id}: ${(err as Error).message}`);
    }
  }
  return result;
}

/**
 * Live charges whose bytes S3 already holds, so the recount must not add them
 * again: a part batch whose upload is no longer open (completed, so its parts
 * are a version now, or aborted), and a single PUT whose object has a version
 * written since the charge (S3's LastModified has whole seconds). A move's
 * charge (no key) is always kept until it expires.
 */
export async function settledCharges(s3: SpaceObjects, charges: LiveCharge[], open: Set<string>): Promise<string[]> {
  const settled: string[] = [];
  const heads = new Map<string, Promise<Date | null>>();
  for (const c of charges) {
    if (c.uploadId) {
      if (!open.has(c.uploadId)) settled.push(c.id);
      continue;
    }
    if (!c.key) continue;
    if (!heads.has(c.key)) heads.set(c.key, s3.head(c.key).then(h => h?.lastModified ?? null));
    const landed = await heads.get(c.key)!;
    if (landed && landed.getTime() >= Math.floor(c.createdAt.getTime() / 1000) * 1000) settled.push(c.id);
  }
  return settled;
}

/** Bytes of an open upload's parts that no live charge paid for (their charge expired, or there never was one). */
export function uncoveredPartBytes(uploads: OpenUpload[], charges: LiveCharge[]): bigint {
  const covered = new Set(charges.flatMap(c => c.uploadId ? c.partNumbers.map(n => `${c.uploadId}:${n}`) : []));
  let total = 0n;
  for (const u of uploads) for (const p of u.parts) if (!covered.has(`${u.uploadId}:${p.partNumber}`)) total += p.bytes;
  return total;
}

export function spacesSweep(store: SpaceStore, objects: () => Promise<SpaceObjects>) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let first: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await sweepSpaces(store, objects);
      if (r.purged || r.uploadsAborted || r.grantsPruned || r.eventsPruned || r.errors.length) {
        console.log(`[SPACES] sweep: purged ${r.purged}, recounted ${r.recounted}, uploads aborted ${r.uploadsAborted}, grants pruned ${r.grantsPruned}, events pruned ${r.eventsPruned}${r.errors.length ? `, errors: ${r.errors.join('; ')}` : ''}`);
      }
    } catch (err) {
      console.warn(`[SPACES] sweep failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
      timer.unref();
      first = setTimeout(() => void tick(), 60_000);
      first.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      if (first) clearTimeout(first);
      timer = null;
      first = null;
    },
  };
}
