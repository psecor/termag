/**
 * In-memory SpaceStore and SpaceObjects for the spaces unit tests. Not
 * imported by the app.
 */
import type { SpaceRole } from './spaceAccess';
import { ancestorsOf } from './spaceInheritance';
import { isMemoryEvent, isMemoryEventPath, type PutCondition } from './spaceMemory';
import type { ObjectVersionInfo } from './spaceVersions';
import type { ListResult, ObjectVersion, OpenUpload, PresignedPut, PresignedUrl, SpaceObjects } from './spaceObjects';
import {
  LastOwnerError,
  SpaceNameTakenError,
  type AddMemberResult, type ChargeRef, type LiveCharge, type SpaceBoxInfo, type SpaceEventRecord, type SpaceRecord, type SpaceStore, type SpaceUser,
} from './spaceStore';

export interface MemUser extends SpaceUser { defaultAgentProvider?: string }

export class MemorySpaceStore implements SpaceStore {
  users = new Map<string, MemUser>();
  boxes = new Map<string, SpaceBoxInfo>();
  spaces = new Map<string, SpaceRecord>();
  memberRows: Array<{ spaceId: string; userId: string; role: SpaceRole; createdAt: Date }> = [];
  inviteRows: Array<{ id: string; spaceId: string; email: string; role: SpaceRole; addedById: string; createdAt: Date }> = [];
  grantRows: Array<{ spaceId: string; instanceId: string; addedById: string; createdAt: Date }> = [];
  eventRows: SpaceEventRecord[] = [];
  projects = new Map<string, { id: string; userId: string; instanceId: string | null }>();
  listingRows: Array<{ projectId: string; spaceId: string; instanceId: string; addedById: string }> = [];
  private seq = 0;

  addProject(id: string, userId: string, instanceId: string | null) {
    this.projects.set(id, { id, userId, instanceId });
  }

  /** Space ids the project is listed in, sorted. */
  listedIn(projectId: string): string[] {
    return this.listingRows.filter(l => l.projectId === projectId).map(l => l.spaceId).sort();
  }

  addUser(id: string, email = `${id}@example.com`): MemUser {
    const u = { id, email, displayName: id, unixUsername: id };
    this.users.set(id, u);
    return u;
  }

  addBox(id: string, userId: string | null, name = id, status = 'ready', parentInstanceId: string | null = null): SpaceBoxInfo {
    const b = { id, userId, status, parentInstanceId, name, kind: 'ec2', ownerEmail: userId ? this.users.get(userId)?.email ?? null : null };
    this.boxes.set(id, b);
    return b;
  }

  private id(prefix: string) { return `${prefix}${++this.seq}`.padEnd(25, '0'); }

  async ldUser(userId: string) {
    const u = this.users.get(userId);
    return u ? { id: u.id, googleEmail: u.email, displayName: u.displayName, unixUsername: u.unixUsername, defaultAgentProvider: 'claude' } : null;
  }

  async claimInvites(userId: string) {
    const u = this.users.get(userId);
    if (!u) return 0;
    const mine = this.inviteRows.filter(i => i.email === u.email.toLowerCase());
    for (const i of mine) {
      if (!this.memberRows.some(m => m.spaceId === i.spaceId && m.userId === userId)) {
        this.memberRows.push({ spaceId: i.spaceId, userId, role: i.role, createdAt: new Date() });
      }
    }
    this.inviteRows = this.inviteRows.filter(i => !mine.includes(i));
    return mine.length;
  }

  async spacesOfUser(userId: string) {
    return this.memberRows.filter(m => m.userId === userId)
      .map(m => ({ space: this.spaces.get(m.spaceId)!, role: m.role, memberCount: this.memberRows.filter(o => o.spaceId === m.spaceId).length }))
      .filter(r => r.space && !r.space.deletedAt);
  }

  async spacesGrantedTo(ids: string[]) {
    return this.grantRows.filter(g => ids.includes(g.instanceId))
      .map(g => ({ space: this.spaces.get(g.spaceId)!, instanceId: g.instanceId }))
      .filter(r => r.space && !r.space.deletedAt);
  }

  async findSpace(ref: string) {
    for (const s of this.spaces.values()) if (!s.deletedAt && (s.id === ref || s.name === ref)) return s;
    return null;
  }

