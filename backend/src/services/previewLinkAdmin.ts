/**
 * An admin ends one preview link (SR15:
 * the owner can be the abuser, and the kill switch ends every link). By the
 * link's id or its name, through the audience core's endPreviewAudience, so the
 * link's end hook holds the name 30 days, revokes every session and closes
 * this process's live sockets. The audience's `ended` event records the
 * admin's user id with reason `admin`, beside admin_audit_log's row for the
 * request (middleware/admin.ts) and an audit line. The route is
 * routes/admin/previewLinkEnd.ts; the button comes with the links list (row 3).
 */
import { prisma } from '../db';
import { endPreviewAudience } from './previewAudience';
import { PREVIEW_NAME_RE } from './previewLinkRules';
import { audit, linkEnded } from './previewLinkTelemetry';
import type { RouteResult } from '../routes/routeResult';

export interface AdminLinkRef { id?: string; name?: string }

export interface AdminEndableLink {
  id: string;
  name: string;
  audienceId: string;
  ownerId: string;
  boxId: string | null;
  endedAt: Date | null;
  endReason: string | null;
}

export interface PreviewLinkAdminDeps {
  /** The link by id, or the link a name serves now. */
  findLink(ref: AdminLinkRef): Promise<AdminEndableLink | null>;
  endAudience(audienceId: string, actorId: string, now: Date): Promise<void>;
  now(): Date;
}

/** `{ id }` or `{ name }`, one of them; null for anything else. */
export function parseAdminLinkRef(body: unknown): AdminLinkRef | null {
  const { confirm: _confirm, ...b } = (body ?? {}) as { id?: unknown; name?: unknown; confirm?: unknown };
  const id = typeof b.id === 'string' && /^[a-z0-9]{8,40}$/.test(b.id) ? b.id : undefined;
  const name = typeof b.name === 'string' && PREVIEW_NAME_RE.test(b.name) ? b.name : undefined;
  if ((id ? 1 : 0) + (name ? 1 : 0) !== 1 || (b.id !== undefined && !id) || (b.name !== undefined && !name)) return null;
  return id ? { id } : { name };
}

function view(l: AdminEndableLink) {
  return { id: l.id, name: l.name, endedAt: l.endedAt?.toISOString() ?? null, endReason: l.endReason };
}

/** POST /api/admin/preview-links/end { id } | { name }, with confirm: true: 200 with the link as it is now; 404 for no such link. */
export async function adminEndPreviewLink(deps: PreviewLinkAdminDeps, admin: { id: string; googleEmail: string }, body: unknown): Promise<RouteResult> {
  // As every admin action: a confirm in the body, so an MCP client or a stray request can't end a link in one step.
  if ((body as { confirm?: unknown } | null | undefined)?.confirm !== true) return { status: 400, body: { error: 'confirm: true is required', code: 'invalid_request' } };
  const ref = parseAdminLinkRef(body);
  if (!ref) return { status: 400, body: { error: 'Give a link\'s id or its name, one of them', code: 'invalid_request' } };
  const link = await deps.findLink(ref);
  if (!link) return { status: 404, body: { error: 'Not found', code: 'not_found' } };
  if (link.endedAt) return { status: 200, body: { link: view(link), alreadyEnded: true } };
  const now = deps.now();
  await deps.endAudience(link.audienceId, admin.id, now);
  audit({ step: 'admin', decision: 'end', reason: 'admin', viewer: admin.googleEmail, linkId: link.id, name: link.name, boxId: link.boxId });
  linkEnded(link.ownerId, link.boxId, { reason: 'admin' });
  const after = (await deps.findLink({ id: link.id })) ?? { ...link, endedAt: now, endReason: 'admin' };
  return { status: 200, body: { link: view(after), alreadyEnded: false } };
}

const SELECT = {
  id: true, name: true, audienceId: true,
  audience: { select: { ownerId: true, endedAt: true, endReason: true, project: { select: { instanceId: true } } } },
} as const;

export const prismaPreviewLinkAdminDeps: PreviewLinkAdminDeps = {
  async findLink(ref) {
    const l = ref.id
      ? await prisma.previewLink.findUnique({ where: { id: ref.id }, select: SELECT })
      : (await prisma.previewLinkName.findUnique({ where: { name: ref.name! }, select: { link: { select: SELECT } } }))?.link ?? null;
    if (!l) return null;
    return { id: l.id, name: l.name, audienceId: l.audienceId, ownerId: l.audience.ownerId, boxId: l.audience.project.instanceId, endedAt: l.audience.endedAt, endReason: l.audience.endReason };
  },
  endAudience: (audienceId, actorId, now) => endPreviewAudience(audienceId, 'admin', actorId, now),
  now: () => new Date(),
};
