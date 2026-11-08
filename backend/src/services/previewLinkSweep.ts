/**
 * The preview links' leader sweep ("Lifetime
 * and sweeps"), every minute beside the preview share sweep:
 *
 * - ends links past their audience's expiresAt (`expired`), live links of an
 *   archived project (`project-gone`: archiving ends them, and this retries
 *   one whose end failed), and links whose
 *   box has gone (`box-gone`: the project lost its box, or the box was
 *   terminated), each through the audience core's endPreviewAudience, which
 *   reaches every delivery: the link's end hook (previewLinks.ts
 *   installPreviewLinkDelivery) holds the name 30 days from now if that's
 *   later, revokes every session, drops the codes and tells the relay;
 * - deletes PreviewLinkName rows past reservedUntil whose link is gone or ended;
 * - deletes PreviewLinkCode rows past expiresAt, and PreviewLinkSession rows
 *   past expiresAt or revoked more than a day ago;
 * - expires PreviewLinkRequest rows pending more than 24 h.
 *
 * The kill switch ends nothing: it refuses at the session check, so turning
 * it off restores every link. Over a store, so its rules are a unit test
 * (previewLinkSweep.test.ts).
 */
import { prisma } from '../db';
import { endPreviewAudience, type AudienceEndReason } from './previewAudience';
import { linkEnded, setLiveLinks } from './previewLinkTelemetry';

export const PREVIEW_LINK_SWEEP_MS = 60_000;
/** A revoked session's row is kept this long, for the owner's view of who was cut off. */
export const REVOKED_SESSION_KEEP_MS = 24 * 3600_000;
/** An agent's pending request lapses after this (P4). */
export const REQUEST_TTL_MS = 24 * 3600_000;
const BATCH = 200;

export interface EndableLink {
  id: string;
  name: string;
  audienceId: string;
  ownerId: string;
  boxId: string | null;
}

export interface PreviewLinkSweepStore {
  /** End the link's audience, and so the link (endPreviewAudience). False when it had already ended. */
  endAudience(audienceId: string, reason: AudienceEndReason, now: Date): Promise<boolean>;
  /** Links not ended whose expiresAt has passed. */
  expiredLinks(now: Date, limit: number): Promise<EndableLink[]>;
  /** Live links whose project has no box, or whose box was terminated. */
  boxGoneLinks(now: Date, limit: number): Promise<EndableLink[]>;
  /** Live links of an archived project: archiving ends them (endPreviewAudiences), and this retries one whose end failed. */
  archivedLinks(now: Date, limit: number): Promise<EndableLink[]>;
  /** Delete reservations past their hold whose link is gone or ended; how many. */
  deleteLapsedNames(now: Date): Promise<number>;
  deleteExpiredCodes(now: Date): Promise<number>;
  /** Sessions past expiresAt, or revoked before `revokedBefore`. */
  deleteDeadSessions(now: Date, revokedBefore: Date): Promise<number>;
  expireRequests(createdBefore: Date, now: Date): Promise<number>;
  countLive(now: Date): Promise<number>;
}

export interface SweepResult {
  expired: number;
  boxGone: number;
  archived: number;
  names: number;
  codes: number;
  sessions: number;
  requests: number;
  live: number;
}

export async function runPreviewLinkSweep(store: PreviewLinkSweepStore, now: Date): Promise<SweepResult> {
  const end = async (links: EndableLink[], reason: 'expired' | 'box-gone' | 'project-gone') => {
    let n = 0;
    for (const l of links) {
      if (!(await store.endAudience(l.audienceId, reason, now))) continue;
      n++;
      linkEnded(l.ownerId, l.boxId, { reason });
    }
    return n;
  };
  const expired = await end(await store.expiredLinks(now, BATCH), 'expired');
  const boxGone = await end(await store.boxGoneLinks(now, BATCH), 'box-gone');
  // The host refuses these already (previewHostStore.served); ending them holds their names and drops their sessions.
  const archived = await end(await store.archivedLinks(now, BATCH), 'project-gone');
  const names = await store.deleteLapsedNames(now);
  const codes = await store.deleteExpiredCodes(now);
  const sessions = await store.deleteDeadSessions(now, new Date(now.getTime() - REVOKED_SESSION_KEEP_MS));
  const requests = await store.expireRequests(new Date(now.getTime() - REQUEST_TTL_MS), now);
  const live = await store.countLive(now);
  setLiveLinks(live);
  const result = { expired, boxGone, archived, names, codes, sessions, requests, live };
  if (expired || boxGone || archived || names || requests) {
    console.log(`[PREVIEW-LINK] sweep ended ${expired} expired, ${boxGone} box-gone and ${archived} archived-project link(s); freed ${names} name(s); expired ${requests} request(s)`);
  }
  return result;
}

