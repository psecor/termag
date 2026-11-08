/**
 * Confirming, in the browser, a preview link change asked for from a box
 * (security review SR5, "an agent publishing a port"; decided 2026-11-04).
 *
 * A device sign-in made on a box (CliSession.issuedOnBoxId) saves a token
 * every process on that box can read, an agent's included. So from such a
 * sign-in:
 * - an "only me" (owner) publish, renew or extend applies at once, as from
 *   a laptop: it shows the app to nobody new;
 * - one that creates or widens a `people` or `link` audience, or extends one,
 *   isn't applied. A PreviewLinkConfirmation holds exactly what was asked, and
 *   the CLI gets a one-time URL on the main termag host,
 *   `/termag/previews/confirm/<id>`, to open in the person's browser. That
 *   page needs their termag session, which an agent on the box doesn't have.
 *   Only the person who asked may confirm; confirming applies the stored
 *   request through the same publish or extend a browser would, and nothing
 *   else;
 * - revoke and remove-viewer only narrow access, and apply at once.
 *
 * The id is 256 random bits, kept only as its hash, single use (a
 * compare-and-set from `pending`), and lives 10 minutes. The CLI polls the
 * status route with the same sign-in; a link token minted by the confirm is
 * kept sealed under a key only the raw id gives (sealShareUrl), handed to it
 * once, then forgotten. Each step (requested, confirmed,
 * declined, expired, failed) is the row's state and an audit log line, plus an
 * audience event once there is a link to file it on.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import type { RouteResult } from '../routes/routeResult';
import { prismaAudienceOps, type AudienceOps } from './previewAudience';
import {
  changeable, checkPublishable, defaultPreviewLinkDeps, extendPreviewLinkFor, publishPreviewLinkFor,
  type PreviewLinkCaller, type PreviewLinkDeps,
} from './previewLinks';

export const CONFIRM_TTL_MS = 10 * 60_000;
/** An apply this old never finished (the process went away mid-publish). */
export const APPLY_STALE_MS = 5 * 60_000;
const ID_RE = /^[A-Za-z0-9_-]{43}$/;

export type ConfirmationKind = 'publish' | 'extend';
/** `interrupted`: an apply that looked lost (APPLY_STALE_MS); reported as failed, but an apply still in flight may yet confirm it. */
export type ConfirmationState = 'pending' | 'applying' | 'interrupted' | 'confirmed' | 'declined' | 'expired' | 'failed';

export interface ConfirmationRow {
  idHash: string;
  userId: string;
  projectId: string;
  fromBoxId: string;
  kind: ConfirmationKind;
  request: Record<string, unknown>;
  state: ConfirmationState;
  failure: string | null;
  linkId: string | null;
  /** The minted share URL, sealed (sealShareUrl); null when nothing was minted or once the CLI read it. */
  shareUrlSealed: string | null;
  expiresAt: Date;
  createdAt: Date;
  decidedAt: Date | null;
}

export interface ConfirmationStore {
  create(row: Omit<ConfirmationRow, 'state' | 'failure' | 'linkId' | 'shareUrlSealed' | 'createdAt' | 'decidedAt'>): Promise<void>;
  find(idHash: string): Promise<ConfirmationRow | null>;
  /** Move the row from one of `from` to the new fields; false when it wasn't in one of them (someone else moved it). */
  move(idHash: string, from: ConfirmationState[], data: Partial<ConfirmationRow>): Promise<boolean>;
}

export interface ConfirmationDeps {
  links: PreviewLinkDeps;
  store: ConfirmationStore;
  /** The box's name, for the page. */
  boxName(boxId: string): Promise<string | null>;
  /** The server secret the confirm form's CSRF token is made with (SESSION_SECRET). */
  secret(): string;
  random?: (n: number) => Buffer;
  log?: (line: string) => void;
  /** Where events go (the audience core's ops); unset: prismaAudienceOps(prisma). */
  audienceOps?: AudienceOps;
  /** These users' emails, in order (for an extend's named people); unset: from prisma. */
  emailsOf?(userIds: string[]): Promise<string[]>;
}

/**
 * Who an extend keeps in, beyond the owner and collaborators: the link's
 * grantees' emails, for the 202 and the confirm page (which is the human
 * gate, so it names them as a publish's does).
 */