  async memberRoles(spaceId: string) {
    return new Map(this.memberRows.filter(m => m.spaceId === spaceId).map(m => [m.userId, m.role] as const));
  }

  async grantedBoxIds(spaceId: string) {
    return new Set(this.grantRows.filter(g => g.spaceId === spaceId).map(g => g.instanceId));
  }

  async box(id: string) { return this.boxes.get(id) ?? null; }

  async boxesOwnedBy(userId: string) {
    return [...this.boxes.values()].filter(b => b.userId === userId && b.status !== 'terminated');
  }

  async createSpace(input: { name: string; description: string | null; userId: string }) {
    if ([...this.spaces.values()].some(s => s.name === input.name)) throw new SpaceNameTakenError(`A space named ${input.name} already exists`);
    const space: SpaceRecord = {
      id: this.id('c'), name: input.name, description: input.description, createdById: input.userId, createdAt: new Date(),
      readOnlyAt: null, deletedAt: null, usedBytes: 0n, quotaBytes: 107374182400n,
    };
    this.spaces.set(space.id, space);
    this.memberRows.push({ spaceId: space.id, userId: input.userId, role: 'owner', createdAt: new Date() });
    return space;
  }

  async updateSpace(spaceId: string, patch: { name?: string; description?: string | null }) {
    const s = this.spaces.get(spaceId)!;
    if (patch.name && [...this.spaces.values()].some(o => o.id !== spaceId && o.name === patch.name)) {
      throw new SpaceNameTakenError(`A space named ${patch.name} already exists`);
    }
    Object.assign(s, patch);
    return s;
  }

  async markDeleted(spaceId: string) {
    const s = this.spaces.get(spaceId)!;
    s.deletedAt = new Date();
    s.name = `deleted:${spaceId}`;
  }

  async members(spaceId: string) {
    return this.memberRows.filter(m => m.spaceId === spaceId).map(m => ({ ...m, user: this.users.get(m.userId)! }));
  }

  async invites(spaceId: string) {
    return this.inviteRows.filter(i => i.spaceId === spaceId);
  }

  async userByEmail(email: string) {
    for (const u of this.users.values()) if (u.email === email.toLowerCase()) return u;
    return null;
  }

  async addMember(input: { spaceId: string; email: string; role: SpaceRole; addedById: string }): Promise<AddMemberResult> {
    const user = await this.userByEmail(input.email);
    if (user) {
      const row = this.memberRows.find(m => m.spaceId === input.spaceId && m.userId === user.id);
      if (row) row.role = input.role;
      else this.memberRows.push({ spaceId: input.spaceId, userId: user.id, role: input.role, createdAt: new Date() });
      this.inviteRows = this.inviteRows.filter(i => !(i.spaceId === input.spaceId && i.email === input.email.trim().toLowerCase()));
      return { kind: 'member', member: { userId: user.id, role: input.role, user, createdAt: new Date() } };
    }
    const existing = this.inviteRows.find(i => i.spaceId === input.spaceId && i.email === input.email);
    if (existing) { existing.role = input.role; return { kind: 'invite', invite: existing }; }
    const invite = { id: this.id('inv'), spaceId: input.spaceId, email: input.email, role: input.role, addedById: input.addedById, createdAt: new Date() };
    this.inviteRows.push(invite);
    return { kind: 'invite', invite };
  }

  private ownerless(spaceId: string, rows = this.memberRows) {
    return !rows.some(m => m.spaceId === spaceId && m.role === 'owner');
  }

  private losesLastOwner(spaceId: string, next: typeof this.memberRows) {
    return !this.ownerless(spaceId) && this.ownerless(spaceId, next);
  }

  async setMemberRole(spaceId: string, userId: string, role: SpaceRole) {
    const next = this.memberRows.map(m => (m.spaceId === spaceId && m.userId === userId ? { ...m, role } : m));
    if (this.losesLastOwner(spaceId, next)) throw new LastOwnerError();
    this.memberRows = next;
  }

