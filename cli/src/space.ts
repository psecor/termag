import { createWriteStream, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, closeSync, renameSync, rmSync, statSync } from 'node:fs';
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
const SPACE_NAME_RE = /^[a-z0-9-]{2,40}$/;

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
  'space put': {
    summary: 'Upload a file, or a folder with -r',
    usage: 'termag space put <local> <space:path> [-r]',
    options: { recursive },
    maxArgs: 2,
  },
  'space rm': {
    summary: 'Delete a file, or a folder with -r (old versions are kept)',
    usage: 'termag space rm <space:path> [-r]',
    options: { recursive },
    maxArgs: 1,
  },
  'space mv': {
    summary: 'Move or rename a file or folder (folders end in /)',
    usage: 'termag space mv <space:from> <space:to>',
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

interface TreeFile { name: string; path: string; size: number; modifiedAt: string | null }
interface Tree { prefix: string; dirs: Array<{ name: string; path: string }>; files: TreeFile[]; nextCursor: string | null }

type SingleUpload = { kind: 'single'; path: string; url: string; method: 'PUT'; headers: Record<string, string> };
type MultipartUpload = { kind: 'multipart'; path: string; uploadId: string; partBytes: number; partCount: number };

export interface RemoteRef { space: string | null; path: string }

/** `space:path`, or a bare path when the space is left out. */
export function parseRemote(raw: string): RemoteRef {
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

async function api(ctx: Ctx, args: ParsedArgs): Promise<Api> {
  return authedApi(ctx, session(ctx, args), { timeoutMs: SPACE_TIMEOUT_MS });
}

async function listSpaces(a: Api): Promise<SpaceView[]> {
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
    ...files.map(f => [f.name, formatBytes(f.size), f.modifiedAt ? f.modifiedAt.slice(0, 16).replace('T', ' ') : '-']),
  ]));
  return EXIT.OK;
}

// ---- get ----

async function listAll(a: Api, space: string, prefix: string): Promise<TreeFile[]> {
  const files: TreeFile[] = [];
  let cursor: string | null = null;
  do {
    const page: Tree = await a.request<Tree>('GET', `/spaces/${enc(space)}/tree?recursive=1&prefix=${enc(prefix)}${cursor ? `&cursor=${enc(cursor)}` : ''}`);
    files.push(...page.files);
    cursor = page.nextCursor;
  } while (cursor);
  return files;
}

async function download(ctx: Ctx, a: Api, space: string, path: string, dest: string): Promise<number> {
  return withRetry(`download ${space}:${path}`, async () => {
    const { url, size } = await a.request<{ url: string; size: number }>('POST', `/spaces/${enc(space)}/files/download`, { path });
    const res = await s3Fetch(ctx, url, {}, `download ${space}:${path}`);
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = `${dest}.termag-partial`;
    try {
      if (!res.body) throw new Error('empty response');
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(tmp));
      renameSync(tmp, dest);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
    return size;
  });
}

