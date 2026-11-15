/**
 * SpaceObjects on a directory of the orchestrator host, for installations
 * without the spaces bucket (docs/spaces-local-storage.md). Bytes still go
 * straight between the client and storage over signed URLs; here the storage
 * is routes/spaceStorage.ts, which calls receivePut, receivePart and
 * currentFile below.
 *
 * It keeps the S3 semantics the rest of spaces depend on: every version is
 * kept and a delete is a marker (conditions, restore, the landed check and
 * quota all assume a versioned bucket), a conditional write is decided at
 * commit, and errors carry S3's names and `$metadata.httpStatusCode`, so
 * spaceFileOps.ts's preconditionFailed and friends read them unchanged.
 *
 * Layout under the root:
 *
 *   objects/  a key `<spaceId>/<path>`, segment by segment: `d.<segment>/`
 *             for a folder and `o.<segment>/` for the object, so a file `a`
 *             and a folder `a/` coexist as in S3 and no name is `.` or `..`.
 *             A segment over MAX_SEGMENT_BYTES is `D.`/`O.` + its sha256,
 *             with the segment in a `name` file inside.
 *             An object directory holds `index.json` (its versions and delete
 *             markers, oldest first) and one immutable file per version,
 *             named by the version id.
 *   uploads/  `<uploadId>/` per multipart upload: `upload.json` and the parts.
 *   tmp/      writes in progress, renamed into place at commit.
 *
 * Each commit holds a lock on the object directory (a `mkdir` lock, so two
 * orchestrator processes on one host serialise too) while it checks the
 * condition and rewrites index.json by write-and-rename. ETags are opaque and
 * distinct per version, as SSE-KMS's are on the bucket.
 */
import { createHash, randomBytes } from 'crypto';
import { createReadStream, createWriteStream, promises as fs } from 'fs';
import { join } from 'path';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { PutCondition } from './spaceMemory';
import {
  DOWNLOAD_TTL_S, PART_TTL_S, PUT_TTL_S, VIEW_TTL_S,
  type ListResult, type ListedFile, type ObjectVersion, type OpenUpload, type PresignedPut, type PresignedUrl, type SpaceObjects,
} from './spaceObjects';
import { signGrant, storageSigningKey, verifyGrant, type StorageGrant } from './spaceStorageTokens';
import { sameEtag, type ObjectVersionInfo } from './spaceVersions';

export const MAX_SEGMENT_BYTES = 200;
export const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 15_000;
const INDEX = 'index.json';
const LOCK = 'lock';
const NAME = 'name';
const UPLOAD = 'upload.json';
const UPLOAD_ID_RE = /^[0-9a-f]{32}$/;

interface VersionEntry {
  versionId: string;
  /** Null for a delete marker. */
  etag: string | null;
  size: number;
  contentType: string | null;
  lastModified: string;
  deleteMarker: boolean;
  meta?: Record<string, string>;
}

interface UploadMeta { key: string; contentType: string; initiated: string }
interface PartMeta { size: number; etag: string }

/** An S3-shaped error: the name and status the SDK's would carry. */
export class StorageError extends Error {
  readonly $metadata: { httpStatusCode: number };
  constructor(readonly code: string, readonly status: number, message = code) {
    super(message);
    this.name = code;
    this.$metadata = { httpStatusCode: status };
  }
}

const preconditionFailed = () => new StorageError('PreconditionFailed', 412, 'At least one of the preconditions you specified did not hold');

function md5(): ReturnType<typeof createHash> { return createHash('md5'); }
function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

/** Sortable by creation within a process, unique across processes. */
function newVersionId(): string {
  return `${Date.now().toString(36).padStart(9, '0')}${randomBytes(8).toString('hex')}`;
}

/** Distinct per version even for the same bytes, as SSE-KMS ETags are. */
function versionEtag(digest: string, versionId: string, parts?: number): string {
  const hex = createHash('md5').update(`${digest}:${versionId}`).digest('hex');
  return `"${hex}${parts ? `-${parts}` : ''}"`;
}

