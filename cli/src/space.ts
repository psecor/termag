import { constants as fsConstants, copyFileSync, createWriteStream, existsSync, linkSync, readFileSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, closeSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Api } from './api.js';
import type { CommandSpec, ParsedArgs } from './args.js';
import { authedApi, session } from './commands.js';
import type { Ctx } from './context.js';
import { CliError, EXIT, usage, type ExitCode } from './errors.js';
import { json, table } from './output.js';
import { memoryPutRefusal } from './spaceMemory.js';
import { cmdSpaceSlack, SPACE_SLACK_COMMAND } from './spaceSlack.js';
import { forgetVersions, rememberVersion, rememberVersions, versionOf } from './spaceVersions.js';

/**
 * The version cache is a hint: a write to it that is refused (a planted
 * symlink, spacesPath.ts) is said on stderr, and the transfer that was
 * already done stands.
 */
function remembering(ctx: Ctx, fn: () => void): void {
  try { fn(); } catch (err) { ctx.err(`termag: not remembering file versions: ${(err as Error).message}`); }
}

/**
 * `termag space …`: a shared file store across boxes.
 *
 * On a box these run with the box's own token, acting as the box; on a laptop
 * with the device login. The orchestrator only hands out presigned S3 URLs,
 * so every byte goes between this process and S3 directly.
 *
 * A remote path is `space:path`. The `space:` may be left out when the caller
 * reaches exactly one space.
 */

const SPACE_TIMEOUT_MS = 60_000;
const TRANSFER_RETRIES = 3;
const PART_URL_BATCH = 16;
export const SPACE_NAME_RE = /^[a-z0-9-]{2,40}$/;

const recursive = { type: 'boolean', short: 'r' } as const;

export const SPACE_COMMANDS: Record<string, CommandSpec> = {
  'space ls': {
    summary: 'List the spaces you (or this box) can reach, or the files in one',
    usage: 'termag space ls [space[:prefix]]',
    maxArgs: 1,
  },
  'space get': {
    summary: 'Download a file, or a folder with -r',
    usage: 'termag space get <space:path> [dest] [-r]',
    options: { recursive },
    maxArgs: 2,
  },
  'space url': {
    summary: 'Print a browser link to a file; it opens for anyone who can read the space, or everyone on termag once shared',
    usage: 'termag space url <space:path>',
    maxArgs: 1,
  },
  'space share': {
    summary: 'Share a file read-only with everyone signed in to termag (needs editor or owner)',
    usage: 'termag space share <space:path>',
    maxArgs: 1,
  },
  'space unshare': {
    summary: 'Make a shared file private again: only the space\'s members can open it',
    usage: 'termag space unshare <space:path>',
    maxArgs: 1,
  },
  'space put': {
    summary: 'Upload a file, or a folder with -r; refused (exit 6) if it changed since you read it',
    usage: 'termag space put <local> <space:path> [-r] [--if-match <etag> | --if-new | --force]',
    options: { recursive, 'if-match': { type: 'string' }, 'if-new': { type: 'boolean' }, force: { type: 'boolean' } },
    maxArgs: 2,
  },
  'space rm': {
    summary: 'Delete a file, or a folder with -r (old versions are kept); a file you read is checked first',
    usage: 'termag space rm <space:path> [-r] [--force]',
    options: { recursive, force: { type: 'boolean' } },
    maxArgs: 1,
  },
  'space mv': {
    summary: 'Move or rename a file or folder (folders end in /); a file you read is checked first',
    usage: 'termag space mv <space:from> <space:to> [--force]',
    options: { force: { type: 'boolean' } },
    maxArgs: 2,
  },
  'space create': {
    summary: 'Create a space; you become its owner',
    usage: 'termag space create <name> [--description <text>]',
    options: { description: { type: 'string' } },
    maxArgs: 1,
  },
  'space members': {
    summary: 'List or change a space\'s members',
    usage: 'termag space members <space> [add <email> <owner|editor|viewer> | rm <email>]',
    maxArgs: 4,
  },
  'space boxes': {
    summary: 'List or change the boxes that can reach a space',
    usage: 'termag space boxes <space> [add <box> | rm <box>]',
    maxArgs: 3,
  },
  'space slack': SPACE_SLACK_COMMAND,
};

export interface SpaceView {
  id: string;
  name: string;
  description: string | null;
  role: string;
  readOnly: boolean;
  usedBytes: number;
  quotaBytes: number;
  access?: { kind: 'explicit' } | { kind: 'inherited'; via: string };
}