export async function cmdSpaceGet(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const [rawRemote, rawDest] = args.args;
  if (!rawRemote) throw usage(`Usage: ${SPACE_COMMANDS['space get'].usage}`);
  const a = await api(ctx, args);
  const ref = parseRemote(rawRemote);
  const space = await spaceOf(a, ref);
  const got: Array<{ path: string; local: string; size: number }> = [];
  let root = '';

  if (args.options.recursive) {
    const prefix = ref.path === '' || ref.path.endsWith('/') ? ref.path : `${ref.path}/`;
    root = resolve(rawDest ?? (prefix ? basename(prefix.slice(0, -1)) : space));
    const files = await listAll(a, space, prefix);
    if (files.length === 0) throw new CliError('not_found', `Nothing under ${space}:${prefix}`);
    const plan = files.map(f => ({ path: f.path, local: localTarget(root, f.path.slice(prefix.length)) }));
    for (const p of plan) {
      const size = await download(ctx, a, space, p.path, p.local);
      got.push({ ...p, size });
      if (!args.json) ctx.err(`got ${space}:${p.path} (${formatBytes(size)})`);
    }
  } else {
    if (!ref.path || ref.path.endsWith('/')) throw usage('That is a folder; use -r');
    let local = resolve(rawDest ?? basename(ref.path));
    if (rawDest && (rawDest.endsWith('/') || (existsSync(local) && statSync(local).isDirectory()))) local = join(local, basename(ref.path));
    const size = await download(ctx, a, space, ref.path, local);
    got.push({ path: ref.path, local, size });
  }
  if (args.json) ctx.out(json({ space, files: got }));
  else if (!args.options.recursive) ctx.out(`${got[0].local} (${formatBytes(got[0].size)})`);
  else ctx.out(`${got.length} files into ${root}`);
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

async function upload(ctx: Ctx, a: Api, space: string, local: string, path: string, quiet: boolean): Promise<number> {
  const size = statSync(local).size;
  const base = `/spaces/${enc(space)}`;
  const start = await a.request<SingleUpload | MultipartUpload>('POST', `${base}/files/upload`, { path, size, contentType: contentTypeFor(local) });

  if (start.kind === 'single') {
    await withRetry(`upload ${space}:${path}`, async () => {
      const fd = openSync(local, 'r');
      let body: Uint8Array<ArrayBuffer>;
      try { body = readPart(fd, 0, size); } finally { closeSync(fd); }
      await s3Fetch(ctx, start.url, { method: 'PUT', headers: start.headers, body }, `upload ${space}:${path}`);
    });
    await a.request('POST', `${base}/files/uploaded`, { path });
    return size;
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
    await a.request('POST', `${base}/uploads/${enc(start.uploadId)}/complete`, { path, parts });
    return size;
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

export async function cmdSpacePut(ctx: Ctx, args: ParsedArgs): Promise<ExitCode> {
  const [rawLocal, rawRemote] = args.args;
  if (!rawLocal || rawRemote === undefined) throw usage(`Usage: ${SPACE_COMMANDS['space put'].usage}`);
  const local = resolve(rawLocal);
  if (!existsSync(local)) throw new CliError('not_found', `No such file: ${rawLocal}`);
  const isDir = lstatSync(local).isDirectory();
  if (isDir && !args.options.recursive) throw usage(`${rawLocal} is a folder; use -r`);
  const a = await api(ctx, args);
  const ref = parseRemote(rawRemote);
  const space = await spaceOf(a, ref);
  const put: Array<{ local: string; path: string; size: number }> = [];

  if (isDir) {
    const prefix = ref.path === '' ? '' : ref.path.endsWith('/') ? ref.path : `${ref.path}/`;
    for (const file of walk(local)) {
      const path = prefix + relative(local, file).split(sep).join('/');
      const size = await upload(ctx, a, space, file, path, args.json);
      put.push({ local: file, path, size });
      if (!args.json) ctx.err(`put ${space}:${path} (${formatBytes(size)})`);
    }
  } else {
    if (!lstatSync(local).isFile()) throw usage(`${rawLocal} is not a regular file`);
    const path = ref.path === '' || ref.path.endsWith('/') ? ref.path + basename(local) : ref.path;
    put.push({ local, path, size: await upload(ctx, a, space, local, path, args.json) });
  }
  if (args.json) ctx.out(json({ space, files: put }));
  else if (!isDir) ctx.out(`${space}:${put[0].path} (${formatBytes(put[0].size)})`);
  else ctx.out(`${put.length} files into ${space}:${ref.path}`);
  return EXIT.OK;
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
  const r = await a.request<{ ok: boolean; deleted: number; failed: string[] }>(
    'DELETE', `/spaces/${enc(space)}/files?path=${enc(ref.path)}${rec ? '&recursive=1' : ''}`);
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
  const r = await a.request<{ ok: boolean; moved: number; failed: string[] }>('POST', `/spaces/${enc(space)}/files/move`, { from: from.path, to: toPath });
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
  const { space, sharing } = await a.request<{ space: SpaceView; sharing?: boolean }>('POST', '/spaces', { name, description });
  const boxes = `boxes with \`termag space boxes ${space.name} add <box>\``;
  if (args.json) ctx.out(json({ space }));
  else if (sharing === false) ctx.out(`Created space ${space.name}. Add your ${boxes}.`);
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
    const r = await a.request<{ sharing?: boolean; members: MemberView[]; invites: Array<{ id: string; email: string; role: string }> }>('GET', base);
    if (args.json) { ctx.out(json(r)); return EXIT.OK; }
    ctx.out(table(['MEMBER', 'ROLE'], [
      ...r.members.map(m => [m.email, m.role]),
      ...r.invites.map(i => [i.email, `${i.role} (not signed in yet)`]),
    ]));
    if (r.sharing === false) ctx.out('Sharing spaces with other people is not turned on for you yet.');
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
  'space put': cmdSpacePut,
  'space rm': cmdSpaceRm,
  'space mv': cmdSpaceMv,
  'space create': cmdSpaceCreate,
  'space members': cmdSpaceMembers,
  'space boxes': cmdSpaceBoxes,
};

export const SPACE_ALIASES: Record<string, string> = { 'space list': 'space ls' };
