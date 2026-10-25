import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from './context.js';
import { run } from './main.js';
import { contentTypeFor, formatBytes, localTarget, parseRemote } from './space.js';

/**
 * A stand-in for the orchestrator's /api/cli/v1/spaces routes and for S3
 * behind its presigned URLs, on one server: the CLI never sees the difference
 * between the two other than the URLs it is handed.
 */
interface FakeSpaces {
  host: string;
  spaces: string[];
  /** What the routes answer for the spaces-sharing-enabled flag. */
  sharing: boolean;
  files: Map<string, Buffer>;
  uploads: Map<string, { path: string; size: number; parts: Map<number, Buffer> }>;
  /** Files at or below this size go up as one PUT. */
  singleMax: number;
  partBytes: number;
  /** Fail the first N part PUTs with a 500, to exercise the retry. */
  failParts: number;
  /** Extra paths the recursive listing returns, as a hostile server might. */
  extraPaths: string[];
  calls: string[];
  close: () => Promise<void>;
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

async function startFake(): Promise<FakeSpaces> {
  const fake = {
    host: '',
    close: async () => {},
    spaces: ['team'],
    sharing: true,
    files: new Map(),
    uploads: new Map(),
    singleMax: 16,
    partBytes: 8,
    failParts: 0,
    extraPaths: [],
    calls: [] as string[],
  } satisfies FakeSpaces as FakeSpaces;
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    fake.calls.push(`${req.method} ${p}`);
    const s3 = p.startsWith('/s3/');
    if (!s3 && req.headers.authorization !== 'Bearer tmag_box') { sendJson(res, 401, { error: 'no' }); return; }

    if (p === '/s3/get') {
      const file = fake.files.get(url.searchParams.get('path')!);
      if (!file) { res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>'); return; }
      res.writeHead(200).end(file);
      return;
    }
    if (p === '/s3/put') {
      fake.files.set(url.searchParams.get('path')!, await body(req));
      res.writeHead(200).end();
      return;
    }
    if (p === '/s3/part') {
      const data = await body(req);
      if (fake.failParts > 0) { fake.failParts--; res.writeHead(500).end('<Error><Code>InternalError</Code></Error>'); return; }
      const n = Number(url.searchParams.get('n'));
      fake.uploads.get(url.searchParams.get('upload')!)!.parts.set(n, data);
      res.writeHead(200, { ETag: `"etag-${n}"` }).end();
      return;
    }

    const m = /^\/termag\/api\/cli\/v1\/spaces(?:\/([^/]+)(\/.*)?)?$/.exec(p);
    if (!m) { sendJson(res, 404, { error: 'not found' }); return; }
    const [, rawSpace, rest = ''] = m;
    if (!rawSpace && req.method === 'POST') {
      const { name } = JSON.parse((await body(req)).toString('utf8'));
      fake.spaces.push(name);
      sendJson(res, 201, { space: { id: name, name, description: null, role: 'owner', readOnly: false, usedBytes: 0, quotaBytes: 1024 }, sharing: fake.sharing });
      return;
    }
    if (!rawSpace) {
      sendJson(res, 200, { spaces: fake.spaces.map(name => ({ id: name, name, description: null, role: 'editor', readOnly: false, usedBytes: 0, quotaBytes: 1024, access: { kind: 'explicit' } })) });
      return;
    }
    const space = decodeURIComponent(rawSpace);
    if (!fake.spaces.includes(space)) { sendJson(res, 404, { error: 'No such space', code: 'not_found' }); return; }
    const json = req.method === 'GET' || req.method === 'DELETE' ? {} : JSON.parse((await body(req)).toString('utf8') || '{}');

    if (rest === '/members' && req.method === 'GET') {
      sendJson(res, 200, { sharing: fake.sharing, members: [{ userId: 'u1', email: 'me@example.com', displayName: 'Me', role: 'owner' }], invites: [] });
      return;
    }
    if (rest === '/members' && req.method === 'POST') {
      if (!fake.sharing) { sendJson(res, 403, { error: 'Sharing spaces with other people is not turned on for you yet', code: 'sharing_disabled' }); return; }
      sendJson(res, 201, { member: { userId: 'u2', email: json.email, displayName: 'Them', role: json.role } });
      return;
    }
    if (rest === '/tree') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const recursive = url.searchParams.get('recursive') === '1';
      const under = [...fake.files.keys(), ...fake.extraPaths].filter(k => k.startsWith(prefix)).sort();
      const dirs = new Set<string>();
      const files: Array<{ name: string; path: string; size: number; modifiedAt: string }> = [];
      for (const k of under) {
        const tail = k.slice(prefix.length);
        if (!recursive && tail.includes('/')) { dirs.add(tail.split('/')[0]); continue; }
        files.push({ name: tail.split('/').at(-1)!, path: k, size: fake.files.get(k)?.length ?? 0, modifiedAt: '2026-10-15T10:00:00.000Z' });
      }
      // Two files a page, so the CLI has to follow the cursor.
      const start = Number(url.searchParams.get('cursor') ?? 0);
      const page = files.slice(start, start + 2);
      sendJson(res, 200, {
        prefix,
        dirs: start === 0 ? [...dirs].map(name => ({ name, path: `${prefix}${name}/` })) : [],
        files: page,
        nextCursor: start + 2 < files.length ? String(start + 2) : null,
      });
      return;
    }
    if (rest === '/files/download') {
      const file = fake.files.get(json.path);
      if (!file) { sendJson(res, 404, { error: 'No such file', code: 'not_found' }); return; }
      sendJson(res, 200, { url: `${fake.host}/s3/get?path=${encodeURIComponent(json.path)}`, size: file.length });
      return;
    }
    if (rest === '/files/link') {
      if (!fake.files.has(json.path)) { sendJson(res, 404, { error: 'No such file', code: 'file_not_found' }); return; }
      const encoded = json.path.split('/').map(encodeURIComponent).join('/');
      sendJson(res, 200, { url: `https://ui.example/termag/files/${space}/${encoded}`, path: json.path, size: fake.files.get(json.path)!.length });
      return;
    }
    if (rest === '/files/upload') {
      if (json.size <= fake.singleMax) {
        sendJson(res, 200, { kind: 'single', path: json.path, url: `${fake.host}/s3/put?path=${encodeURIComponent(json.path)}`, method: 'PUT', headers: { 'content-type': json.contentType } });
        return;
      }
      const uploadId = `u${fake.uploads.size + 1}`;
      fake.uploads.set(uploadId, { path: json.path, size: json.size, parts: new Map() });
      sendJson(res, 200, { kind: 'multipart', path: json.path, uploadId, partBytes: fake.partBytes, partCount: Math.ceil(json.size / fake.partBytes) });
      return;
    }
    if (rest === '/files/uploaded') { sendJson(res, 200, { ok: true }); return; }
    const up = /^\/uploads\/([^/]+)(\/parts|\/complete)?$/.exec(rest);
    if (up) {
      const id = decodeURIComponent(up[1]);
      if (up[2] === '/parts') {
        expect(json.size).toBe(fake.uploads.get(id)!.size);
        sendJson(res, 200, { parts: json.partNumbers.map((n: number) => ({ partNumber: n, url: `${fake.host}/s3/part?upload=${id}&n=${n}` })) });
      } else if (up[2] === '/complete') {
        const u = fake.uploads.get(id)!;
        const ordered = [...u.parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
        expect(json.parts.map((x: { etag: string }) => x.etag)).toEqual(ordered.map((_, i) => `"etag-${i + 1}"`));
        fake.files.set(u.path, Buffer.concat(ordered));
        fake.uploads.delete(id);
        sendJson(res, 200, { ok: true });
      } else {
        fake.uploads.delete(id);
        sendJson(res, 200, { ok: true });
      }
      return;
    }
    if (rest === '/files' && req.method === 'DELETE') {
      const path = url.searchParams.get('path')!;
      const keys = url.searchParams.get('recursive') ? [...fake.files.keys()].filter(k => k.startsWith(path)) : fake.files.has(path) ? [path] : [];
      for (const k of keys) fake.files.delete(k);
      sendJson(res, 200, { ok: true, deleted: keys.length, failed: [] });
      return;
    }
    if (rest === '/files/move') {
      const keys = json.from.endsWith('/') ? [...fake.files.keys()].filter(k => k.startsWith(json.from)) : [json.from];
      for (const k of keys) {
        const to = json.from.endsWith('/') ? json.to + k.slice(json.from.length) : json.to;
        fake.files.set(to, fake.files.get(k)!);
        fake.files.delete(k);
      }
      sendJson(res, 200, { ok: true, moved: keys.length, failed: [] });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  fake.host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>(r => server.close(() => r()));
  return fake;
}

let fake: FakeSpaces;
let home: string;
let work: string;
let out: string[];
let err: string[];

function ctx(): Ctx {
  return {
    env: { TERMAG_AGENT_CONFIG: join(home, 'agent.config.json') },
    home,
    hostname: 'devbox',
    interactive: false,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    fetch: globalThis.fetch,
    openBrowser: () => { throw new Error('no browser in these tests'); },
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    loginTimeoutMs: 1000,
  };
}

const termag = (...argv: string[]) => run(argv, ctx());

beforeEach(async () => {
  fake = await startFake();
  home = mkdtempSync(join(tmpdir(), 'termag-space-test-'));
  work = join(home, 'work');
  mkdirSync(work);
  writeFileSync(join(home, 'agent.config.json'), JSON.stringify({ server_url: `${fake.host.replace(/^http/, 'ws')}/termag/ws/agent`, token: 'tmag_box' }));
  out = [];
  err = [];
  process.chdir(work);
});

afterEach(async () => {
  await fake.close();
  process.chdir(tmpdir());
  rmSync(home, { recursive: true, force: true });
});

describe('pure helpers', () => {
  it('parses space:path, and leaves a bare path to the only space', () => {
    expect(parseRemote('team:docs/a.md')).toEqual({ space: 'team', path: 'docs/a.md' });
    expect(parseRemote('team:')).toEqual({ space: 'team', path: '' });
    expect(parseRemote('docs/a.md')).toEqual({ space: null, path: 'docs/a.md' });
    expect(parseRemote('Not A Space:x')).toEqual({ space: null, path: 'Not A Space:x' });
  });

  it('refuses a local target outside the destination', () => {
    expect(localTarget('/tmp/out', 'a/b.txt')).toBe('/tmp/out/a/b.txt');
    expect(() => localTarget('/tmp/out', '../escape')).toThrow(/outside/);
    expect(() => localTarget('/tmp/out', 'a/../../escape')).toThrow(/outside/);
    expect(() => localTarget('/tmp/out', '')).toThrow(/itself/);
  });

  it('formats sizes and guesses content types', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(64 * 1024 * 1024)).toBe('64 MiB');
    expect(contentTypeFor('notes.MD')).toBe('text/markdown');
    expect(contentTypeFor('blob')).toBe('application/octet-stream');
  });
});

describe('termag space', () => {
  it('lists the spaces this box reaches', async () => {
    expect(await termag('space', 'ls')).toBe(0);
    expect(out.join('\n')).toMatch(/team\s+editor\s+this box/);
    out = [];
    expect(await termag('space', 'list', '--json')).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ spaces: [{ name: 'team' }] });
  });

