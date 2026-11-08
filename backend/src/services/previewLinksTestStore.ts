/**
 * An in-memory PreviewLinkStore for the preview links' tests
 * (previewLinks.test.ts, routes/previewLinks.routes.test.ts): the prisma
 * stores' semantics (services/previewLinks.ts prismaNameTx and
 * services/previewAudience.ts prismaAudienceOps), over arrays. A name's lock
 * is a promise chain, so concurrent publishes of one name run one after the
 * other, as they do under the advisory lock. `endDeps` is the audience core's
 * AudienceEndDeps over the same arrays, for the archive and removal paths.
 */
import type { AudienceEndDeps, AudienceOps, AudienceRow, PreviewDelivery } from './previewAudience';
import { granteeLive } from './previewAudience';
import type { NameTx, PreviewLinkRequestRow, PreviewLinkRow, PreviewLinkStore, SessionSelector } from './previewLinks';
import type { ConfirmationRow, ConfirmationStore } from './previewLinkConfirmations';

export interface MemSession { idHash: string; linkId: string; userId: string; basis: string; tokenHash: string | null; revokedAt: Date | null }
export interface MemName { name: string; ownerId: string; reservedUntil: Date; linkId: string | null }
export interface MemLink { id: string; name: string; hostSuffix: string; audienceId: string; port: number; linkTokenHash: string | null; hostMode: 'localhost' | 'public'; requestId: string | null; createdAt: Date }

