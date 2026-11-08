/**
 * An in-memory PreviewHostStore for the preview host's and the landing page's
 * tests: prismaPreviewHostStore's semantics over maps. `takeCode` deletes and
 * returns in one step, as the DELETE … RETURNING does.
 */
import type { Instance, User } from '@prisma/client';
import type { PreviewLinkRow } from './previewLinks';
import type { CodeRow, HostLinkContext, HostUser, PreviewHostStore, SessionRow } from './previewHostStore';


export function hostUser(id: string, email = `${id}@example.com`, name = id): User {
  return {
    id, googleEmail: email, displayName: name, unixUsername: id, googleId: `g:${id}`, defaultAgentProvider: 'claude',
  } as unknown as User;
}

export function hostBox(id: string, status = 'ready'): Instance {
  return { id, name: id, kind: 'ec2', status, hostHome: `/home/owner` } as unknown as Instance;
}

export function memoryHostStore() {
  const links = new Map<string, HostLinkContext>();
  const names = new Map<string, string>();
  const users = new Map<string, HostUser>();
  const shares = new Set<string>();
  const grants = new Set<string>();
  const removed = new Set<string>();
  const viewers = new Map<string, { first: Date; last: Date }>();
  const codes = new Map<string, CodeRow>();
  const sessions = new Map<string, SessionRow>();
  const events: Array<{ linkId: string; audienceId: string; kind: string; actorId: string | null; reason?: string | null; detail?: unknown }> = [];
  const key = (a: string, b: string) => `${a}\u0000${b}`;

  const store: PreviewHostStore = {
    async resolveName(name) {
      const id = names.get(name);
      const ctx = id ? links.get(id) : undefined;
      return ctx ? { ...ctx, link: { ...ctx.link } } : null;
    },
    async viewer(link, userId) {
      return { isCollaborator: shares.has(key(link.projectId, userId)), hasGrant: grants.has(key(link.audienceId, userId)), removed: removed.has(key(link.audienceId, userId)) };
    },
    async user(userId) { return users.get(userId) ?? null; },
    async createCode(row) { codes.set(row.codeHash, { ...row }); },
    async takeCode(hash, now) {
      const row = codes.get(hash);
      if (!row) return null;
      codes.delete(hash);
      return row.expiresAt.getTime() > now.getTime() ? row : null;
    },
    async createSession(row) { sessions.set(row.idHash, { ...row, revokedAt: null, createdAt: row.createdAt ?? new Date() }); },
    async findSession(idHash) { const s = sessions.get(idHash); return s ? { ...s } : null; },
    async markVerified(idHash, at) {
      const s = sessions.get(idHash);
      if (!s || s.revokedAt || s.expiresAt.getTime() <= at.getTime()) return false;
      s.verifiedAt = at;
      return true;
    },
    async revokeSession(idHash, at) { const s = sessions.get(idHash); if (s && !s.revokedAt) s.revokedAt = at; },
    async opened(audienceId, userId, at) {
      const k = key(audienceId, userId);
      const v = viewers.get(k);
      if (v) { v.last = at; return { firstOpen: false }; }
      viewers.set(k, { first: at, last: at });
      return { firstOpen: true };
    },
    async addEvent({ link, ...e }) { events.push({ linkId: link.id, audienceId: link.audienceId, ...e }); },
  };

  return {
    store, links, names, users, codes, sessions, events, viewers,
    /** A live link under `name`, on box `box-1`, project `proj-1` owned by `owner`. */
    addLink(over: Partial<PreviewLinkRow> & { name: string }, ctx: Partial<Omit<HostLinkContext, 'link'>> = {}): HostLinkContext {
      const link: PreviewLinkRow = {
        id: `link-${over.name}`, hostSuffix: 'abcdef', audienceId: `aud-${over.name}`, projectId: 'proj-1', workstreamId: null, ownerId: 'owner', port: 5173, audience: 'owner', linkTokenHash: null,
        hostMode: 'localhost', requestId: null, expiresAt: new Date(Date.now() + 24 * 3600_000), endedAt: null, endReason: null, createdAt: new Date(),
        ...over,
      };
      const full: HostLinkContext = {
        link,
        project: ctx.project ?? { id: link.projectId, name: 'app', userId: 'owner', instanceId: 'box-1', archived: false, owner: hostUser('owner', 'owner@example.com', 'Olive Owner'), instance: hostBox('box-1') },
        workstreamName: ctx.workstreamName ?? 'main',
      };
      links.set(link.id, full);
      names.set(link.name, link.id);
      return full;
    },
    addUser(id: string, email = `${id}@example.com`) { users.set(id, { id, googleEmail: email, displayName: id }); },
    share(projectId: string, userId: string) { shares.add(key(projectId, userId)); },
    unshare(projectId: string, userId: string) { shares.delete(key(projectId, userId)); },
    /** A live grantee of the link's audience. */
    grant(linkId: string, userId: string) { grants.add(key(links.get(linkId)!.link.audienceId, userId)); },
    /** The viewer removed from the link's audience (their viewer row's revokedAt). */
    remove(linkId: string, userId: string) { removed.add(key(links.get(linkId)!.link.audienceId, userId)); },
  };
}
export type MemoryHostStore = ReturnType<typeof memoryHostStore>;