  it('puts and gets one file through a single PUT, naming the space or not', async () => {
    writeFileSync(join(work, 'a.txt'), 'hello');
    expect(await termag('space', 'put', 'a.txt', 'team:notes/')).toBe(0);
    expect(fake.files.get('notes/a.txt')?.toString()).toBe('hello');
    expect(await termag('space', 'get', 'notes/a.txt', 'copy.txt')).toBe(0);
    expect(readFileSync(join(work, 'copy.txt'), 'utf8')).toBe('hello');
    expect(existsSync(join(work, 'copy.txt.termag-partial'))).toBe(false);
  });

  it('uploads a large file in parts, retrying a failed part', async () => {
    const data = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    writeFileSync(join(work, 'big.bin'), data);
    fake.failParts = 1;
    expect(await termag('space', 'put', 'big.bin', 'team:big.bin')).toBe(0);
    expect(fake.files.get('big.bin')).toEqual(data);
    expect(fake.calls.filter(c => c === 'PUT /s3/part')).toHaveLength(Math.ceil(data.length / 8) + 1);
    expect(err.join('\n')).toContain('part 5/5');
  });

  it('copies a folder up and back with -r, following the listing cursor', async () => {
    const src = join(work, 'site');
    mkdirSync(join(src, 'img'), { recursive: true });
    writeFileSync(join(src, 'index.html'), '<p>hi</p>');
    writeFileSync(join(src, 'img', 'a.png'), 'png-a');
    writeFileSync(join(src, 'img', 'b.png'), 'png-b-is-longer-than-sixteen-bytes');
    expect(await termag('space', 'put', '-r', 'site', 'team:www')).toBe(0);
    expect([...fake.files.keys()].sort()).toEqual(['www/img/a.png', 'www/img/b.png', 'www/index.html']);

    expect(await termag('space', 'get', '-r', 'team:www', 'back')).toBe(0);
    expect(readFileSync(join(work, 'back', 'img', 'b.png'), 'utf8')).toBe('png-b-is-longer-than-sixteen-bytes');
    expect(readFileSync(join(work, 'back', 'index.html'), 'utf8')).toBe('<p>hi</p>');

    out = [];
    expect(await termag('space', 'get', '-r', 'team:www')).toBe(0);
    expect(readFileSync(join(work, 'www', 'index.html'), 'utf8')).toBe('<p>hi</p>');
    expect(out.join('\n')).toContain(`3 files into ${join(realpathSync(work), 'www')}`);
  });