async function granteeEmails(deps: ConfirmationDeps, audienceId: string): Promise<string[]> {
  const ids = await (deps.audienceOps ?? prismaAudienceOps(prisma)).granteeIds(audienceId);
  if (!ids.length) return [];
  if (deps.emailsOf) return deps.emailsOf(ids);
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { googleEmail: true } });
  return users.map(u => u.googleEmail).sort();
}

export function hashConfirmId(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

const SEAL_INFO = 'termag preview-link-confirmation shareUrl v1';

function sealKey(id: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(id, 'utf8'), Buffer.alloc(0), SEAL_INFO, 32));
}

/**
 * A minted share URL sealed for its one read: AES-256-GCM, its key
 * HKDF-SHA256(raw id, no salt, SEAL_INFO), a random 96-bit IV, the id's hash
 * as associated data. Only `idHash` is stored, so the row alone (a database
 * backup) can't open it; a request that carries the raw id (the CLI's poll,
 * the person's confirm page) can. `v1.<iv>.<ciphertext>.<tag>`, base64url.
 */
export function sealShareUrl(id: string, url: string, random: (n: number) => Buffer = randomBytes): string {
  const iv = random(12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(id), iv);
  cipher.setAAD(Buffer.from(hashConfirmId(id)));
  const ct = Buffer.concat([cipher.update(url, 'utf8'), cipher.final()]);
  return ['v1', iv, ct, cipher.getAuthTag()].map(p => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

/** The share URL a sealShareUrl made, or null for another id, a tampered value or anything else. */
export function openShareUrl(id: string, sealed: string | null): string | null {
  const parts = sealed?.split('.');
  if (!parts || parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const [iv, ct, tag] = parts.slice(1).map(p => Buffer.from(p, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16) return null;
    const d = createDecipheriv('aes-256-gcm', sealKey(id), iv);
    d.setAAD(Buffer.from(hashConfirmId(id)));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return null; }
}

export function confirmUrl(siteBase: string, id: string): string {
  return `${siteBase}/previews/confirm/${id}`;
}

/** The confirm form's CSRF token: bound to the request and the person, so a page made for one can't post for another. */
export function confirmCsrf(secret: string, idHash: string, userId: string): string {
  return createHmac('sha256', secret).update(`preview-confirm:${idHash}:${userId}`).digest('base64url');
}

export function confirmCsrfOk(secret: string, idHash: string, userId: string, token: unknown): boolean {
  if (typeof token !== 'string' || !token) return false;
  const a = Buffer.from(confirmCsrf(secret, idHash, userId));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function audit(deps: ConfirmationDeps, state: string, row: Pick<ConfirmationRow, 'idHash' | 'userId' | 'projectId' | 'fromBoxId' | 'kind'>, extra = ''): void {
  (deps.log ?? console.log)(`[PREVIEW-LINK] confirmation ${state}: ${row.kind} user=${row.userId} project=${row.projectId} box=${row.fromBoxId} id=${row.idHash.slice(0, 12)}${extra ? ` ${extra}` : ''}`);
}

/** File an event on the link's audience, when there is a link. Best effort. */
async function linkEvent(deps: ConfirmationDeps, linkId: string | null, kind: string, actorId: string, detail: Record<string, unknown>): Promise<void> {
  if (!linkId) return;
  const link = await deps.links.store.findLink(linkId);
  if (!link) return;
  await (deps.audienceOps ?? prismaAudienceOps(prisma)).addEvent({ audienceId: link.audienceId, kind, actorId, delivery: { kind: 'link', id: link.id }, detail }).catch(() => {});
}

async function ask(deps: ConfirmationDeps, caller: PreviewLinkCaller, input: { projectId: string; kind: ConfirmationKind; request: Record<string, unknown>; fromBoxId: string; audience: string; emails: string[] }): Promise<RouteResult> {
  const id = (deps.random ?? randomBytes)(32).toString('base64url');
  const idHash = hashConfirmId(id);
  const expiresAt = new Date(deps.links.now().getTime() + CONFIRM_TTL_MS);
  await deps.store.create({ idHash, userId: caller.id, projectId: input.projectId, fromBoxId: input.fromBoxId, kind: input.kind, request: input.request, expiresAt });
  audit(deps, 'requested', { idHash, userId: caller.id, projectId: input.projectId, fromBoxId: input.fromBoxId, kind: input.kind });
  if (input.kind === 'extend') await linkEvent(deps, String(input.request.linkId), 'requested', caller.id, { confirm: 'extend', fromBoxId: input.fromBoxId });
  return {
    status: 202,
    body: {
      confirm: { url: confirmUrl(deps.links.siteBase(), id), expiresAt: expiresAt.toISOString(), status: `/preview-links/confirmations/${id}` },
      audience: input.audience,
      emails: input.emails,
      code: 'confirm_in_browser',
      error: 'This sign-in was made on a box, so sharing beyond you needs a confirm in your browser',
    },
  };
}

/**
 * A publish (or renew) from a box-made sign-in: applied at once for "only me",
 * held for a confirm otherwise. Every check that needs no box runs first, so a
 * request that could never apply is refused now, not after the click.
 */
export async function publishFromBoxFor(deps: ConfirmationDeps, caller: PreviewLinkCaller, projectId: string, body: unknown, fromBoxId: string): Promise<RouteResult> {
  const checked = await checkPublishable(deps.links, caller, projectId, body);
  if (!checked.ok) return checked.result;
  if (checked.req.audience === 'owner') return publishPreviewLinkFor(deps.links, caller, projectId, body);
  // Exactly what was asked, normalised: nothing the request didn't name.
  const { workstream, port, name, audience, emails, ttlHours, hostMode, requestId } = checked.req;
  const request = { workstream, port, name, audience, emails, ttlHours, hostMode, requestId };
  return ask(deps, caller, { projectId: checked.project.id, kind: 'publish', request, fromBoxId, audience, emails });
}

/** An extend from a box-made sign-in: at once for an "only me" link, held for a confirm otherwise (it keeps people in longer). */
export async function extendFromBoxFor(deps: ConfirmationDeps, caller: PreviewLinkCaller, linkId: string, body: unknown, fromBoxId: string): Promise<RouteResult> {
  const found = await changeable(deps.links, caller, linkId);
  if (!('link' in found)) return found;
  if (found.link.audience === 'owner') return extendPreviewLinkFor(deps.links, caller, linkId, body);
  const ttlHours = (body as { ttlHours?: unknown } | null)?.ttlHours;
  if (typeof ttlHours !== 'number' || !Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) {
    return extendPreviewLinkFor(deps.links, caller, linkId, body); // its own 400
  }
  const emails = found.link.audience === 'people' ? await granteeEmails(deps, found.link.audienceId) : [];
  return ask(deps, caller, { projectId: found.link.projectId, kind: 'extend', request: { linkId: found.link.id, ttlHours }, fromBoxId, audience: found.link.audience, emails });
}

/** The row for `id`, when it is the caller's; a pending one past its time is moved to expired here. */
async function rowFor(deps: ConfirmationDeps, id: string, userId: string): Promise<ConfirmationRow | null> {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const row = await deps.store.find(hashConfirmId(id));
  if (!row || row.userId !== userId) return null;
  const now = deps.links.now();
  // A process that died mid-apply leaves `applying`: past APPLY_STALE_MS it
  // reads as `interrupted` (failed, to the person and the CLI). An apply that
  // is in fact still running may still confirm it (decideConfirmationFor), so
  // a slow success is never reported lost. Whatever the move, the row is read
  // again, so what is reported is what's stored.
  if (row.state === 'applying' && row.decidedAt && now.getTime() - row.decidedAt.getTime() > APPLY_STALE_MS) {
    const failure = 'The publish was interrupted on the server; ask again from the terminal';
    if (await deps.store.move(row.idHash, ['applying'], { state: 'interrupted', failure })) audit(deps, 'failed', row, 'interrupted');
    return deps.store.find(row.idHash);
  }
  if (row.state === 'pending' && row.expiresAt.getTime() <= now.getTime()) {
    if (await deps.store.move(row.idHash, ['pending'], { state: 'expired', decidedAt: now })) {
      audit(deps, 'expired', row);
      if (row.kind === 'extend') await linkEvent(deps, String(row.request.linkId), 'refused', userId, { confirm: 'expired' });
    }
    return deps.store.find(row.idHash);
  }
  return row;
}

const NOT_FOUND: RouteResult = { status: 404, body: { error: 'Not found', code: 'not_found' } };

/**
 * GET /api/cli/v1/preview-links/confirmations/:id: the CLI's poll. Its own
 * request only. A link token the confirm minted is in `shareUrl` this once.
 */
export async function confirmationStatusFor(deps: ConfirmationDeps, caller: PreviewLinkCaller, id: string): Promise<RouteResult> {
  const row = await rowFor(deps, id, caller.id);
  if (!row) return NOT_FOUND;
  let shareUrl: string | null = null;
  if (row.state === 'confirmed' && row.shareUrlSealed) {
    // Handed over once: whoever reads it first (the CLI that asked) has it.
    if (await deps.store.move(row.idHash, ['confirmed'], { shareUrlSealed: null })) shareUrl = openShareUrl(id, row.shareUrlSealed);
  }
  const link = row.linkId ? await deps.links.store.findLink(row.linkId) : null;
  return {
    status: 200,
    body: {
      state: row.state === 'applying' ? 'pending' : row.state === 'interrupted' ? 'failed' : row.state,
      expiresAt: row.expiresAt.toISOString(),
      failure: row.failure,
      link: link ? { id: link.id, name: link.name, port: link.port, audience: link.audience, expiresAt: link.expiresAt.toISOString(), url: `${deps.links.siteBase()}/previews/${link.name}` } : null,
      shareUrl,
    },
  };
}

export interface ConfirmPageView {
  state: ConfirmationState;
  kind: ConfirmationKind;
  projectName: string;
  boxName: string | null;
  fromBoxName: string | null;
  workstream: string | null;
  port: number | null;
  name: string | null;
  audience: string;
  emails: string[];
  ttlHours: number | null;
  expiresAt: Date;
  failure: string | null;
  shareUrl: string | null;
  csrf: string;
}

/** What the confirm page shows; null for the 404 (unknown, someone else's, or a project gone). */
export async function confirmPageFor(deps: ConfirmationDeps, userId: string, id: string): Promise<ConfirmPageView | null> {
  const row = await rowFor(deps, id, userId);
  if (!row) return null;
  const project = await deps.links.findProject(row.projectId);
  if (!project) return null;
  const r = row.request;
  let link = null;
  if (row.kind === 'extend') link = await deps.links.store.findLink(String(r.linkId));
  return {
    state: row.state,
    kind: row.kind,
    projectName: project.name,
    boxName: project.instance?.name ?? null,
    fromBoxName: await deps.boxName(row.fromBoxId),
    workstream: row.kind === 'publish' ? String(r.workstream) : null,
    port: row.kind === 'publish' ? Number(r.port) : link?.port ?? null,
    name: row.kind === 'publish' ? String(r.name) : link?.name ?? null,
    audience: row.kind === 'publish' ? String(r.audience) : link?.audience ?? 'link',
    // An extend names the link's people as they are now, whom it keeps in longer.
    emails: row.kind === 'extend'
      ? (link && link.audience === 'people' ? await granteeEmails(deps, link.audienceId) : [])
      : Array.isArray(r.emails) ? r.emails.map(String) : [],
    ttlHours: typeof r.ttlHours === 'number' ? r.ttlHours : null,
    expiresAt: row.expiresAt,
    failure: row.failure,
    // The page's request carries the raw id, so it can open the seal too, until the CLI has read it.
    shareUrl: openShareUrl(id, row.shareUrlSealed),
    csrf: confirmCsrf(deps.secret(), row.idHash, userId),
  };
}

/**
 * POST /termag/previews/confirm/:id: the person's Publish or Decline. The
 * CSRF token must be the one the page made for this request and person.
 * Publishing applies the stored request through the browser's own publish or
 * extend, as the person; their standing and every check are taken again.
 */
export async function decideConfirmationFor(
  deps: ConfirmationDeps, caller: PreviewLinkCaller, id: string, decision: unknown, csrf: unknown,
): Promise<{ ok: true; state: ConfirmationState } | { ok: false; status: 403 | 404 | 409; reason: string }> {
  const row = await rowFor(deps, id, caller.id);
  if (!row) return { ok: false, status: 404, reason: 'not_found' };
  if (!confirmCsrfOk(deps.secret(), row.idHash, caller.id, csrf)) return { ok: false, status: 403, reason: 'csrf' };
  if (decision !== 'publish' && decision !== 'decline') return { ok: false, status: 409, reason: 'decision' };
  const now = deps.links.now();
  if (decision === 'decline') {
    if (!(await deps.store.move(row.idHash, ['pending'], { state: 'declined', decidedAt: now }))) return { ok: false, status: 409, reason: row.state };
    audit(deps, 'declined', row);
    if (row.kind === 'extend') await linkEvent(deps, String(row.request.linkId), 'refused', caller.id, { confirm: 'declined' });
    return { ok: true, state: 'declined' };
  }
  // Single use: only one Publish ever takes it out of pending.
  if (!(await deps.store.move(row.idHash, ['pending'], { state: 'applying', decidedAt: now }))) return { ok: false, status: 409, reason: row.state };
  let result: RouteResult;
  try {
    result = row.kind === 'publish'
      ? await publishPreviewLinkFor(deps.links, caller, row.projectId, row.request)
      : await extendPreviewLinkFor(deps.links, caller, String(row.request.linkId), { ttlHours: row.request.ttlHours });
  } catch (e) {
    // Never left `applying`: the person and the CLI see it failed, and may ask again.
    await deps.store.move(row.idHash, ['applying', 'interrupted'], { state: 'failed', failure: 'The publish failed on the server; ask again from the terminal' });
    audit(deps, 'failed', row, `error=${(e as Error)?.message ?? String(e)}`.slice(0, 300));
    return { ok: true, state: 'failed' };
  }
  const body = result.body as { link?: { id: string; url: string }; shareUrl?: string | null; error?: string };
  if (result.status >= 300 || !body.link) {
    await deps.store.move(row.idHash, ['applying', 'interrupted'], { state: 'failed', failure: body.error ?? `HTTP ${result.status}` });
    audit(deps, 'failed', row, `status=${result.status}`);
    return { ok: true, state: 'failed' };
  }
  // A token the publish minted (its share URL beyond the bare one) is kept for the CLI's one read.
  // Only a link audience mints one; "only me" and people keep null.
  const minted = body.shareUrl && body.shareUrl !== body.link.url ? body.shareUrl : null;
  // From `interrupted` too: a slow apply that did publish is reported as it is, with its token.
  await deps.store.move(row.idHash, ['applying', 'interrupted'], { state: 'confirmed', linkId: body.link.id, shareUrlSealed: minted ? sealShareUrl(id, minted, deps.random) : null });
  audit(deps, 'confirmed', row, `link=${body.link.id}`);
  await linkEvent(deps, body.link.id, 'confirmed', caller.id, { confirm: row.kind, fromBoxId: row.fromBoxId });
  return { ok: true, state: 'confirmed' };
}

// ── Prisma ────────────────────────────────────────────────────────────────

function asRow(r: Prisma.PreviewLinkConfirmationGetPayload<object>): ConfirmationRow {
  return { ...r, kind: r.kind as ConfirmationKind, state: r.state as ConfirmationState, request: (r.request ?? {}) as Record<string, unknown> };
}

export const prismaConfirmationStore: ConfirmationStore = {
  async create(row) {
    await prisma.previewLinkConfirmation.create({ data: { ...row, request: row.request as Prisma.InputJsonValue } });
  },
  async find(idHash) {
    const r = await prisma.previewLinkConfirmation.findUnique({ where: { idHash } });
    return r ? asRow(r) : null;
  },
  async move(idHash, from, data) {
    const { request, ...rest } = data;
    const n = await prisma.previewLinkConfirmation.updateMany({
      where: { idHash, state: { in: from } },
      data: { ...rest, ...(request ? { request: request as Prisma.InputJsonValue } : {}) },
    });
    return n.count === 1;
  },
};

export const defaultConfirmationDeps: ConfirmationDeps = {
  links: defaultPreviewLinkDeps,
  store: prismaConfirmationStore,
  boxName: async (boxId) => (await prisma.instance.findUnique({ where: { id: boxId }, select: { name: true } }))?.name ?? null,
  secret: () => process.env.SESSION_SECRET ?? 'dev-secret',
};