/** `now`: the clock rows are stamped with (createdAt), the test's own. */
export function memoryStore(now: () => Date = () => new Date()) {
  const audiences: AudienceRow[] = [];
  const links: MemLink[] = [];
  const names = new Map<string, MemName>();
  const grantees: Array<{ audienceId: string; userId: string; expiresAt: Date | null }> = [];
  const viewers: Array<{ audienceId: string; userId: string; firstOpenedAt: Date; lastOpenedAt: Date; revokedAt: Date | null }> = [];
  const sessions: MemSession[] = [];
  const codes: Array<{ linkId: string }> = [];
  const events: Array<{ audienceId: string; kind: string; actorId: string | null; reason?: string | null; delivery?: { kind: string; id: string } | null; detail?: unknown }> = [];
  const requests: PreviewLinkRequestRow[] = [];
  const users = new Map<string, { id: string; email: string; displayName: string }>();
  /** project id → its owner's user id, for listOwnedBy (the prisma one joins the project). */
  const projectOwners = new Map<string, string>();
  /** Projects and workstreams archived or gone as the name's transaction sees them (NameTx.scopeLive). */
  const archivedProjects = new Set<string>();
  const goneWorkstreams = new Set<string>();
  const locks = new Map<string, Promise<unknown>>();
  const deliveries: PreviewDelivery[] = [];
  let seq = 0;

  const flat = (l: MemLink): PreviewLinkRow => {
    const a = audiences.find(x => x.id === l.audienceId)!;
    return {
      ...l, projectId: a.projectId, workstreamId: a.workstreamId, ownerId: a.ownerId, audience: a.kind,
      expiresAt: a.expiresAt, endedAt: a.endedAt, endReason: a.endReason,
    };
  };

  const matches = (s: MemSession, linkId: string, which: SessionSelector) => {
    if (s.linkId !== linkId || s.revokedAt) return false;
    if ('all' in which) return true;
    if ('userId' in which) return s.userId === which.userId;
    if (which.basis === 'grant') return s.basis === 'grant' && (!which.userIds || which.userIds.includes(s.userId));
    return s.basis === 'token' && (which.keep === null || s.tokenHash !== which.keep);
  };

  const audience: AudienceOps = {
    async create(data) {
      const a: AudienceRow = { id: `caud${String(++seq).padStart(8, '0')}`, revokedAt: null, endedAt: null, endReason: null, createdAt: now(), ...data };
      audiences.push(a);
      return a;
    },
    async read(id) { return audiences.find(a => a.id === id) ?? null; },
    async update(id, data) {
      const a = audiences.find(x => x.id === id)!;
      Object.assign(a, data);
      return a;
    },
    async granteeIds(audienceId) { return grantees.filter(g => g.audienceId === audienceId).map(g => g.userId); },
    async hasLiveGrant(audienceId, userId, now) {
      const g = grantees.find(x => x.audienceId === audienceId && x.userId === userId);
      return !!g && granteeLive(g, now);
    },
    async setGrantees(audienceId, userIds) {
      for (let i = grantees.length - 1; i >= 0; i--) if (grantees[i].audienceId === audienceId && !userIds.includes(grantees[i].userId)) grantees.splice(i, 1);
      for (const userId of userIds) if (!grantees.some(g => g.audienceId === audienceId && g.userId === userId)) grantees.push({ audienceId, userId, expiresAt: null });
    },
    async removeGrantee(audienceId, userId) {
      for (let i = grantees.length - 1; i >= 0; i--) if (grantees[i].audienceId === audienceId && grantees[i].userId === userId) grantees.splice(i, 1);
    },
    async unrevokeViewers(audienceId, userIds) {
      for (const v of viewers) if (v.audienceId === audienceId && userIds.includes(v.userId)) v.revokedAt = null;
    },
    async revokeViewer(audienceId, userId, at) {
      const v = viewers.find(x => x.audienceId === audienceId && x.userId === userId);
      if (v) v.revokedAt = at; else viewers.push({ audienceId, userId, firstOpenedAt: at, lastOpenedAt: at, revokedAt: at });
    },
    async addEvent(e) { events.push(e); },
  };

  const tx: NameTx = {
    audience,
    async readName(name) {
      const row = names.get(name);
      if (!row) return null;
      const link = row.linkId ? links.find(l => l.id === row.linkId) : undefined;
      return { name: row.name, ownerId: row.ownerId, reservedUntil: row.reservedUntil, link: link ? flat(link) : null };
    },
    async readLink(id) {
      const l = links.find(x => x.id === id);
      return l ? flat(l) : null;
    },
    async createLink(data) {
      const link: MemLink = { id: `clink${String(++seq).padStart(8, '0')}`, createdAt: now(), ...data };
      links.push(link);
      return flat(link);
    },
    async updateLink(id, data) {
      const link = links.find(l => l.id === id)!;
      Object.assign(link, data);
      return flat(link);
    },
    async writeName(row) {
      // linkId is unique: whichever name held it before lets go.
      if (row.linkId) for (const other of names.values()) if (other.name !== row.name && other.linkId === row.linkId) other.linkId = null;
      names.set(row.name, { ...row });
    },
    async revokeSessions(linkId, which, at) {
      const hit = sessions.filter(s => matches(s, linkId, which));
      for (const s of hit) s.revokedAt = at;
      return hit.map(s => s.idHash);
    },
    async deleteCodes(linkId) {
      for (let i = codes.length - 1; i >= 0; i--) if (codes[i].linkId === linkId) codes.splice(i, 1);
    },
    async scopeLive(projectId, workstreamId) { return !archivedProjects.has(projectId) && !(workstreamId && goneWorkstreams.has(workstreamId)); },
    async decideRequest(id, state, at) {
      const r = requests.find(x => x.id === id);
      if (!r || r.state !== 'pending') return false;
      r.state = state;
      r.decidedAt = at;
      return true;
    },
  };

  const person = (id: string) => users.get(id) ?? { id, email: `${id}@x.test`, displayName: id };
  const listRow = (l: MemLink) => {
    const f = flat(l);
    return {
      ...f,
      workstreamName: f.workstreamId,
      owner: person(f.ownerId),
      grantees: grantees.filter(g => g.audienceId === l.audienceId).map(g => ({ ...person(g.userId), expiresAt: g.expiresAt })),
      viewers: viewers.filter(v => v.audienceId === l.audienceId).map(v => ({ ...person(v.userId), firstOpenedAt: v.firstOpenedAt, lastOpenedAt: v.lastOpenedAt, revokedAt: v.revokedAt })),
    };
  };

  const store: PreviewLinkStore = {
    withName(name, fn) {
      const prev = locks.get(name) ?? Promise.resolve();
      const run = prev.then(() => fn(tx));
      locks.set(name, run.catch(() => {}));
      return run;
    },
    async findLink(id) { return tx.readLink(id); },
    async linksOfAudience(audienceId) { return links.filter(l => l.audienceId === audienceId).map(flat); },
    async listForProject(projectId, since) {
      return links.map(listRow)
        .filter(l => l.projectId === projectId && ((l.endedAt === null && l.expiresAt > since) || (l.endedAt !== null && l.endedAt > since)))
        .reverse();
    },
    async listOwnedBy(userId, now) {
      return links.map(listRow).filter(l => (l.ownerId === userId || projectOwners.get(l.projectId) === userId) && l.endedAt === null && l.expiresAt > now).reverse();
    },
    async pendingRequests(projectId) { return requests.filter(r => r.projectId === projectId && r.state === 'pending'); },
    async findRequest(id) { return requests.find(r => r.id === id) ?? null; },
  };

  const endDeps: AudienceEndDeps = {
    async liveAudienceIds(where) {
      return audiences.filter(a => a.endedAt === null && (where.projectId ? a.projectId === where.projectId : a.workstreamId === where.workstreamId)).map(a => a.id);
    },
    async endBare(audienceId, reason, actorId, now) {
      const { endAudienceInTx } = await import('./previewAudience');
      await endAudienceInTx(audience, audienceId, reason, actorId, now);
    },
    deliveries: () => deliveries,
  };

  /** A delete of the audience's project or workstream: the audience, its links and theirs cascade; a name's linkId is set null (SR19). */
  const cascadeAudience = (audienceId: string) => {
    for (let i = links.length - 1; i >= 0; i--) {
      if (links[i].audienceId !== audienceId) continue;
      for (const n of names.values()) if (n.linkId === links[i].id) n.linkId = null;
      links.splice(i, 1);
    }
    audiences.splice(audiences.findIndex(a => a.id === audienceId), 1);
  };

  return {
    store, tx, audience, endDeps, deliveries, audiences, rawLinks: links, projectOwners, archivedProjects, goneWorkstreams, names, grantees, viewers, sessions, codes, events, requests, users, cascadeAudience,
    /** The links as PreviewLinkRows (their audience's fields flattened in), a snapshot. */
    get links() { return links.map(flat); },
  };
}

/** An in-memory ConfirmationStore (services/previewLinkConfirmations.ts): the prisma one's compare-and-set, over a Map. */
export function memoryConfirmationStore(now: () => Date = () => new Date()) {
  const rows = new Map<string, ConfirmationRow>();
  const store: ConfirmationStore = {
    async create(r) { rows.set(r.idHash, { ...r, state: 'pending', failure: null, linkId: null, shareUrlSealed: null, createdAt: now(), decidedAt: null }); },
    async find(h) { const r = rows.get(h); return r ? { ...r } : null; },
    async move(h, from, data) {
      const r = rows.get(h);
      if (!r || !from.includes(r.state)) return false;
      Object.assign(r, data);
      return true;
    },
  };
  return { store, rows };
}