  async removeMember(spaceId: string, userId: string) {
    if (this.losesLastOwner(spaceId, this.memberRows.filter(m => !(m.spaceId === spaceId && m.userId === userId)))) throw new LastOwnerError();
    const before = this.grantRows.length;
    this.grantRows = this.grantRows.filter(g => !(g.spaceId === spaceId && this.boxes.get(g.instanceId)?.userId === userId));
    this.listingRows = this.listingRows.filter(l => !(l.spaceId === spaceId && this.projects.get(l.projectId)?.userId === userId));
    this.memberRows = this.memberRows.filter(m => !(m.spaceId === spaceId && m.userId === userId));
    return { removedBoxes: before - this.grantRows.length };
  }

  async removeInvite(spaceId: string, id: string) {
    const before = this.inviteRows.length;
    this.inviteRows = this.inviteRows.filter(i => !(i.spaceId === spaceId && i.id === id));
    return before !== this.inviteRows.length;
  }

  async grants(spaceId: string) {
    return this.grantRows.filter(g => g.spaceId === spaceId).map(g => ({ ...g, box: this.boxes.get(g.instanceId)! }));
  }

  async addGrant(spaceId: string, instanceId: string, addedById: string) {
    if (!this.grantRows.some(g => g.spaceId === spaceId && g.instanceId === instanceId)) {
      this.grantRows.push({ spaceId, instanceId, addedById, createdAt: new Date() });
    }
    await this.recordListings(spaceId);
  }

  async removeGrant(spaceId: string, instanceId: string) {
    const before = this.grantRows.length;
    this.grantRows = this.grantRows.filter(g => !(g.spaceId === spaceId && g.instanceId === instanceId));
    const root = this.boxes.get(instanceId);
    const down = new Set([instanceId]);
    for (let grew = true; grew && root;) {
      grew = false;
      for (const b of this.boxes.values()) {
        if (!down.has(b.id) && b.parentInstanceId && down.has(b.parentInstanceId) && b.userId === root.userId && b.status !== 'terminated') { down.add(b.id); grew = true; }
      }
    }
    this.listingRows = this.listingRows.filter(l => !(l.spaceId === spaceId && down.has(l.instanceId)));
    await this.recordListings(spaceId);
    return before !== this.grantRows.length;
  }

  async recordListings(spaceId?: string) {
    let added = 0;
    for (const p of this.projects.values()) {
      const box = p.instanceId ? this.boxes.get(p.instanceId) : undefined;
      if (!box) continue;
      const via = [box, ...await ancestorsOf(box, async id => this.boxes.get(id) ?? null)];
      for (const b of via) {
        for (const g of this.grantRows) {
          if (g.instanceId !== b.id || (spaceId && g.spaceId !== spaceId) || this.spaces.get(g.spaceId)?.deletedAt) continue;
          const had = this.listingRows.find(l => l.projectId === p.id && l.spaceId === g.spaceId);
          if (had?.instanceId === box.id) continue;
          if (had) Object.assign(had, { instanceId: box.id, addedById: g.addedById });
          else this.listingRows.push({ projectId: p.id, spaceId: g.spaceId, instanceId: box.id, addedById: g.addedById });
          added++;
        }
      }
    }
    return added;
  }

  async listedBoxes(spaceId: string) {
    const out = new Set<string>();
    for (const l of this.listingRows) {
      if (l.spaceId === spaceId && this.projects.get(l.projectId)?.instanceId === l.instanceId) out.add(l.instanceId);
    }
    return [...out];
  }

  charges: Array<LiveCharge & { spaceId: string }> = [];

  async chargeBytes(spaceId: string, bytes: bigint, liveUntil: Date, ref: ChargeRef | null, createdAt = new Date()) {
    const s = this.spaces.get(spaceId)!;
    if (s.usedBytes + bytes > s.quotaBytes) return false;
    s.usedBytes += bytes;
    this.charges.push({ id: this.id('ch'), spaceId, bytes, liveUntil, createdAt, key: ref?.key ?? null, uploadId: ref?.uploadId ?? null, partNumbers: ref?.partNumbers ?? [] });
    return true;
  }

  shareRows: Array<{ spaceId: string; path: string; sharedById: string; createdAt: Date }> = [];

  async fileShare(spaceId: string, path: string) {
    const r = this.shareRows.find(s => s.spaceId === spaceId && s.path === path);
    return r ? { ...r, sharedBy: this.users.get(r.sharedById) ?? null } : null;
  }

  async sharedPaths(spaceId: string) {
    return new Set(this.shareRows.filter(s => s.spaceId === spaceId).map(s => s.path));
  }