  it('refuses a listing entry that would land outside the destination', async () => {
    fake.files.set('www/ok.txt', Buffer.from('ok'));
    fake.extraPaths = ['www/../../escape.txt'];
    expect(await termag('space', 'get', '-r', 'team:www', 'back')).toBe(1);
    expect(err.join('\n')).toContain('outside');
    expect(existsSync(join(home, 'escape.txt'))).toBe(false);
  });

  it('needs -r for a folder, and refuses to empty a whole space', async () => {
    mkdirSync(join(work, 'dir'));
    expect(await termag('space', 'put', 'dir', 'team:dir')).toBe(2);
    expect(await termag('space', 'rm', '-r', 'team:')).toBe(2);
    expect(await termag('space', 'rm', 'team:dir/')).toBe(2);
  });

  it('moves and removes', async () => {
    fake.files.set('a/1.txt', Buffer.from('1'));
    fake.files.set('a/2.txt', Buffer.from('2'));
    expect(await termag('space', 'mv', 'team:a/', 'team:b')).toBe(0);
    expect([...fake.files.keys()].sort()).toEqual(['b/1.txt', 'b/2.txt']);
    expect(out.join('\n')).toContain('Moved 2 files');
    expect(await termag('space', 'rm', '-r', 'team:b/')).toBe(0);
    expect(fake.files.size).toBe(0);
  });