function live(versions: VersionEntry[]): VersionEntry | null {
  const last = versions[versions.length - 1];
  return last && !last.deleteMarker ? last : null;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function expiresAt(ttlS: number): string {
  return new Date(Date.now() + ttlS * 1000).toISOString();
}

/** A key's segments, refusing what no space key can be (spacePaths.ts refuses these too). */
function segmentsOf(key: string, opts: { object: boolean }): string[] {
  if (key.includes('\0')) throw new StorageError('InvalidArgument', 400, 'Key contains NUL');
  const segs = key.split('/');
  if (!opts.object) segs.pop();
  if (segs.some(s => s === '')) throw new StorageError('InvalidArgument', 400, `Key ${JSON.stringify(key)} has an empty segment`);
  return segs;
}

function entryName(kind: 'd' | 'o', seg: string): string {
  return Buffer.byteLength(seg) <= MAX_SEGMENT_BYTES ? `${kind}.${seg}` : `${kind.toUpperCase()}.${sha256(seg)}`;
}

export interface LocalSpaceObjectsOptions {
  root: string;
  /** Where routes/spaceStorage.ts is mounted, absolute: `${FRONTEND_URL}${BASE_PATH}/api/space-storage`. */
  baseUrl: string;
  /** SESSION_SECRET; the URL key is derived from it (spaceStorageTokens.ts). */
  secret: string;
  now?: () => number;
}

export class LocalSpaceObjects implements SpaceObjects {
  private readonly objectsDir: string;
  private readonly uploadsDir: string;
  private readonly tmpDir: string;
  private readonly key: Buffer;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(opts: LocalSpaceObjectsOptions) {
    this.objectsDir = join(opts.root, 'objects');
    this.uploadsDir = join(opts.root, 'uploads');
    this.tmpDir = join(opts.root, 'tmp');
    this.key = storageSigningKey(opts.secret);
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.now = opts.now ?? Date.now;
  }

  // ---- paths and index ----

  private dirOf(segs: string[]): string {
    return join(this.objectsDir, ...segs.map(s => entryName('d', s)));
  }

  private objectDir(key: string): string {
    const segs = segmentsOf(key, { object: true });
    const last = segs.pop()!;
    return join(this.dirOf(segs), entryName('o', last));
  }

  /** Creates the object's directory and its parents, with the `name` file a hashed one needs. */
  private async ensureObjectDir(key: string): Promise<string> {
    const segs = segmentsOf(key, { object: true });
    let dir = this.objectsDir;
    for (let i = 0; i < segs.length; i++) {
      const name = entryName(i === segs.length - 1 ? 'o' : 'd', segs[i]);
      dir = join(dir, name);
      await fs.mkdir(dir, { recursive: true });
      if (name[0] === 'D' || name[0] === 'O') await fs.writeFile(join(dir, NAME), segs[i], { flag: 'w' });
    }
    return dir;
  }

  private async readIndex(dir: string): Promise<VersionEntry[]> {
    try {
      return (JSON.parse(await fs.readFile(join(dir, INDEX), 'utf8')) as { versions: VersionEntry[] }).versions;
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  }

  private async writeIndex(dir: string, versions: VersionEntry[]): Promise<void> {
    const tmp = join(dir, `${INDEX}.${randomBytes(6).toString('hex')}`);
    await fs.writeFile(tmp, JSON.stringify({ versions }));
    await fs.rename(tmp, join(dir, INDEX));
  }

  private async current(key: string): Promise<{ dir: string; entry: VersionEntry } | null> {
    const dir = this.objectDir(key);
    const entry = live(await this.readIndex(dir));
    return entry ? { dir, entry } : null;
  }

  private async withLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const lock = join(dir, LOCK);
    const deadline = this.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        await fs.mkdir(lock);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const st = await fs.stat(lock).catch(() => null);
        if (st && Date.now() - st.mtimeMs > STALE_LOCK_MS) {
          console.warn(`[SPACES] taking a stale lock on ${dir}`);
          await fs.rmdir(lock).catch(() => {});
          continue;
        }
        if (this.now() > deadline) throw new StorageError('SlowDown', 503, 'The object is busy; try again');
        await sleep(5 + Math.random() * 20);
      }
    }
    try { return await fn(); } finally { await fs.rmdir(lock).catch(() => {}); }
  }

  private tmpPath(): string {
    return join(this.tmpDir, `${Date.now().toString(36)}-${randomBytes(8).toString('hex')}`);
  }

  /**
   * Makes `file` (in tmp/) the key's new current version, if `condition`
   * holds under the lock; otherwise 412 and the file is left for the caller.
   */
  private async commit(
    key: string,
    file: string,
    v: { size: number; contentType: string | null; digest: string; parts?: number; meta?: Record<string, string> },
    condition: PutCondition | null,
  ): Promise<VersionEntry> {
    const dir = await this.ensureObjectDir(key);
    return this.withLock(dir, async () => {
      const versions = await this.readIndex(dir);
      const cur = live(versions);
      if (condition?.ifNoneMatch && cur) throw preconditionFailed();
      if (condition?.ifMatch && (!cur || !sameEtag(cur.etag!, condition.ifMatch))) throw preconditionFailed();
      const versionId = newVersionId();
      await fs.rename(file, join(dir, versionId));
      const entry: VersionEntry = {
        versionId, etag: versionEtag(v.digest, versionId, v.parts), size: v.size, contentType: v.contentType,
        lastModified: new Date(this.now()).toISOString(), deleteMarker: false, ...(v.meta ? { meta: v.meta } : {}),
      };
      await this.writeIndex(dir, [...versions, entry]);
      return entry;
    });
  }

  /** A hard link to an immutable version file in tmp/ (a copy where links don't work), for copy and restore. */
  private async stage(source: string): Promise<string> {
    await fs.mkdir(this.tmpDir, { recursive: true });
    const tmp = this.tmpPath();
    try {
      await fs.link(source, tmp);
    } catch (err) {
      if (isMissing(err)) throw new StorageError('NoSuchKey', 404, 'The version is gone');
      await fs.copyFile(source, tmp);
    }
    return tmp;
  }

  /** Streams `body` into tmp/: exactly `size` bytes, or it fails and leaves nothing. */
  private async receive(body: Readable, size: number): Promise<{ file: string; md5: string }> {
    await fs.mkdir(this.tmpDir, { recursive: true });
    const file = this.tmpPath();
    const hash = md5();
    let seen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        seen += chunk.length;
        if (seen > size) { done(new StorageError('IncompleteBody', 400, 'The body is longer than the signed Content-Length')); return; }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    try {
      await pipeline(body, meter, createWriteStream(file, { flags: 'wx' }));
      if (seen !== size) throw new StorageError('IncompleteBody', 400, `The body was ${seen} bytes of the ${size} signed`);
    } catch (err) {
      await fs.rm(file, { force: true });
      throw err;
    }
    return { file, md5: hash.digest('hex') };
  }

  private url(grant: StorageGrant): string {
    return `${this.baseUrl}/${signGrant(this.key, grant)}`;
  }

  // ---- what routes/spaceStorage.ts serves ----

  /** The grant a token carries, or null (bad, tampered with or expired). */
  grantOf(token: string): StorageGrant | null {
    return verifyGrant(this.key, token, this.now());
  }

  /** The current version's file, for a signed GET. */
  async currentFile(key: string): Promise<{ path: string; size: number; etag: string; contentType: string | null; lastModified: Date } | null> {
    const cur = await this.current(key);
    if (!cur) return null;
    const { dir, entry } = cur;
    return { path: join(dir, entry.versionId), size: entry.size, etag: entry.etag!, contentType: entry.contentType, lastModified: new Date(entry.lastModified) };
  }

  /** A signed PUT's body becomes the key's new version, if the signed condition holds. */
  async receivePut(grant: Extract<StorageGrant, { op: 'put' }>, body: Readable): Promise<{ etag: string; versionId: string }> {
    const { file, md5: contentMd5 } = await this.receive(body, grant.size);
    try {
      const entry = await this.commit(grant.key, file, {
        size: grant.size, contentType: grant.contentType, digest: contentMd5,
        ...(grant.proof ? { meta: { 'termag-upload': grant.proof } } : {}),
      }, grant.condition);
      return { etag: entry.etag!, versionId: entry.versionId };
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  /** A signed part's body, kept until the upload completes or is aborted. Answers the part's ETag. */
  async receivePart(grant: Extract<StorageGrant, { op: 'part' }>, body: Readable): Promise<{ etag: string }> {
    const dir = await this.uploadDir(grant.key, grant.uploadId);
    const { file, md5: hex } = await this.receive(body, grant.size);
    try {
      const etag = `"${hex}"`;
      await fs.rename(file, join(dir, String(grant.partNumber)));
      const meta: PartMeta = { size: grant.size, etag };
      await fs.writeFile(join(dir, `${grant.partNumber}.json`), JSON.stringify(meta));
      return { etag };
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  private async uploadDir(key: string, uploadId: string): Promise<string> {
    if (!UPLOAD_ID_RE.test(uploadId)) throw new StorageError('NoSuchUpload', 404);
    const dir = join(this.uploadsDir, uploadId);
    let meta: UploadMeta;
    try {
      meta = JSON.parse(await fs.readFile(join(dir, UPLOAD), 'utf8')) as UploadMeta;
    } catch (err) {
      if (isMissing(err)) throw new StorageError('NoSuchUpload', 404);
      throw err;
    }
    if (meta.key !== key) throw new StorageError('NoSuchUpload', 404);
    return dir;
  }

  // ---- SpaceObjects ----

  async list(prefix: string, o: { cursor?: string | null; delimiter?: boolean; max?: number } = {}): Promise<ListResult> {
    const max = o.max ?? 1000;
    const cut = prefix.lastIndexOf('/') + 1;
    const dirPart = prefix.slice(0, cut);
    const rest = prefix.slice(cut);
    const dir = this.dirOf(segmentsOf(dirPart, { object: false }));
    const entries: Array<{ key: string; file?: ListedFile }> = [];

    for (const child of await this.children(dir)) {
      if (!child.seg.startsWith(rest)) continue;
      if (child.kind === 'o') {
        const key = dirPart + child.seg;
        const entry = live(await this.readIndex(child.path));
        if (entry) entries.push({ key, file: { key, size: entry.size, modifiedAt: entry.lastModified, etag: entry.etag } });
      } else if (o.delimiter === false) {
        for await (const f of this.liveFiles(child.path, `${dirPart}${child.seg}/`)) entries.push({ key: f.key, file: f });
      } else if (await this.hasLive(child.path)) {
        entries.push({ key: `${dirPart}${child.seg}/` });
      }
    }

    entries.sort((a, b) => byteCompare(a.key, b.key));
    const after = o.cursor ? Buffer.from(o.cursor, 'base64url').toString('utf8') : null;
    const from = after === null ? entries : entries.filter(e => byteCompare(e.key, after) > 0);
    const page = from.slice(0, max);
    return {
      prefixes: page.filter(e => !e.file).map(e => e.key),
      files: page.filter(e => e.file).map(e => e.file!),
      nextCursor: from.length > max ? Buffer.from(page[page.length - 1].key).toString('base64url') : null,
    };
  }

  /** A folder's entries, decoded: `kind` d or o, the real segment, the path on disk. */
  private async children(dir: string): Promise<Array<{ kind: 'd' | 'o'; seg: string; path: string }>> {
    let names: string[];
    try { names = await fs.readdir(dir); } catch (err) { if (isMissing(err)) return []; throw err; }
    const out: Array<{ kind: 'd' | 'o'; seg: string; path: string }> = [];
    for (const name of names) {
      const path = join(dir, name);
      if (name.startsWith('d.') || name.startsWith('o.')) {
        out.push({ kind: name[0] as 'd' | 'o', seg: name.slice(2), path });
      } else if (name.startsWith('D.') || name.startsWith('O.')) {
        const seg = await fs.readFile(join(path, NAME), 'utf8').catch(() => null);
        if (seg !== null) out.push({ kind: name[0].toLowerCase() as 'd' | 'o', seg, path });
      }
    }
    return out;
  }

  /** Every object under a folder, with its versions, depth first. */
  private async *objectsUnder(dir: string, keyPrefix: string): AsyncGenerator<{ key: string; dir: string; versions: VersionEntry[] }> {
    for (const child of await this.children(dir)) {
      if (child.kind === 'o') yield { key: keyPrefix + child.seg, dir: child.path, versions: await this.readIndex(child.path) };
      else yield* this.objectsUnder(child.path, `${keyPrefix}${child.seg}/`);
    }
  }

  private async *liveFiles(dir: string, keyPrefix: string): AsyncGenerator<ListedFile> {
    for await (const obj of this.objectsUnder(dir, keyPrefix)) {
      const entry = live(obj.versions);
      if (entry) yield { key: obj.key, size: entry.size, modifiedAt: entry.lastModified, etag: entry.etag };
    }
  }

  private async hasLive(dir: string): Promise<boolean> {
    for await (const _f of this.liveFiles(dir, '')) return true;
    return false;
  }

  /** Every object whose key starts with `prefix`, which need not end in `/`. */
  private async *objectsWithPrefix(prefix: string): AsyncGenerator<{ key: string; dir: string; versions: VersionEntry[] }> {
    const cut = prefix.lastIndexOf('/') + 1;
    const dirPart = prefix.slice(0, cut);
    const rest = prefix.slice(cut);
    const dir = this.dirOf(segmentsOf(dirPart, { object: false }));
    for (const child of await this.children(dir)) {
      if (!child.seg.startsWith(rest)) continue;
      if (child.kind === 'o') yield { key: dirPart + child.seg, dir: child.path, versions: await this.readIndex(child.path) };
      else yield* this.objectsUnder(child.path, `${dirPart}${child.seg}/`);
    }
  }

  async head(key: string) {
    const cur = await this.current(key);
    if (!cur) return null;
    const { entry } = cur;
    return { size: entry.size, contentType: entry.contentType, lastModified: new Date(entry.lastModified), etag: entry.etag, versionId: entry.versionId };
  }

  async read(key: string, maxBytes: number): Promise<Buffer | null> {
    const file = await this.currentFile(key);
    if (!file) return null;
    let fh;
    try { fh = await fs.open(file.path, 'r'); } catch (err) { if (isMissing(err)) return null; throw err; }
    try {
      const buf = Buffer.alloc(Math.min(maxBytes + 1, file.size));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async presignGet(key: string, response: { contentDisposition: string; contentType?: string }, ttlS = DOWNLOAD_TTL_S): Promise<PresignedUrl> {
    const expiresIn = Math.min(ttlS, VIEW_TTL_S);
    segmentsOf(key, { object: true });
    const url = this.url({
      op: 'get', key, disposition: response.contentDisposition,
      ...(response.contentType ? { contentType: response.contentType } : {}),
      exp: this.now() + expiresIn * 1000,
    });
    return { url, expiresAt: expiresAt(expiresIn) };
  }

  async presignPut(key: string, size: number, contentType: string, condition: PutCondition | null = null, proof: string | null = null): Promise<PresignedPut> {
    segmentsOf(key, { object: true });
    const url = this.url({ op: 'put', key, size, contentType, condition, proof, exp: this.now() + PUT_TTL_S * 1000 });
    // The condition headers are what S3's URL wants sent; this storage acts on the signed condition alone.
    const conditionHeaders: Record<string, string> = condition?.ifMatch ? { 'if-match': condition.ifMatch }
      : condition?.ifNoneMatch ? { 'if-none-match': condition.ifNoneMatch } : {};
    return { method: 'PUT', url, headers: { 'content-type': contentType, ...conditionHeaders }, expiresAt: expiresAt(PUT_TTL_S) };
  }

  async uploadProofOf(key: string, versionId: string): Promise<string | null> {
    const versions = await this.readIndex(this.objectDir(key));
    return versions.find(v => v.versionId === versionId)?.meta?.['termag-upload'] ?? null;
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    segmentsOf(key, { object: true });
    const uploadId = randomBytes(16).toString('hex');
    const dir = join(this.uploadsDir, uploadId);
    await fs.mkdir(dir, { recursive: true });
    const meta: UploadMeta = { key, contentType, initiated: new Date(this.now()).toISOString() };
    await fs.writeFile(join(dir, UPLOAD), JSON.stringify(meta));
    return uploadId;
  }

  async presignParts(key: string, uploadId: string, parts: Array<{ partNumber: number; size: number }>) {
    return parts.map(({ partNumber, size }) => ({
      partNumber,
      url: this.url({ op: 'part', key, uploadId, partNumber, size, exp: this.now() + PART_TTL_S * 1000 }),
      expiresAt: expiresAt(PART_TTL_S),
    }));
  }

  async completeMultipart(key: string, uploadId: string, parts: Array<{ partNumber: number; etag: string }>, condition: PutCondition | null = null) {
    const dir = await this.uploadDir(key, uploadId);
    const meta = JSON.parse(await fs.readFile(join(dir, UPLOAD), 'utf8')) as UploadMeta;
    if (parts.length === 0) throw new StorageError('MalformedXML', 400, 'An upload needs at least one part');
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].partNumber <= parts[i - 1].partNumber) throw new StorageError('InvalidPartOrder', 400);
    }
    const all = md5();
    let size = 0;
    for (const p of parts) {
      const held = await fs.readFile(join(dir, `${p.partNumber}.json`), 'utf8').then(s => JSON.parse(s) as PartMeta, () => null);
      if (!held || !sameEtag(held.etag, p.etag)) throw new StorageError('InvalidPart', 400, `Part ${p.partNumber} is missing or its ETag does not match`);
      all.update(Buffer.from(held.etag.replace(/"/g, ''), 'hex'));
      size += held.size;
    }
    await fs.mkdir(this.tmpDir, { recursive: true });
    const file = this.tmpPath();
    try {
      const out = createWriteStream(file, { flags: 'wx' });
      try {
        for (const p of parts) await pipeline(createReadStream(join(dir, String(p.partNumber))), out, { end: false });
      } finally {
        await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      }
      const entry = await this.commit(key, file, { size, contentType: meta.contentType, digest: all.digest('hex'), parts: parts.length }, condition);
      await fs.rm(dir, { recursive: true, force: true });
      return { etag: entry.etag };
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const dir = await this.uploadDir(key, uploadId);
    await fs.rm(dir, { recursive: true, force: true });
  }

  async copy(fromKey: string, toKey: string, opts: { sourceIfMatch?: string | null } = {}): Promise<void> {
    const src = await this.current(fromKey);
    if (!src) throw new StorageError('NoSuchKey', 404, 'The specified key does not exist');
    if (opts.sourceIfMatch && !sameEtag(src.entry.etag!, opts.sourceIfMatch)) throw preconditionFailed();
    const file = await this.stage(join(src.dir, src.entry.versionId));
    try {
      // As CopyObject's default COPY directive: the type and metadata go with the bytes.
      await this.commit(toKey, file, {
        size: src.entry.size, contentType: src.entry.contentType, digest: src.entry.etag!,
        ...(src.entry.meta ? { meta: src.entry.meta } : {}),
      }, null);
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  async versionsOf(key: string, max = 10): Promise<ObjectVersionInfo[]> {
    const versions = await this.readIndex(this.objectDir(key));
    return [...versions].reverse().slice(0, max).map(v => ({
      versionId: v.versionId, etag: v.deleteMarker ? null : v.etag, lastModified: new Date(v.lastModified), deleteMarker: v.deleteMarker,
    }));
  }

  async restoreVersion(key: string, versionId: string, ifMatch: string | null = null): Promise<{ etag: string | null }> {
    const dir = this.objectDir(key);
    const v = (await this.readIndex(dir)).find(x => x.versionId === versionId && !x.deleteMarker);
    if (!v) throw new StorageError('NoSuchVersion', 404, 'The specified version does not exist');
    const file = await this.stage(join(dir, v.versionId));
    try {
      const entry = await this.commit(key, file, {
        size: v.size, contentType: v.contentType, digest: v.etag!, ...(v.meta ? { meta: v.meta } : {}),
      }, ifMatch ? { ifMatch } : null);
      return { etag: entry.etag };
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  async deleteKeys(keys: string[]): Promise<string[]> {
    const failed: string[] = [];
    for (const key of keys) {
      try {
        const dir = this.objectDir(key);
        if (!live(await this.readIndex(dir))) continue;
        await this.withLock(dir, async () => {
          const versions = await this.readIndex(dir);
          if (!live(versions)) return;
          const marker: VersionEntry = {
            versionId: newVersionId(), etag: null, size: 0, contentType: null,
            lastModified: new Date(this.now()).toISOString(), deleteMarker: true,
          };
          await this.writeIndex(dir, [...versions, marker]);
        });
      } catch (err) {
        console.warn(`[SPACES] delete ${key} failed: ${(err as Error).message}`);
        failed.push(key);
      }
    }
    return failed;
  }

  async sumVersions(prefix: string, watch: Set<string>): Promise<{ total: bigint; watched: ObjectVersion[] }> {
    let total = 0n;
    const watched: ObjectVersion[] = [];
    for await (const obj of this.objectsWithPrefix(prefix)) {
      for (const v of obj.versions) {
        if (v.deleteMarker) continue;
        total += BigInt(v.size);
        if (watch.has(obj.key)) watched.push({ key: obj.key, size: BigInt(v.size), lastModified: new Date(v.lastModified) });
      }
    }
    return { total, watched };
  }

  async purgePrefix(prefix: string): Promise<number> {
    let removed = 0;
    for await (const obj of this.objectsWithPrefix(prefix)) {
      removed += obj.versions.length;
      await fs.rm(obj.dir, { recursive: true, force: true });
    }
    await this.pruneEmpty(this.objectsDir);
    return removed;
  }

  /** Removes folders left with no objects under them, so listing stays cheap. Answers whether `dir` is now empty. */
  private async pruneEmpty(dir: string, isRoot = true): Promise<boolean> {
    let names: string[];
    try { names = await fs.readdir(dir); } catch (err) { if (isMissing(err)) return true; throw err; }
    let left = 0;
    for (const name of names) {
      if ((name.startsWith('d.') || name.startsWith('D.')) && await this.pruneEmpty(join(dir, name), false)) continue;
      if (name !== NAME) left++;
    }
    if (left === 0 && !isRoot) {
      await fs.rm(dir, { recursive: true, force: true });
      return true;
    }
    return false;
  }

  async sweepMultipart(prefix: string, abortBefore: Date): Promise<{ aborted: number; inProgress: OpenUpload[] }> {
    let aborted = 0;
    const inProgress: OpenUpload[] = [];
    let ids: string[];
    try { ids = await fs.readdir(this.uploadsDir); } catch (err) { if (isMissing(err)) return { aborted, inProgress }; throw err; }
    for (const uploadId of ids) {
      if (!UPLOAD_ID_RE.test(uploadId)) continue;
      const dir = join(this.uploadsDir, uploadId);
      const meta = await fs.readFile(join(dir, UPLOAD), 'utf8').then(s => JSON.parse(s) as UploadMeta, () => null);
      if (!meta || !meta.key.startsWith(prefix)) continue;
      if (new Date(meta.initiated) < abortBefore) {
        await fs.rm(dir, { recursive: true, force: true });
        aborted++;
        continue;
      }
      const parts: OpenUpload['parts'] = [];
      for (const name of await fs.readdir(dir)) {
        const m = /^(\d+)\.json$/.exec(name);
        if (!m) continue;
        const held = await fs.readFile(join(dir, name), 'utf8').then(s => JSON.parse(s) as PartMeta, () => null);
        if (held) parts.push({ partNumber: Number(m[1]), bytes: BigInt(held.size) });
      }
      parts.sort((a, b) => a.partNumber - b.partNumber);
      inProgress.push({ key: meta.key, uploadId, parts });
    }
    return { aborted, inProgress };
  }

  /** Removes writes abandoned in tmp/ (a crash mid-upload); for startup. */
  async cleanTmp(olderThanMs = 60 * 60 * 1000): Promise<number> {
    let names: string[];
    try { names = await fs.readdir(this.tmpDir); } catch (err) { if (isMissing(err)) return 0; throw err; }
    let n = 0;
    for (const name of names) {
      const st = await fs.stat(join(this.tmpDir, name)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > olderThanMs) { await fs.rm(join(this.tmpDir, name), { force: true }); n++; }
    }
    return n;
  }
}