  async addFileShare(spaceId: string, path: string, sharedById: string) {
    if (!this.shareRows.some(s => s.spaceId === spaceId && s.path === path)) {
      this.shareRows.push({ spaceId, path, sharedById, createdAt: new Date() });
    }
    return (await this.fileShare(spaceId, path))!;
  }

  async removeFileShares(spaceId: string, target: { path: string } | { prefix: string }) {
    const hit = (p: string) => ('path' in target ? p === target.path : p.startsWith(target.prefix));
    const before = this.shareRows.length;
    this.shareRows = this.shareRows.filter(s => !(s.spaceId === spaceId && hit(s.path)));
    return before - this.shareRows.length;
  }

  async recordEvent(e: Parameters<SpaceStore['recordEvent']>[0]) {
    this.eventRows.push({ ...e, id: this.id('ev'), at: new Date() });
  }

  async lastWrite(spaceId: string, path: string) {
    return this.eventRows.filter(r => r.spaceId === spaceId && r.path === path && (r.action === 'file.put' || r.action === 'file.put.signed')).at(-1) ?? null;
  }

  async lastPutAt(spaceId: string, path: string) {
    const e = this.eventRows.filter(r => r.spaceId === spaceId && r.action === 'file.put' && r.path === path).at(-1);
    return e ? e.at : null;
  }

  async memoryEvents(spaceId: string, { since, limit }: { since: Date; limit: number }) {
    return this.eventRows.filter(e => e.spaceId === spaceId && e.at >= since && isMemoryEvent(e)).reverse().slice(0, limit);
  }

  async events(spaceId: string, { limit }: { limit: number }) {
    return this.eventRows.filter(e => e.spaceId === spaceId).reverse().slice(0, limit);
  }

  async deletedSpaces() { return [...this.spaces.values()].filter(s => s.deletedAt); }
  async liveSpaces() { return [...this.spaces.values()].filter(s => !s.deletedAt); }
  async chargesLiveAfter(spaceId: string, after: Date) {
    return this.charges.filter(c => c.spaceId === spaceId && c.liveUntil > after)
      .map(({ spaceId: _, ...c }) => ({ ...c, partNumbers: [...c.partNumbers] }));
  }

  async recountUsedBytes(spaceId: string, stored: bigint, now: Date, settled: string[]) {
    const live = this.charges.filter(c => c.spaceId === spaceId && c.liveUntil > now && !settled.includes(c.id)).reduce((t, c) => t + c.bytes, 0n);
    this.spaces.get(spaceId)!.usedBytes = stored + live;
  }

  async pruneCharges(before: Date) {
    const n = this.charges.length;
    this.charges = this.charges.filter(c => c.liveUntil >= before);
    return n - this.charges.length;
  }
  async deleteSpaceRow(spaceId: string) {
    this.spaces.delete(spaceId);
    this.shareRows = this.shareRows.filter(s => s.spaceId !== spaceId);
  }

  async pruneEvents(before: Date) {
    const n = this.eventRows.length;
    this.eventRows = this.eventRows.filter(e => isMemoryEventPath(e.path) || e.at >= before);
    return n - this.eventRows.length;
  }

  async pruneTerminatedGrants() {
    const n = this.grantRows.length;
    this.grantRows = this.grantRows.filter(g => this.boxes.get(g.instanceId)?.status !== 'terminated');
    return n - this.grantRows.length;
  }
}

/** Objects keyed by full S3 key; versions keep every size ever written. */
/** An ETag-shaped name for a key's versions: S3's are hex, never a path. */
function etagBase(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '');
}

function preconditionFailed(): Error {
  return Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
}

export class MemorySpaceObjects implements SpaceObjects {
  files = new Map<string, { size: number; contentType: string; lastModified: Date }>();
  versions = new Map<string, Array<{ size: number; lastModified: Date }>>();
  uploads = new Map<string, { key: string; contentType: string; initiated: Date; parts: Map<number, number> }>();
  bodies = new Map<string, Buffer>();
  presigned: Array<{ op: string; key: string; extra?: unknown }> = [];
  reads: string[] = [];
  private uploadSeq = 0;

