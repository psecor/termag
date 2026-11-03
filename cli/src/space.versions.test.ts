import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from './context.js';
import { run } from './main.js';
import { versionOf, versionsPath } from './spaceVersions.js';

/**
 * Optimistic concurrency on every space write:
 * a fake orchestrator that checks a write's version before signing (412
 * `changed`, naming who wrote it and when) and an S3 that honours If-Match
 * and If-None-Match, as the real ones do.
 */
interface Fake {
  host: string;
  files: Map<string, { body: Buffer; etag: string; versionId: string; by: string; at: string }>;
  /** An orchestrator from before versions: it ignores conditions and never says `conditional`. */
  old: boolean;
  /** What each request carried, for checking what the CLI sent. */
  sent: Array<{ route: string; body: Record<string, unknown> }>;
  close: () => Promise<void>;
}

const etagOf = (b: Buffer) => `"${createHash('md5').update(b).digest('hex')}"`;

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
const send = (res: ServerResponse, status: number, v: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));

async function startFake(): Promise<Fake> {
  let seq = 0;
  const fake: Fake = { host: '', files: new Map(), old: false, sent: [], close: async () => {} };
  const store = (path: string, data: Buffer, by: string) => fake.files.set(path, { body: data, etag: etagOf(data), versionId: `v${++seq}`, by, at: new Date(Date.UTC(2026, 9, 27, 10, seq)).toISOString() });
  /** What the orchestrator's precheck answers: null to go on, or the 412 body. */
  const refuse = (path: string, c: Record<string, unknown>) => {
    if (fake.old) return null;
    const cur = fake.files.get(path);
    if (c.ifNoneMatch === '*' && cur) return { error: `team:${path} already exists (now ${cur.etag} by ${cur.by} at ${cur.at})`, code: 'changed', now: cur.etag, by: cur.by, at: cur.at };
    if (typeof c.ifMatch === 'string' && (!cur || cur.etag !== c.ifMatch)) {
      return { error: `team:${path} changed since you read it (yours ${c.ifMatch}, now ${cur?.etag ?? 'gone'}${cur ? ` by ${cur.by} at ${cur.at}` : ''})`, code: 'changed', now: cur?.etag ?? null, by: cur?.by, at: cur?.at };
    }
    return null;
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    const who = req.headers.authorization === 'Bearer tmag_bob' ? 'bob@example.com' : 'alice@example.com';
    if (p === '/s3/get') { res.writeHead(200).end(fake.files.get(url.searchParams.get('path')!)!.body); return; }
    if (p === '/s3/put') {
      const path = url.searchParams.get('path')!;
      const data = await body(req);
      const cur = fake.files.get(path);
      if (!fake.old && req.headers['if-none-match'] === '*' && cur) { res.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>'); return; }
      if (!fake.old && req.headers['if-match'] && cur?.etag !== req.headers['if-match']) { res.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>'); return; }
      store(path, data, url.searchParams.get('by')!);
      res.writeHead(200, { ETag: fake.files.get(path)!.etag }).end();
      return;
    }
    const m = /^\/termag\/api\/cli\/v1\/spaces(?:\/([^/]+)(\/.*)?)?$/.exec(p);
    if (!m) { send(res, 404, { error: 'not found' }); return; }
    const [, rawSpace, rest = ''] = m;
    if (!rawSpace) { send(res, 200, { spaces: [{ id: 'team', name: 'team', description: null, role: 'editor', readOnly: false, usedBytes: 0, quotaBytes: 1 << 30, access: { kind: 'explicit' } }] }); return; }
    const json = req.method === 'POST' ? JSON.parse((await body(req)).toString('utf8') || '{}') : Object.fromEntries(url.searchParams);
    fake.sent.push({ route: `${req.method} ${rest}`, body: json });
    if (rest === '/tree') {
      const files = [...fake.files].map(([path, f]) => ({ name: path.split('/').at(-1), path, size: f.body.length, modifiedAt: f.at, etag: f.etag }));
      send(res, 200, { prefix: '', dirs: [], files, nextCursor: null });
      return;
    }
    if (rest === '/files/download') {
      const f = fake.files.get(json.path);
      if (!f) { send(res, 404, { error: 'No such file', code: 'file_not_found' }); return; }
      send(res, 200, { url: `${fake.host}/s3/get?path=${encodeURIComponent(json.path)}`, size: f.body.length, ...(fake.old ? {} : { etag: f.etag, versionId: f.versionId }) });
      return;
    }
    if (rest === '/files/upload') {
      const no = refuse(json.path, json);
      if (no) { send(res, 412, no); return; }
      const cond = json.ifMatch ? { 'if-match': json.ifMatch } : json.ifNoneMatch ? { 'if-none-match': '*' } : {};
      send(res, 200, {
        kind: 'single', path: json.path, url: `${fake.host}/s3/put?path=${encodeURIComponent(json.path)}&by=${encodeURIComponent(who)}`, method: 'PUT',
        headers: { 'content-type': json.contentType, ...(fake.old ? {} : cond) }, ...(!fake.old && Object.keys(cond).length ? { conditional: true } : {}),
      });
      return;
    }
    if (rest === '/files/uploaded') { const f = fake.files.get(json.path)!; send(res, 200, { ok: true, path: json.path, size: f.body.length, ...(fake.old ? {} : { etag: f.etag, versionId: f.versionId }) }); return; }
    if (rest === '/files/move') {
      const no = json.ifMatch ? refuse(json.from, { ifMatch: json.ifMatch }) : null;
      if (no) { send(res, 412, no); return; }
      fake.files.set(json.to, { ...fake.files.get(json.from)!, versionId: `v${++seq}` });
      fake.files.delete(json.from);
      send(res, 200, { ok: true, moved: 1, failed: [] });
      return;
    }
    if (rest === '/files' && req.method === 'DELETE') {
      const path = url.searchParams.get('path')!;
      const no = url.searchParams.get('ifMatch') ? refuse(path, { ifMatch: url.searchParams.get('ifMatch') }) : null;
      if (no) { send(res, 412, no); return; }
      const keys = url.searchParams.get('recursive') ? [...fake.files.keys()].filter(k => k.startsWith(path)) : [path];
      for (const k of keys) fake.files.delete(k);
      send(res, 200, { ok: true, deleted: keys.length, failed: [] });
      return;
    }
    send(res, 404, { error: 'not found' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  fake.host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>(r => server.close(() => r()));
  return fake;
}

let fake: Fake;
let root: string;
let out: string[];
let err: string[];

/** A user on a box: their own home, token and version cache. */
function person(name: 'alice' | 'bob') {
  const home = join(root, name);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'agent.config.json'), JSON.stringify({ server_url: `${fake.host.replace(/^http/, 'ws')}/termag/ws/agent`, token: `tmag_${name}` }));
  const ctx = (): Ctx => ({
    env: { TERMAG_AGENT_CONFIG: join(home, 'agent.config.json') }, home, hostname: 'devbox', interactive: false,
    out: t => out.push(t), err: t => err.push(t), fetch: globalThis.fetch,
    openBrowser: () => { throw new Error('no browser'); },
    readFile: p => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
  });
  const file = (rel: string, text: string) => { const p = join(home, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); return p; };
  return { home, termag: (...argv: string[]) => run(argv, ctx()), file };
}

const remote = (path: string) => fake.files.get(path)?.body.toString();

beforeEach(async () => {
  fake = await startFake();
  root = mkdtempSync(join(tmpdir(), 'termag-versions-test-'));
  out = [];
  err = [];
});
afterEach(async () => {
  await fake.close();
  rmSync(root, { recursive: true, force: true });
});

describe('space get remembers the version it read', () => {
  it('reports it in --json and keeps it per space and path', async () => {
    const alice = person('alice');
    await alice.termag('space', 'put', alice.file('a.md', 'one'), 'team:notes/a.md');
    expect(await alice.termag('space', 'get', 'team:notes/a.md', join(alice.home, 'got.md'), '--json')).toBe(0);
    const got = JSON.parse(out.at(-1)!).files[0];
    expect(got).toEqual(expect.objectContaining({ path: 'notes/a.md', etag: fake.files.get('notes/a.md')!.etag, versionId: fake.files.get('notes/a.md')!.versionId }));
    expect(versionsPath(alice.home, 'team')).toBe(join(alice.home, '.termag', 'spaces', '.versions', 'team.json'));
    expect(versionOf(alice.home, 'team', 'notes/a.md')).toEqual(expect.objectContaining({ etag: got.etag, via: 'get' }));
  });
});

describe('space put checks the version it read', () => {
  it('two writers: the second put is refused with exit 6 and the message, nothing written; --force overwrites', async () => {
    const alice = person('alice');
    const bob = person('bob');
    await alice.termag('space', 'put', alice.file('a.md', 'v1'), 'team:a.md');
    await bob.termag('space', 'get', 'team:a.md', join(bob.home, 'a.md'));
    await alice.termag('space', 'get', 'team:a.md', join(alice.home, 'mine.md'));
    expect(await bob.termag('space', 'put', bob.file('b.md', 'bob was here'), 'team:a.md')).toBe(0);

    err = [];
    expect(await alice.termag('space', 'put', alice.file('mine.md', 'alice edit'), 'team:a.md')).toBe(6);
    expect(err.join('\n')).toMatch(/team:a\.md changed since you read it \(yours "[0-9a-f]{32}", now "[0-9a-f]{32}" by bob@example\.com at 2026-10-27T/);
    expect(remote('a.md')).toBe('bob was here');

    expect(await alice.termag('space', 'put', join(alice.home, 'mine.md'), 'team:a.md', '--force')).toBe(0);
    expect(remote('a.md')).toBe('alice edit');
    // What it wrote is now the version she knows: her next put goes through.
    expect(await alice.termag('space', 'put', alice.file('mine.md', 'alice again'), 'team:a.md')).toBe(0);
    expect(fake.sent.filter(s => s.route === 'POST /files/upload').at(-1)!.body.ifMatch).toEqual(expect.any(String));
  });

  it('a first put of a path this client never read is unconditional, as before', async () => {
    const alice = person('alice');
    const bob = person('bob');
    await bob.termag('space', 'put', bob.file('a.md', 'bob'), 'team:a.md');
    expect(await alice.termag('space', 'put', alice.file('a.md', 'alice'), 'team:a.md')).toBe(0);
    const upload = fake.sent.filter(s => s.route === 'POST /files/upload').at(-1)!.body;
    expect(upload.ifMatch).toBeUndefined();
    expect(upload.ifNoneMatch).toBeUndefined();
  });

  it('--if-new must not exist yet; --if-match names a version', async () => {
    const alice = person('alice');
    expect(await alice.termag('space', 'put', alice.file('n.md', 'x'), 'team:n.md', '--if-new')).toBe(0);
    expect(await alice.termag('space', 'put', alice.file('n.md', 'y'), 'team:n.md', '--if-new')).toBe(6);
    expect(err.join('\n')).toContain('team:n.md already exists');
    expect(remote('n.md')).toBe('x');
    expect(await alice.termag('space', 'put', alice.file('n.md', 'z'), 'team:n.md', '--if-match', '"0123456789abcdef0123456789abcdef"')).toBe(6);
    expect(await alice.termag('space', 'put', alice.file('n.md', 'z'), 'team:n.md', '--if-match', fake.files.get('n.md')!.etag)).toBe(0);
    expect(remote('n.md')).toBe('z');
    expect(await alice.termag('space', 'put', alice.file('n.md', 'z'), 'team:n.md', '--if-new', '--force')).toBe(2);
  });

  it('put -r checks each file, writes the rest, names the refused ones and exits 6', async () => {
    const alice = person('alice');
    const bob = person('bob');
    alice.file('dir/a.md', 'a1');
    alice.file('dir/b.md', 'b1');
    await alice.termag('space', 'put', join(alice.home, 'dir'), 'team:dir/', '-r');
    await alice.termag('space', 'get', 'team:dir/', join(alice.home, 'pulled'), '-r');
    await bob.termag('space', 'put', bob.file('b.md', 'bob b'), 'team:dir/b.md');
    alice.file('dir/a.md', 'a2');
    alice.file('dir/b.md', 'b2');
    out = [];
    err = [];
    expect(await alice.termag('space', 'put', join(alice.home, 'dir'), 'team:dir/', '-r')).toBe(6);
    expect(remote('dir/a.md')).toBe('a2');
    expect(remote('dir/b.md')).toBe('bob b');
    expect(err.join('\n')).toMatch(/refused team:dir\/b\.md: team:dir\/b\.md changed since you read it/);
    expect(out.at(-1)).toContain('1 refused, changed since you read them: dir/b.md');
    expect(await alice.termag('space', 'put', join(alice.home, 'dir'), 'team:dir/', '-r', '--json')).toBe(6);
    expect(JSON.parse(out.at(-1)!).conflicts).toEqual([expect.objectContaining({ path: 'dir/b.md' })]);
  });

  it('an orchestrator from before versions: a remembered version writes with a warning, an explicit one refuses', async () => {
    const alice = person('alice');
    await alice.termag('space', 'put', alice.file('a.md', 'one'), 'team:a.md');
    fake.old = true;
    await alice.termag('space', 'put', alice.file('a.md', 'two'), 'team:a.md', '--if-match', fake.files.get('a.md')!.etag);
    expect(err.join('\n')).toContain('cannot check versions yet; nothing written');
    expect(remote('a.md')).toBe('one');
    expect(await alice.termag('space', 'put', alice.file('a.md', 'three'), 'team:a.md')).toBe(0);
    expect(err.join('\n')).toContain('is written without the check');
    expect(remote('a.md')).toBe('three');
  });
});

describe('space mv and rm check a file this client read', () => {
  it('refuses to move or remove a file changed since; --force does it', async () => {
    const alice = person('alice');
    const bob = person('bob');
    await alice.termag('space', 'put', alice.file('a.md', 'one'), 'team:a.md');
    await bob.termag('space', 'put', bob.file('a.md', 'bob'), 'team:a.md');
    expect(await alice.termag('space', 'mv', 'team:a.md', 'team:b.md')).toBe(6);
    expect(fake.files.has('b.md')).toBe(false);
    expect(await alice.termag('space', 'rm', 'team:a.md')).toBe(6);
    expect(fake.files.has('a.md')).toBe(true);
    expect(await alice.termag('space', 'mv', 'team:a.md', 'team:b.md', '--force')).toBe(0);
    expect(versionOf(alice.home, 'team', 'a.md')).toBeNull();
    expect(await alice.termag('space', 'rm', 'team:b.md')).toBe(0);
  });

  it('a folder move or delete sends no version: it can\'t be checked file by file', async () => {
    const alice = person('alice');
    await alice.termag('space', 'put', alice.file('d/a.md', 'x'), 'team:d/a.md');
    expect(await alice.termag('space', 'rm', 'team:d/', '-r')).toBe(0);
    expect(fake.sent.filter(s => s.route === 'DELETE /files').at(-1)!.body.ifMatch).toBeUndefined();
    expect(versionOf(alice.home, 'team', 'd/a.md')).toBeNull();
    expect(existsSync(versionsPath(alice.home, 'team'))).toBe(true);
  });
});

describe('a delete or a move forgets the versions it removes (Bugbot sweep 14, #770)', () => {
  it('a path removed with space rm, or moved away, is written again without a stale version', async () => {
    const alice = person('alice');
    await alice.termag('space', 'put', alice.file('a.md', 'one'), 'team:a.md');
    await alice.termag('space', 'put', alice.file('d/x.md', 'x'), 'team:d/x.md');
    await alice.termag('space', 'put', alice.file('c.md', 'c'), 'team:c.md');
    expect(await alice.termag('space', 'rm', 'team:a.md')).toBe(0);
    expect(await alice.termag('space', 'rm', 'team:d/', '-r')).toBe(0);
    expect(await alice.termag('space', 'mv', 'team:c.md', 'team:e.md')).toBe(0);
    for (const [local, remote] of [['a.md', 'team:a.md'], ['d/x.md', 'team:d/x.md'], ['c.md', 'team:c.md']]) {
      expect(await alice.termag('space', 'put', join(alice.home, local), remote), remote).toBe(0);
    }
    for (const p of ['a.md', 'd/x.md', 'c.md']) expect(versionOf(alice.home, 'team', p)?.via).toBe('put');
  });
});