const endable = { id: true, name: true, audienceId: true, audience: { select: { ownerId: true, project: { select: { instanceId: true } } } } } as const;
const asEndable = (r: { id: string; name: string; audienceId: string; audience: { ownerId: string; project: { instanceId: string | null } } }): EndableLink =>
  ({ id: r.id, name: r.name, audienceId: r.audienceId, ownerId: r.audience.ownerId, boxId: r.audience.project.instanceId });

// The link tables are this sweep's to read and clean (previewAudienceIsolation.test.ts lists it); the audience's
// own end goes through the core. A link is live while its audience is: no expiry or end on the link itself.
export const prismaPreviewLinkSweepStore: PreviewLinkSweepStore = {
  async endAudience(audienceId, reason, now) {
    const before = await prisma.previewLink.findFirst({ where: { audienceId, audience: { endedAt: null } }, select: { id: true } });
    if (!before) return false;
    await endPreviewAudience(audienceId, reason, null, now);
    return true;
  },
  async expiredLinks(now, limit) {
    const rows = await prisma.previewLink.findMany({ where: { audience: { endedAt: null, expiresAt: { lte: now } } }, select: endable, take: limit });
    return rows.map(asEndable);
  },
  async boxGoneLinks(now, limit) {
    const rows = await prisma.previewLink.findMany({
      where: { audience: { endedAt: null, expiresAt: { gt: now }, project: { OR: [{ instanceId: null }, { instance: { status: 'terminated' } }] } } },
      select: endable, take: limit,
    });
    return rows.map(asEndable);
  },
  async archivedLinks(now, limit) {
    const rows = await prisma.previewLink.findMany({ where: { audience: { endedAt: null, expiresAt: { gt: now }, project: { archived: true } } }, select: endable, take: limit });
    return rows.map(asEndable);
  },
  async deleteLapsedNames(now) {
    // One statement, its conditions re-read by it: a publish that took the name meanwhile moved reservedUntil or linkId.
    const n = await prisma.previewLinkName.deleteMany({
      where: { reservedUntil: { lte: now }, OR: [{ linkId: null }, { link: { audience: { endedAt: { not: null } } } }, { link: { audience: { expiresAt: { lte: now } } } }] },
    });
    return n.count;
  },
  async deleteExpiredCodes(now) {
    return (await prisma.previewLinkCode.deleteMany({ where: { expiresAt: { lte: now } } })).count;
  },
  async deleteDeadSessions(now, revokedBefore) {
    return (await prisma.previewLinkSession.deleteMany({ where: { OR: [{ expiresAt: { lte: now } }, { revokedAt: { lte: revokedBefore } }] } })).count;
  },
  async expireRequests(createdBefore, now) {
    return (await prisma.previewLinkRequest.updateMany({ where: { state: 'pending', createdAt: { lte: createdBefore } }, data: { state: 'expired', decidedAt: now } })).count;
  },
  countLive: (now) => prisma.previewLink.count({ where: { audience: { endedAt: null, expiresAt: { gt: now } } } }),
};

let timer: ReturnType<typeof setInterval> | null = null;

export function startPreviewLinkSweep(intervalMs = PREVIEW_LINK_SWEEP_MS): void {
  if (timer) return;
  const tick = () => { runPreviewLinkSweep(prismaPreviewLinkSweepStore, new Date()).catch(err => console.error('[PREVIEW-LINK] sweep failed:', err)); };
  timer = setInterval(tick, intervalMs);
  timer.unref();
}

export function stopPreviewLinkSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