  /** Every version and delete marker of a key, oldest first, as a versioned bucket keeps them. */
  history = new Map<string, Array<ObjectVersionInfo & { size: number; meta?: Record<string, string> }>>();
  /** What moves copied, for tests that check the version a copy was bound to. */
  copies: Array<{ from: string; to: string; sourceIfMatch?: string | null }> = [];
  /** As S3 does (and Floci 2.1.0, for a PUT's If-Match); false is storage that ignores them, so only the orchestrator's own checks hold. */
  enforceConditions = true;

  put(key: string, size: number, contentType = 'application/octet-stream', lastModified = new Date(), meta?: Record<string, string>) {
    this.files.set(key, { size, contentType, lastModified });
    this.versions.set(key, [...(this.versions.get(key) ?? []), { size, lastModified }]);
    const n = this.versions.get(key)!.length;
    this.history.set(key, [...(this.history.get(key) ?? []), { versionId: `v${n}`, etag: `"${etagBase(key)}-${n}"`, lastModified, deleteMarker: false, size, ...(meta ? { meta } : {}) }]);
  }

  /** A client's PUT of a presigned URL: the `x-amz-meta-*` headers it was given become the version's metadata, as S3 keeps them. */
  putSigned(key: string, size: number, headers: Record<string, string> = {}) {
    const meta = Object.fromEntries(Object.entries(headers).filter(([h]) => h.startsWith('x-amz-meta-')).map(([h, v]) => [h.slice('x-amz-meta-'.length), v]));
    this.put(key, size, headers['content-type'], new Date(), meta);
  }

  async uploadProofOf(key: string, versionId: string) {
    return (this.history.get(key) ?? []).find(v => v.versionId === versionId)?.meta?.['termag-upload'] ?? null;
  }

  /** The current version's ETag, as head gives it; null when there is no file. */
  etagOf(key: string): string | null {
    return this.files.has(key) ? `"${etagBase(key)}-${this.versions.get(key)!.length}"` : null;
  }

  /** False is a bucket without versioning: it lists the current object alone, with versionId "null". */
  versioned = true;

  async versionsOf(key: string, max = 10) {
    if (!this.versioned) {
      const cur = this.files.get(key);
      return cur ? [{ versionId: 'null', etag: this.etagOf(key), lastModified: cur.lastModified, deleteMarker: false }] : [];
    }
    return [...(this.history.get(key) ?? [])].reverse().slice(0, max).map(({ size: _size, ...v }) => v);
  }

  /** Runs just before a restore copies: a test's way to land a write in that window. */
  beforeRestore: (() => void) | null = null;
  /** As S3 does for CopyObject's If-Match on the destination (enforceConditions is for PUTs). */
  enforceCopyConditions = true;

  async restoreVersion(key: string, versionId: string, ifMatch: string | null = null) {
    this.beforeRestore?.();
    const v = (this.history.get(key) ?? []).find(x => x.versionId === versionId && !x.deleteMarker);
    if (!v) throw new Error('NoSuchVersion');
    if (ifMatch && this.enforceCopyConditions && this.etagOf(key) !== ifMatch) throw preconditionFailed();
    this.put(key, v.size, this.files.get(key)?.contentType);
    return { etag: this.etagOf(key) };
  }