export interface TreeFile { name: string; path: string; size: number; modifiedAt: string | null; etag?: string | null; shared?: boolean }
interface Tree { prefix: string; dirs: Array<{ name: string; path: string }>; files: TreeFile[]; nextCursor: string | null }

type SingleUpload = { kind: 'single'; path: string; url: string; method: 'PUT'; headers: Record<string, string> };
type MultipartUpload = { kind: 'multipart'; path: string; uploadId: string; partBytes: number; partCount: number };

export interface RemoteRef { space: string | null; path: string }

/**
 * `space:path`, or a bare path when the space is left out. Prompts and skills often write
 * `space:<name>:<path>` with the literal word `space:` in front; that names space `<name>`
 * (reading it as space "space" sent every such call to a bare 404).
 */
export function parseRemote(raw: string): RemoteRef {
  const literal = /^space:([a-z0-9-]{2,40}):/.exec(raw);
  if (literal) return { space: literal[1], path: raw.slice(literal[0].length) };
  const colon = raw.indexOf(':');
  if (colon > 0 && SPACE_NAME_RE.test(raw.slice(0, colon))) return { space: raw.slice(0, colon), path: raw.slice(colon + 1) };
  return { space: null, path: raw };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Where a remote file lands under `root`; refuses anything that would escape it. */
export function localTarget(root: string, relativePath: string): string {
  const base = resolve(root);
  const target = resolve(base, ...relativePath.split('/'));
  if (target !== base && !target.startsWith(base + sep)) {
    throw new CliError('failed', `Refusing to write ${JSON.stringify(relativePath)} outside ${base}`);
  }
  if (target === base) throw new CliError('failed', `Refusing to overwrite ${base} itself`);
  return target;
}

const CONTENT_TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', yaml: 'application/yaml', yml: 'application/yaml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', html: 'text/html', svg: 'image/svg+xml',
};

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  return (dot > 0 && CONTENT_TYPES[path.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

export async function api(ctx: Ctx, args: ParsedArgs): Promise<Api> {
  return authedApi(ctx, session(ctx, args), { timeoutMs: SPACE_TIMEOUT_MS });
}

export async function listSpaces(a: Api): Promise<SpaceView[]> {
  return (await a.request<{ spaces: SpaceView[] }>('GET', '/spaces')).spaces;
}

/** The space a remote ref names, or the only one the caller reaches. */
async function spaceOf(a: Api, ref: RemoteRef): Promise<string> {
  if (ref.space) return ref.space;
  const spaces = await listSpaces(a);
  if (spaces.length === 1) return spaces[0].name;
  if (spaces.length === 0) throw new CliError('not_found', 'You reach no spaces; ask a space owner to add you or this box');
  throw usage(`Name the space as space:path; you reach ${spaces.map(s => s.name).join(', ')}`);
}

async function withRetry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= TRANSFER_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (err instanceof CliError && err.code !== 'failed') throw err;
      if (attempt < TRANSFER_RETRIES) await new Promise(r => setTimeout(r, 250 * 2 ** attempt));
    }
  }
  throw new CliError('failed', `${what}: ${(last as Error).message}`);
}

async function s3Fetch(ctx: Ctx, url: string, init: RequestInit, what: string): Promise<Response> {
  const res = await ctx.fetch(url, init);
  // Storage refusing a signed condition: someone wrote in the moment between the orchestrator's check and this PUT.
  if (res.status === 412) throw new CliError('changed', `${what}: it changed since you read it (someone wrote it just now); nothing written`, 412);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
    throw new CliError('failed', `${what}: storage answered HTTP ${res.status}${code ? ` ${code}` : ''}`);
  }
  return res;
}

// ---- ls ----