  it('asks for the space when the caller reaches more than one', async () => {
    fake.spaces = ['team', 'other'];
    expect(await termag('space', 'get', 'a.txt')).toBe(2);
    expect(err.join('\n')).toContain('team, other');
  });

  it('leaves people out of create and members while sharing is off', async () => {
    fake.sharing = false;
    expect(await termag('space', 'create', 'solo')).toBe(0);
    expect(out.join('\n')).not.toContain('Add people');
    expect(out.join('\n')).toContain('termag space boxes solo add <box>');
    out = [];
    expect(await termag('space', 'members', 'team')).toBe(0);
    expect(out.join('\n')).toContain('not turned on for you yet');
    expect(await termag('space', 'members', 'team', 'add', 'them@example.com', 'viewer')).not.toBe(0);
    expect(err.join('\n')).toContain('not turned on for you yet');

    fake.sharing = true;
    out = [];
    expect(await termag('space', 'create', 'shared')).toBe(0);
    expect(out.join('\n')).toContain('Add people with');
  });

  it('prints a file\'s browser link', async () => {
    fake.files.set('docs/My Report.pdf', Buffer.from('pdf'));
    expect(await termag('space', 'url', 'team:docs/My Report.pdf')).toBe(0);
    expect(out).toEqual(['https://ui.example/termag/files/team/docs/My%20Report.pdf']);
    out = [];
    expect(await termag('space', 'link', 'docs/My Report.pdf', '--json')).toBe(0);
    expect(JSON.parse(out.join(''))).toEqual({ space: 'team', path: 'docs/My Report.pdf', url: 'https://ui.example/termag/files/team/docs/My%20Report.pdf' });
    expect(await termag('space', 'url', 'team:nope.pdf')).toBe(3);
    expect(await termag('space', 'url', 'team:docs/')).toBe(2);
  });

  it('reports a missing file as not found (exit 3)', async () => {
    expect(await termag('space', 'get', 'team:nope.txt')).toBe(3);
  });
});