  async list(prefix: string, o: { cursor?: string | null; delimiter?: boolean; max?: number } = {}): Promise<ListResult> {
    const keys = [...this.files.keys()].filter(k => k.startsWith(prefix)).sort();
    const prefixes = new Set<string>();
    const files = [];
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (o.delimiter !== false && slash >= 0) prefixes.add(prefix + rest.slice(0, slash + 1));
      else files.push({ key, size: this.files.get(key)!.size, modifiedAt: null, etag: `"${key}"` });
    }
    return { prefixes: [...prefixes], files, nextCursor: null };
  }

  async head(key: string) {
    const f = this.files.get(key);
    if (!f) return null;
    const n = this.versions.get(key)?.length ?? 0;
    return { size: f.size, contentType: f.contentType, lastModified: f.lastModified, etag: `"${etagBase(key)}-${n}"`, versionId: `v${n}` };
  }

  private url(op: string, key: string): PresignedUrl {
    return { url: `https://s3.test/${op}/${key}`, expiresAt: new Date(Date.now() + 300_000).toISOString() };
  }

  async read(key: string, maxBytes: number) {
    const f = this.files.get(key);
    if (!f) return null;
    this.reads.push(key);
    const body = this.bodies.get(key) ?? Buffer.alloc(f.size);
    return body.subarray(0, maxBytes + 1);
  }

  async presignGet(key: string, response: { contentDisposition: string; contentType?: string }, ttlS?: number) {
    this.presigned.push({ op: 'get', key, extra: ttlS === undefined ? response : { ...response, ttlS } });
    return this.url('get', key);
  }

  async presignPut(key: string, size: number, contentType: string, condition: PutCondition | null = null, proof: string | null = null): Promise<PresignedPut> {
    this.presigned.push({ op: 'put', key, extra: condition ? { size, contentType, condition } : { size, contentType } });
    const signed: Record<string, string> = condition?.ifMatch ? { 'if-match': condition.ifMatch } : condition?.ifNoneMatch ? { 'if-none-match': condition.ifNoneMatch } : {};
    return { ...this.url('put', key), method: 'PUT', headers: { 'content-type': contentType, ...signed, ...(proof ? { 'x-amz-meta-termag-upload': proof } : {}) } };
  }

  async createMultipart(key: string, contentType: string) {
    const id = `up-${++this.uploadSeq}`;
    this.uploads.set(id, { key, contentType, initiated: new Date(), parts: new Map() });
    return id;
  }

  async presignParts(key: string, uploadId: string, parts: Array<{ partNumber: number; size: number }>) {
    this.presigned.push({ op: 'parts', key, extra: parts });
    return parts.map(({ partNumber }) => ({ partNumber, ...this.url(`part/${uploadId}/${partNumber}`, key) }));
  }

  async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>, condition: PutCondition | null = null) {
    const up = this.uploads.get(uploadId);
    if (!up || up.key !== key) throw new Error('NoSuchUpload');
    if (condition && this.enforceConditions) {
      const now = this.etagOf(key);
      if (condition.ifNoneMatch ? now !== null : now !== condition.ifMatch) throw preconditionFailed();
    }
    this.put(key, parts.length * 10, up.contentType);
    this.uploads.delete(uploadId);
    return { etag: this.etagOf(key) };
  }

  async abortMultipart(_key: string, uploadId: string) { this.uploads.delete(uploadId); }

  async copy(from: string, to: string, opts: { sourceIfMatch?: string | null } = {}) {
    const f = this.files.get(from);
    if (!f) throw new Error('NoSuchKey');
    this.copies.push({ from, to, ...(opts.sourceIfMatch ? { sourceIfMatch: opts.sourceIfMatch } : {}) });
    if (opts.sourceIfMatch && this.enforceConditions && opts.sourceIfMatch !== this.etagOf(from)) throw preconditionFailed();
    this.put(to, f.size, f.contentType);
  }

  async deleteKeys(keys: string[]) {
    for (const k of keys) {
      if (this.files.delete(k)) this.history.set(k, [...(this.history.get(k) ?? []), { versionId: `dm${this.history.get(k)?.length ?? 0}`, etag: null, lastModified: new Date(), deleteMarker: true, size: 0 }]);
    }
    return [];
  }

  async sumVersions(prefix: string, watch: Set<string>) {
    let total = 0n;
    const watched: ObjectVersion[] = [];
    for (const [key, vs] of this.versions) {
      if (!key.startsWith(prefix)) continue;
      for (const v of vs) {
        total += BigInt(v.size);
        if (watch.has(key)) watched.push({ key, size: BigInt(v.size), lastModified: v.lastModified });
      }
    }
    return { total, watched };
  }

  async purgePrefix(prefix: string) {
    let n = 0;
    for (const k of [...this.versions.keys()]) {
      if (k.startsWith(prefix)) { n += this.versions.get(k)!.length; this.versions.delete(k); this.files.delete(k); }
    }
    return n;
  }

  async sweepMultipart(prefix: string, abortBefore: Date) {
    let aborted = 0;
    const inProgress: OpenUpload[] = [];
    for (const [id, u] of [...this.uploads]) {
      if (!u.key.startsWith(prefix)) continue;
      if (u.initiated < abortBefore) { this.uploads.delete(id); aborted++; } else inProgress.push({ key: u.key, uploadId: id, parts: [...u.parts].map(([partNumber, bytes]) => ({ partNumber, bytes: BigInt(bytes) })) });
    }
    return { aborted, inProgress };
  }
}