export async function cmdSpaceLs(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const a = await api(ctx, args);
  if (args.args.length === 0) {
    const spaces = await listSpaces(a);
    if (args.json) { ctx.out(json({ spaces })); return EXIT.OK; }
    if (spaces.length === 0) { ctx.out('No spaces. Create one with `termag space create <name>`.'); return EXIT.OK; }
    ctx.out(table(['SPACE', 'ROLE', 'ACCESS', 'USED'], spaces.map(s => [
      s.name,
      s.readOnly ? `${s.role} (read-only)` : s.role,
      !s.access ? '-' : s.access.kind === 'explicit' ? 'this box' : `via ${s.access.via}`,
      `${formatBytes(s.usedBytes)} of ${formatBytes(s.quotaBytes)}`,
    ])));
    return EXIT.OK;
  }
  const raw = args.args[0];
  const ref = raw.includes(':') ? parseRemote(raw) : SPACE_NAME_RE.test(raw) ? { space: raw, path: '' } : parseRemote(raw);
  const space = await spaceOf(a, ref);
  const dirs: Tree['dirs'] = [];
  const files: TreeFile[] = [];
  let cursor: string | null = null;
  let prefix = '';
  do {
    const q = `prefix=${enc(ref.path)}${cursor ? `&cursor=${enc(cursor)}` : ''}`;
    const page: Tree = await a.request<Tree>('GET', `/spaces/${enc(space)}/tree?${q}`);
    prefix = page.prefix;
    dirs.push(...page.dirs);
    files.push(...page.files);
    cursor = page.nextCursor;
  } while (cursor);
  if (args.json) { ctx.out(json({ space, prefix, dirs, files })); return EXIT.OK; }
  if (dirs.length === 0 && files.length === 0) { ctx.out(`${space}:${prefix} is empty.`); return EXIT.OK; }
  ctx.out(table(['NAME', 'SIZE', 'MODIFIED'], [
    ...dirs.map(d => [`${d.name}/`, '-', '-']),
    ...files.map(f => [f.shared ? `${f.name} (shared)` : f.name, formatBytes(f.size), f.modifiedAt ? f.modifiedAt.slice(0, 16).replace('T', ' ') : '-']),
  ]));
  return EXIT.OK;
}

// ---- get ----

/** Every file under `prefix`, every page; with `recursive: false`, only the files directly in it. */
export async function listAll(a: Api, space: string, prefix: string, opts: { recursive?: boolean } = {}): Promise<TreeFile[]> {
  const files: TreeFile[] = [];
  let cursor: string | null = null;
  const recursive = opts.recursive === false ? '' : 'recursive=1&';
  do {
    const page: Tree = await a.request<Tree>('GET', `/spaces/${enc(space)}/tree?${recursive}prefix=${enc(prefix)}${cursor ? `&cursor=${enc(cursor)}` : ''}`);
    files.push(...page.files);
    cursor = page.nextCursor;
  } while (cursor);
  return files;
}

/**
 * Downloads `space:path` to `dest`; the version it got (an orchestrator from before versions names none).
 * With `keep` (the remote as the user wrote it, for the hint), an existing `dest` is never replaced:
 * it is checked once the remote is known to exist, and again atomically as the download lands.
 */
