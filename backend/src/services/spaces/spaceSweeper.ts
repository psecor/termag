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
import type { ObjectVersion, OpenUpload, SpaceObjects } from './spaceObjects';
import { spacePrefix } from './spacePaths';
import type { LiveCharge, SpaceStore } from './spaceStore';

export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const MULTIPART_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * How long an expired charge is kept for matching versions to charges: the
 * longest a signed URL lives (PART_TTL_S in routes/spaces.ts), so a version an
 * expired URL wrote is never mistaken for a live charge's.
 */
export const CHARGE_MATCH_WINDOW_MS = 30 * 60 * 1000;
/** A deleted space's uploads are all aborted, however recent. */
const ABORT_ALL = new Date(8.64e15);

export interface SweepResult { purged: number; recounted: number; uploadsAborted: number; grantsPruned: number; eventsPruned: number; errors: string[] }

export async function sweepSpaces(store: SpaceStore, objects: () => Promise<SpaceObjects>, now = Date.now()): Promise<SweepResult> {
  const result: SweepResult = { purged: 0, recounted: 0, uploadsAborted: 0, grantsPruned: 0, eventsPruned: 0, errors: [] };
  result.grantsPruned = await store.pruneTerminatedGrants();
  result.eventsPruned = await store.pruneEvents(new Date(now - EVENT_RETENTION_MS));
  await store.pruneCharges(new Date(now - CHARGE_MATCH_WINDOW_MS));

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
      // Read before listing, so every charged write that has landed shows up in the listings.
      const charges = await store.chargesLiveAfter(space.id, new Date(now - CHARGE_MATCH_WINDOW_MS));
      const uploads = await s3.sweepMultipart(spacePrefix(space.id), new Date(now - MULTIPART_MAX_AGE_MS));
      result.uploadsAborted += uploads.aborted;
      const watch = new Set(charges.flatMap(c => c.key && !c.uploadId ? [c.key] : []));
      const versions = await s3.sumVersions(spacePrefix(space.id), watch);
      const settled = settledCharges(charges, new Set(uploads.inProgress.map(u => u.uploadId)), versions.watched);
      const live = charges.filter(c => c.liveUntil.getTime() > now);
      await store.recountUsedBytes(space.id, versions.total + uncoveredPartBytes(uploads.inProgress, live), new Date(now), settled);
      result.recounted++;
    } catch (err) {
      result.errors.push(`recount ${space.id}: ${(err as Error).message}`);
    }
  }
  return result;
}

/**
 * Charges whose bytes S3 already holds, so the recount must not add them
 * again: a part batch whose upload is no longer open (completed, so its parts
 * are a version now, or aborted), and a single PUT matched to a version of its
 * key. A signed PUT binds its content length, so a version can only be a
 * charge's of the same size signed before it was written and not expired by
 * then (S3's LastModified has whole seconds); each version settles at most one charge, the earliest
 * such, so a second URL for the same key stays charged until its own version
 * lands. A move's charge (no key) is kept until it expires.
 */
export function settledCharges(charges: LiveCharge[], open: Set<string>, versions: ObjectVersion[]): string[] {
  const settled: string[] = [];
  const puts = new Map<string, LiveCharge[]>();
  for (const c of charges) {
    if (c.uploadId) {
      if (!open.has(c.uploadId)) settled.push(c.id);
    } else if (c.key) {
      puts.set(c.key, [...(puts.get(c.key) ?? []), c]);
    }
  }
  for (const c of puts.values()) c.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const v of [...versions].sort((a, b) => a.lastModified.getTime() - b.lastModified.getTime())) {
    const candidates = puts.get(v.key);
    const i = candidates?.findIndex(c => c.bytes === v.size
      && Math.floor(c.createdAt.getTime() / 1000) * 1000 <= v.lastModified.getTime()
      && v.lastModified.getTime() <= c.liveUntil.getTime()) ?? -1;
    if (i < 0) continue;
    settled.push(candidates![i].id);
    candidates!.splice(i, 1);
  }
  return settled;
}

/** Bytes of an open upload's parts that none of `live` paid for (their charge expired, or there never was one). */
export function uncoveredPartBytes(uploads: OpenUpload[], live: LiveCharge[]): bigint {
  const covered = new Set(live.flatMap(c => c.uploadId ? c.partNumbers.map(n => `${c.uploadId}:${n}`) : []));
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