export async function download(ctx: Ctx, a: Api, space: string, path: string, dest: string, opts: { keep?: string } = {}): Promise<{ size: number; etag: string | null; versionId: string | null }> {
  return withRetry(`download ${space}:${path}`, async () => {
    const { url, size, etag, versionId } = await a.request<{ url: string; size: number; etag?: string; versionId?: string }>('POST', `/spaces/${enc(space)}/files/download`, { path });
    if (opts.keep !== undefined) refuseToClobber([dest], opts.keep);
    const res = await s3Fetch(ctx, url, {}, `download ${space}:${path}`);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.termag-partial`;
    try {
      if (!res.body) throw new Error('empty response');
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(tmp));
      if (opts.keep !== undefined) placeWithoutReplacing(tmp, dest, opts.keep);
      else renameSync(tmp, dest);
    } finally {
      rmSync(tmp, { force: true });
    }
    return { size, etag: etag ?? null, versionId: versionId ?? null };
  });
}

/**
 * Moves `tmp` to `dest` only if nothing is at `dest`, deciding that in the same
 * system call that creates it, so a file another process writes there during the
 * download survives. A hard link is atomic; a filesystem without hard links gets
 * an exclusive-create copy instead.
 */
function placeWithoutReplacing(tmp: string, dest: string, remote: string): void {
  try {
    linkSync(tmp, dest);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') refuseToClobber([dest], remote);
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'EXDEV') throw err;
    try {
      copyFileSync(tmp, dest, fsConstants.COPYFILE_EXCL);
    } catch (copyErr) {
      if ((copyErr as NodeJS.ErrnoException).code === 'EEXIST') refuseToClobber([dest], remote);
      throw copyErr;
    }
  }
}

/** Whether anything is at `path`, a dangling symlink included (which existsSync calls absent). */
function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * With no [dest], `space get` writes into the current directory, which is often
 * a git checkout: replacing a file there that happens to share the name loses
 * work. Only an explicit destination may replace an existing file.
 */
function refuseToClobber(locals: string[], remote: string): void {
  const existing = locals.filter(occupied);
  if (existing.length === 0) return;
  const shown = existing.slice(0, 3).join(', ') + (existing.length > 3 ? ` and ${existing.length - 3} more` : '');
  throw new CliError('conflict',
    `${shown} already exist${existing.length === 1 ? 's' : ''}, and space get with no destination does not replace files. ` +
    `Give a destination: \`termag space get ${remote} <dest>\` (a path outside a git checkout, or the existing path to replace it).`);
}

export async function cmdSpaceGet(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const [rawRemote, rawDest] = args.args;
  if (!rawRemote) throw usage(`Usage: ${SPACE_COMMANDS['space get'].usage}`);
  const a = await api(ctx, args);
  const ref = parseRemote(rawRemote);
  const space = await spaceOf(a, ref);
  const got: Array<{ path: string; local: string; size: number; etag?: string; versionId?: string }> = [];
  let root = '';
  const seen = (v: { size: number; etag: string | null; versionId: string | null }) => ({ size: v.size, ...(v.etag ? { etag: v.etag } : {}), ...(v.versionId ? { versionId: v.versionId } : {}) });

  if (args.options.recursive) {
    const prefix = ref.path === '' || ref.path.endsWith('/') ? ref.path : `${ref.path}/`;
    root = resolve(rawDest ?? (prefix ? basename(prefix.slice(0, -1)) : space));
    const files = await listAll(a, space, prefix);
    if (files.length === 0) throw new CliError('not_found', `Nothing under ${space}:${prefix}`);
    const plan = files.map(f => ({ path: f.path, local: localTarget(root, f.path.slice(prefix.length)) }));
    const keep = rawDest ? undefined : `-r ${rawRemote}`;
    if (keep !== undefined) refuseToClobber(plan.map(p => p.local), keep);
    for (const p of plan) {
      const v = await download(ctx, a, space, p.path, p.local, { keep });
      got.push({ ...p, ...seen(v) });
      if (!args.json) ctx.err(`got ${space}:${p.path} (${formatBytes(v.size)})`);
    }
  } else {
    if (!ref.path || ref.path.endsWith('/')) throw usage('That is a folder; use -r');
    let local = resolve(rawDest ?? basename(ref.path));
    if (rawDest && (rawDest.endsWith('/') || (existsSync(local) && statSync(local).isDirectory()))) local = join(local, basename(ref.path));
    got.push({ path: ref.path, local, ...seen(await download(ctx, a, space, ref.path, local, { keep: rawDest ? undefined : rawRemote })) });
  }
  // What this client read, so a later put of the same path can say so (spaceVersions.ts).
  remembering(ctx, () => rememberVersions(ctx.home, space, got.map(g => ({ path: g.path, etag: g.etag, versionId: g.versionId })), 'get'));
  if (args.json) ctx.out(json({ space, files: got }));
  else if (!args.options.recursive) ctx.out(`${got[0].local} (${formatBytes(got[0].size)})`);
  else ctx.out(`${got.length} files into ${root}`);
  return EXIT.OK;
}

// ---- url ----

export async function cmdSpaceUrl(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const raw = args.args[0];
  if (!raw) throw usage(`Usage: ${SPACE_COMMANDS['space url'].usage}`);
  const ref = parseRemote(raw);
  if (!ref.path || ref.path.endsWith('/')) throw usage('Name a file, not a folder');
  const a = await api(ctx, args);
  const space = await spaceOf(a, ref);
  const r = await a.request<{ url: string; path: string; size: number }>('POST', `/spaces/${enc(space)}/files/link`, { path: ref.path });
  if (args.json) ctx.out(json({ space, path: r.path, url: r.url }));
  else ctx.out(r.url);
  return EXIT.OK;
}

// ---- share, unshare ----

interface ShareView { shared: boolean; sharedAt?: string; sharedBy?: { displayName: string | null; email: string | null } | null }

function fileRef(raw: string | undefined, command: 'space share' | 'space unshare'): RemoteRef {
  if (!raw) throw usage(`Usage: ${SPACE_COMMANDS[command].usage}`);
  const ref = parseRemote(raw);
  if (!ref.path || ref.path.endsWith('/')) throw usage('Name a file, not a folder: only one file is shared at a time');
  return ref;
}

/**
 * Shares one file read-only with everyone signed in to termag;
 * its `termag space url` link then opens for them too. A
 * box shares with its owner's role, as its owner.
 */
export async function cmdSpaceShare(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = fileRef(args.args[0], 'space share');
  const a = await api(ctx, args);
  const space = await spaceOf(a, ref);
  const r = await a.request<ShareView>('PUT', `/spaces/${enc(space)}/files/share`, { path: ref.path });
  if (args.json) ctx.out(json({ space, path: ref.path, ...r }));
  else ctx.out(`${space}:${ref.path} is shared: everyone signed in to termag can open its link (\`termag space url ${space}:${ref.path}\`).`);
  return EXIT.OK;
}

export async function cmdSpaceUnshare(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const ref = fileRef(args.args[0], 'space unshare');
  const a = await api(ctx, args);
  const space = await spaceOf(a, ref);
  const r = await a.request<ShareView>('DELETE', `/spaces/${enc(space)}/files/share?path=${enc(ref.path)}`);
  if (args.json) ctx.out(json({ space, path: ref.path, ...r }));
  else ctx.out(`${space}:${ref.path} is private: only the space's members can open it.`);
  return EXIT.OK;
}

// ---- put ----

function readPart(fd: number, offset: number, length: number): Uint8Array<ArrayBuffer> {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, offset + read);
    if (n === 0) break;
    read += n;
  }
  return read === length ? buf : buf.subarray(0, read);
}

type WriteCondition = { ifMatch: string } | { ifNoneMatch: '*' } | null;

/**
 * Uploads one file, saying which version it replaces (`condition`): the orchestrator refuses a newer one with 412, which is
 * CliError 'changed' (exit 6), and nothing is written. `implicit` marks a
 * condition from the version cache rather than the command line: an
 * orchestrator too old to check it then writes unconditionally, with a
 * warning, where an explicit one refuses.
 */
async function upload(ctx: Ctx, a: Api, space: string, local: string, path: string, quiet: boolean, condition: WriteCondition = null, implicit = false): Promise<{ size: number; etag: string | null; versionId: string | null }> {
  const size = statSync(local).size;
  const base = `/spaces/${enc(space)}`;
  const start = await a.request<(SingleUpload | MultipartUpload) & { conditional?: boolean }>('POST', `${base}/files/upload`, { path, size, contentType: contentTypeFor(local), ...(condition ?? {}) });
  let cond = condition;
  if (cond && start.conditional !== true) {
    if (!implicit) {
      if (start.kind === 'multipart') await a.request('DELETE', `${base}/uploads/${enc(start.uploadId)}?path=${enc(path)}`).catch(() => {});
      throw new CliError('failed', `This orchestrator cannot check versions yet; nothing written to ${space}:${path}. --force writes without the check.`);
    }
    ctx.err(`termag: this orchestrator can't check versions yet; ${space}:${path} is written without the check`);
    cond = null;
  }
  type Written = { size?: number; etag?: string; versionId?: string };
  const done = (w: Written) => ({ size, etag: w.etag ?? null, versionId: w.versionId ?? null });

  if (start.kind === 'single') {
    const put = await withRetry(`upload ${space}:${path}`, async () => {
      const fd = openSync(local, 'r');
      let body: Uint8Array<ArrayBuffer>;
      try { body = readPart(fd, 0, size); } finally { closeSync(fd); }
      return s3Fetch(ctx, start.url, { method: 'PUT', headers: start.headers, body }, `upload ${space}:${path}`);
    });
    // The ETag the PUT answered lets the orchestrator find this write among the versions when it checks again.
    const etag = put.headers.get('etag');
    return done(await a.request<Written>('POST', `${base}/files/uploaded`, { path, ...(cond ?? {}), ...(cond && etag ? { etag } : {}) }));
  }

  const fd = openSync(local, 'r');
  try {
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (let first = 1; first <= start.partCount; first += PART_URL_BATCH) {
      const numbers = Array.from({ length: Math.min(PART_URL_BATCH, start.partCount - first + 1) }, (_, i) => first + i);
      const { parts: urls } = await a.request<{ parts: Array<{ partNumber: number; url: string }> }>(
        'POST', `${base}/uploads/${enc(start.uploadId)}/parts`, { path, size, partNumbers: numbers });
      for (const p of urls) {
        const etag = await withRetry(`upload ${space}:${path} part ${p.partNumber}`, async () => {
          const body = readPart(fd, (p.partNumber - 1) * start.partBytes, start.partBytes);
          const res = await s3Fetch(ctx, p.url, { method: 'PUT', body }, `upload part ${p.partNumber}`);
          const tag = res.headers.get('etag');
          if (!tag) throw new Error('storage returned no ETag (is ETag exposed by CORS?)');
          return tag;
        });
        parts.push({ partNumber: p.partNumber, etag });
        if (!quiet) ctx.err(`  part ${p.partNumber}/${start.partCount}`);
      }
    }
    return done(await a.request<Written>('POST', `${base}/uploads/${enc(start.uploadId)}/complete`, { path, parts, ...(cond ?? {}) }));
  } catch (err) {
    await a.request('DELETE', `${base}/uploads/${enc(start.uploadId)}?path=${enc(path)}`).catch(() => {});
    throw err;
  } finally {
    closeSync(fd);
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * A space's `.termag/` is read by every member's agents:
 * a file going there that looks like it holds a secret is refused before
 * anything is uploaded. The box sync withholds one that gets in another way.
 */
function refuseSecretMemory(local: string, path: string): void {
  if (!path.startsWith('.termag/') || statSync(local).size > 2 * 1024 * 1024) return;
  const refusal = memoryPutRefusal(path, readFileSync(local, 'latin1'));
  if (refusal) throw new CliError('failed', `Refusing to upload: ${refusal}`);
}

/** The condition a write sends: --force none, --if-match / --if-new as given, else the version this client read, if it read one. */
function writeCondition(ctx: Ctx, args: ParsedArgs, space: string, path: string): { condition: WriteCondition; implicit: boolean } {
  if (args.options.force === true) return { condition: null, implicit: false };
  if (typeof args.options['if-match'] === 'string') return { condition: { ifMatch: args.options['if-match'] }, implicit: false };
  if (args.options['if-new'] === true) return { condition: { ifNoneMatch: '*' }, implicit: false };
  const read = versionOf(ctx.home, space, path);
  return { condition: read ? { ifMatch: read.etag } : null, implicit: true };
}

function checkWriteFlags(args: ParsedArgs, many: boolean): void {
  const set = [args.options.force === true, typeof args.options['if-match'] === 'string', args.options['if-new'] === true].filter(Boolean).length;
  if (set > 1) throw usage('Give one of --force, --if-match and --if-new');
  if (many && typeof args.options['if-match'] === 'string') throw usage('--if-match names one file\'s version; with -r each file uses the version you read');
}

export async function cmdSpacePut(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const [rawLocal, rawRemote] = args.args;
  if (!rawLocal || rawRemote === undefined) throw usage(`Usage: ${SPACE_COMMANDS['space put'].usage}`);
  const local = resolve(rawLocal);
  if (!existsSync(local)) throw new CliError('not_found', `No such file: ${rawLocal}`);
  const isDir = lstatSync(local).isDirectory();
  if (isDir && !args.options.recursive) throw usage(`${rawLocal} is a folder; use -r`);
  checkWriteFlags(args, isDir);
  const a = await api(ctx, args);
  const ref = parseRemote(rawRemote);
  const space = await spaceOf(a, ref);
  const put: Array<{ local: string; path: string; size: number; etag?: string }> = [];
  const conflicts: Array<{ path: string; message: string }> = [];

  /** One file: refused versions are collected for a folder, and end the command for one file. */
  const one = async (file: string, path: string, many: boolean) => {
    const { condition, implicit } = writeCondition(ctx, args, space, path);
    try {
      const w = await upload(ctx, a, space, file, path, args.json, condition, implicit);
      // What it wrote is now the version this client knows.
      remembering(ctx, () => rememberVersion(ctx.home, space, path, w.etag, w.versionId, 'put'));
      put.push({ local: file, path, size: w.size, ...(w.etag ? { etag: w.etag } : {}) });
      if (many && !args.json) ctx.err(`put ${space}:${path} (${formatBytes(w.size)})`);
    } catch (err) {
      if (!(err instanceof CliError && err.code === 'changed') || !many) throw err;
      conflicts.push({ path, message: err.message });
      if (!args.json) ctx.err(`refused ${space}:${path}: ${err.message}`);
    }
  };

  if (isDir) {
    const prefix = ref.path === '' ? '' : ref.path.endsWith('/') ? ref.path : `${ref.path}/`;
    const plan = walk(local).map(file => ({ file, path: prefix + relative(local, file).split(sep).join('/') }));
    for (const p of plan) refuseSecretMemory(p.file, p.path);
    for (const { file, path } of plan) await one(file, path, true);
  } else {
    if (!lstatSync(local).isFile()) throw usage(`${rawLocal} is not a regular file`);
    const path = ref.path === '' || ref.path.endsWith('/') ? ref.path + basename(local) : ref.path;
    refuseSecretMemory(local, path);
    await one(local, path, false);
  }
  if (args.json) ctx.out(json({ space, files: put, ...(conflicts.length ? { conflicts } : {}) }));
  else if (!isDir) ctx.out(`${space}:${put[0].path} (${formatBytes(put[0].size)})`);
  else ctx.out(`${put.length} files into ${space}:${ref.path}${conflicts.length ? `; ${conflicts.length} refused, changed since you read them: ${conflicts.map(c => c.path).join(', ')} (put them again with --force to overwrite)` : ''}`);
  return conflicts.length ? EXIT.CHANGED : EXIT.OK;
}

// ---- rm, mv ----

export async function cmdSpaceRm(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  if (!args.args[0]) throw usage(`Usage: ${SPACE_COMMANDS['space rm'].usage}`);
  const a = await api(ctx, args);
  const ref = parseRemote(args.args[0]);
  const space = await spaceOf(a, ref);
  const rec = args.options.recursive === true;
  if (rec && !ref.path) throw usage('Refusing to empty a whole space; name a folder');
  if (!rec && (!ref.path || ref.path.endsWith('/'))) throw usage('That is a folder; use -r');
  // A file this client read is deleted only if it is still that version; a folder's files aren't checked.
  const read = !rec && args.options.force !== true ? versionOf(ctx.home, space, ref.path) : null;
  const r = await a.request<{ ok: boolean; deleted: number; failed: string[] }>(
    'DELETE', `/spaces/${enc(space)}/files?path=${enc(ref.path)}${rec ? '&recursive=1' : ''}${read ? `&ifMatch=${enc(read.etag)}` : ''}`);
  remembering(ctx, () => forgetVersions(ctx.home, space, rec ? (ref.path.endsWith('/') ? ref.path : `${ref.path}/`) : ref.path));
  if (args.json) ctx.out(json({ space, path: ref.path, ...r }));
  else ctx.out(`Deleted ${r.deleted} file${r.deleted === 1 ? '' : 's'} from ${space}:${ref.path}${r.failed.length ? `; failed: ${r.failed.join(', ')}` : ''}`);
  return r.ok ? EXIT.OK : EXIT.FAILED;
}

export async function cmdSpaceMv(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const [rawFrom, rawTo] = args.args;
  if (!rawFrom || !rawTo) throw usage(`Usage: ${SPACE_COMMANDS['space mv'].usage}`);
  const a = await api(ctx, args);
  const from = parseRemote(rawFrom);
  const to = parseRemote(rawTo);
  const space = await spaceOf(a, from);
  if (to.space && to.space !== space) throw usage('mv works inside one space; use get and put to copy between spaces');
  const toPath = from.path.endsWith('/') && to.path && !to.path.endsWith('/') ? `${to.path}/` : to.path;
  // A file this client read moves only if it is still that version; a folder's files aren't checked.
  const isDir = from.path.endsWith('/');
  const read = !isDir && args.options.force !== true ? versionOf(ctx.home, space, from.path) : null;
  const r = await a.request<{ ok: boolean; moved: number; failed: string[] }>('POST', `/spaces/${enc(space)}/files/move`, { from: from.path, to: toPath, ...(read ? { ifMatch: read.etag } : {}) });
  // The copy is a new version this client hasn't read.
  remembering(ctx, () => { forgetVersions(ctx.home, space, from.path); forgetVersions(ctx.home, space, toPath); });
  if (args.json) ctx.out(json({ space, from: from.path, to: toPath, ...r }));
  else ctx.out(`Moved ${r.moved} file${r.moved === 1 ? '' : 's'}: ${space}:${from.path} -> ${space}:${toPath}`);
  return r.ok ? EXIT.OK : EXIT.FAILED;
}

// ---- management ----

export async function cmdSpaceCreate(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const name = args.args[0];
  if (!name) throw usage(`Usage: ${SPACE_COMMANDS['space create'].usage}`);
  const a = await api(ctx, args);
  const description = typeof args.options.description === 'string' ? args.options.description : undefined;
  const { space } = await a.request<{ space: SpaceView }>('POST', '/spaces', { name, description });
  const boxes = `boxes with \`termag space boxes ${space.name} add <box>\``;
  if (args.json) ctx.out(json({ space }));
  else ctx.out(`Created space ${space.name}. Add people with \`termag space members ${space.name} add <email> <role>\`, ${boxes}.`);
  return EXIT.OK;
}

interface MemberView { userId: string; email: string; displayName: string; role: string }

export async function cmdSpaceMembers(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const [space, action, who, role] = args.args;
  if (!space) throw usage(`Usage: ${SPACE_COMMANDS['space members'].usage}`);
  const a = await api(ctx, args);
  const base = `/spaces/${enc(space)}/members`;
  if (!action) {
    const r = await a.request<{ members: MemberView[]; invites: Array<{ id: string; email: string; role: string }> }>('GET', base);
    if (args.json) { ctx.out(json(r)); return EXIT.OK; }
    ctx.out(table(['MEMBER', 'ROLE'], [
      ...r.members.map(m => [m.email, m.role]),
      ...r.invites.map(i => [i.email, `${i.role} (not signed in yet)`]),
    ]));
    return EXIT.OK;
  }
  if (action === 'add') {
    if (!who || !role) throw usage(`Usage: termag space members ${space} add <email> <owner|editor|viewer>`);
    const r = await a.request<{ member?: MemberView; invite?: { email: string; role: string } }>('POST', base, { email: who, role });
    if (args.json) ctx.out(json(r));
    else if (r.member) ctx.out(`${r.member.email} is now ${r.member.role} of ${space}.`);
    else ctx.out(`${who} has not signed in to termag yet; they become ${role} of ${space} at their first sign-in.`);
    return EXIT.OK;
  }
  if (action === 'rm') {
    if (!who) throw usage(`Usage: termag space members ${space} rm <email>`);
    const r = await a.request<{ members: MemberView[]; invites: Array<{ id: string; email: string }> }>('GET', base);
    const member = r.members.find(m => m.email.toLowerCase() === who.toLowerCase());
    const invite = r.invites.find(i => i.email.toLowerCase() === who.toLowerCase());
    if (member) await a.request('DELETE', `${base}/${enc(member.userId)}`);
    else if (invite) await a.request('DELETE', `/spaces/${enc(space)}/invites/${enc(invite.id)}`);
    else throw new CliError('not_found', `${who} is not a member of ${space}`);
    if (args.json) ctx.out(json({ removed: who }));
    else ctx.out(`Removed ${who} from ${space}${member ? ', with their boxes' : ''}.`);
    return EXIT.OK;
  }
  throw usage(`Unknown action ${JSON.stringify(action)}. Usage: ${SPACE_COMMANDS['space members'].usage}`);
}

interface BoxGrantView { id: string; name: string; status: string; ownerEmail: string | null; mine: boolean; children: Array<{ id: string; name: string }> }

export async function cmdSpaceBoxes(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const [space, action, box] = args.args;
  if (!space) throw usage(`Usage: ${SPACE_COMMANDS['space boxes'].usage}`);
  const a = await api(ctx, args);
  const base = `/spaces/${enc(space)}/boxes`;
  if (!action) {
    const { boxes } = await a.request<{ boxes: BoxGrantView[] }>('GET', base);
    if (args.json) { ctx.out(json({ boxes })); return EXIT.OK; }
    if (boxes.length === 0) { ctx.out(`No boxes reach ${space}. Add yours with \`termag space boxes ${space} add <box>\`.`); return EXIT.OK; }
    ctx.out(table(['BOX', 'OWNER', 'STATUS'], boxes.flatMap(b => [
      [b.name, b.ownerEmail ?? '-', b.status],
      ...b.children.map(c => [`  ${c.name} (via ${b.name})`, b.ownerEmail ?? '-', '-']),
    ])));
    return EXIT.OK;
  }
  if (!box) throw usage(`Usage: termag space boxes ${space} ${action} <box>`);
  if (action === 'add') {
    const r = await a.request<{ box: { id: string; name: string } }>('POST', base, { box });
    if (args.json) ctx.out(json(r));
    else ctx.out(`${r.box.name} can now reach ${space}, with your role.`);
    return EXIT.OK;
  }
  if (action === 'rm') {
    const { boxes } = await a.request<{ boxes: BoxGrantView[] }>('GET', base);
    const found = boxes.find(b => b.id === box || b.name === box);
    if (!found) throw new CliError('not_found', `${box} does not reach ${space}`);
    await a.request('DELETE', `${base}/${enc(found.id)}`);
    if (args.json) ctx.out(json({ removed: found.name }));
    else ctx.out(`${found.name} can no longer reach ${space}.`);
    return EXIT.OK;
  }
  throw usage(`Unknown action ${JSON.stringify(action)}. Usage: ${SPACE_COMMANDS['space boxes'].usage}`);
}

export const SPACE_HANDLERS: Record<string, (ctx: Ctx, args: ParsedArgs) => Promise<ExitCode>> = {
  'space ls': cmdSpaceLs,
  'space get': cmdSpaceGet,
  'space url': cmdSpaceUrl,
  'space share': cmdSpaceShare,
  'space unshare': cmdSpaceUnshare,
  'space put': cmdSpacePut,
  'space rm': cmdSpaceRm,
  'space mv': cmdSpaceMv,
  'space create': cmdSpaceCreate,
  'space members': cmdSpaceMembers,
  'space boxes': cmdSpaceBoxes,
  'space slack': cmdSpaceSlack,
};

// `space link` is a file's browser link, not Slack: Slack channels are `space slack link`.
export const SPACE_ALIASES: Record<string, string> = { 'space list': 'space ls', 'space link': 'space url' };
