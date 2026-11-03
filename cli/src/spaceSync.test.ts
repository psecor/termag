import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from './context.js';
import { run } from './main.js';
import { SYNC_LIMITS, mirrorsDir, planMirror } from './spaceSync.js';
import { versionOf } from './spaceVersions.js';

/** The orchestrator's spaces list, tree and download routes, and S3 behind the presigned GETs. */
interface Fake {
  host: string;
  /** space → path → bytes */
  files: Map<string, Map<string, Buffer>>;
  spaces: Array<{ name: string; access?: { kind: 'explicit' } | { kind: 'inherited'; via: string } }>;
  downloads: string[];
  /** The next download waits for this; `held` resolves once one is waiting. */
  hold: { release: Promise<void>; held: () => void } | null;
  close: () => Promise<void>;
}

const etagOf = (b: Buffer) => `"${createHash('md5').update(b).digest('hex')}"`;

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
}

async function startFake(): Promise<Fake> {
  const fake: Fake = { host: '', files: new Map(), spaces: [], downloads: [], hold: null, close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/s3/get') {
      const f = fake.files.get(url.searchParams.get('space')!)?.get(url.searchParams.get('path')!);
      if (!f) { res.writeHead(404).end(); return; }
      res.writeHead(200).end(f);
      return;
    }
    if (req.headers.authorization !== 'Bearer tmag_box') { sendJson(res, 401, { error: 'no' }); return; }
    const m = /^\/termag\/api\/cli\/v1\/spaces(?:\/([^/]+)(\/.*)?)?$/.exec(url.pathname);
    if (!m) { sendJson(res, 404, { error: 'not found' }); return; }
    const [, rawSpace, rest = ''] = m;
    if (!rawSpace) {
      sendJson(res, 200, { spaces: fake.spaces.map(s => ({ id: s.name, name: s.name, description: null, role: 'editor', readOnly: false, usedBytes: 0, quotaBytes: 1 << 30, access: s.access })) });
      return;
    }
    const space = decodeURIComponent(rawSpace);
    const files = fake.files.get(space) ?? new Map<string, Buffer>();
    if (rest === '/tree') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const listed = [...files.keys()].filter(k => k.startsWith(prefix)).sort()
        .map(k => ({ name: k.split('/').at(-1)!, path: k, size: files.get(k)!.length, modifiedAt: '2026-10-29T09:00:00.000Z', etag: etagOf(files.get(k)!) }));
      sendJson(res, 200, { prefix, dirs: [], files: listed, nextCursor: null });
      return;
    }
    if (rest === '/files/download') {
      const { path } = JSON.parse((await body(req)).toString('utf8'));
      if (!files.has(path)) { sendJson(res, 404, { error: 'No such file', code: 'file_not_found' }); return; }
      const hold = fake.hold;
      fake.hold = null;
      if (hold) { hold.held(); await hold.release; }
      fake.downloads.push(`${space}:${path}`);
      sendJson(res, 200, { url: `${fake.host}/s3/get?space=${space}&path=${encodeURIComponent(path)}`, size: files.get(path)!.length, etag: etagOf(files.get(path)!) });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  fake.host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>(r => server.close(() => r()));
  return fake;
}

let fake: Fake;
let home: string;
let out: string[];
let err: string[];

function ctx(): Ctx {
  return {
    env: { TERMAG_AGENT_CONFIG: join(home, 'agent.config.json') }, home, hostname: 'devbox', interactive: false,
    out: t => out.push(t), err: t => err.push(t), fetch: globalThis.fetch,
    openBrowser: () => { throw new Error('no browser'); },
    readFile: p => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    readStdin: async () => '',
  };
}
const termag = (...argv: string[]) => run(argv, ctx());
const put = (space: string, path: string, text: string) => {
  if (!fake.files.has(space)) fake.files.set(space, new Map());
  fake.files.get(space)!.set(path, Buffer.from(text));
};
const copy = (space: string, ...rel: string[]) => join(mirrorsDir(home), space, ...rel);
const lastJson = () => JSON.parse(out.at(-1)!);

beforeEach(async () => {
  fake = await startFake();
  home = mkdtempSync(join(tmpdir(), 'termag-space-sync-test-'));
  writeFileSync(join(home, 'agent.config.json'), JSON.stringify({ server_url: `${fake.host.replace(/^http/, 'ws')}/termag/ws/agent`, token: 'tmag_box' }));
  out = [];
  err = [];
  fake.spaces = [{ name: 'team', access: { kind: 'explicit' } }, { name: 'other', access: { kind: 'inherited', via: 'parent-box' } }];
  put('team', 'status.md', '# Status\n');
  put('team', 'plans/ask-direct-push.md', '# Plan\n');
  put('team', '.termag/memory/bugbot.md', 'memory\n');
  put('other', 'notes.txt', 'hi\n');
});

afterEach(async () => {
  await fake.close();
  // The copy is read-only on purpose; make it removable.
  execFileSync('chmod', ['-R', 'u+w', home]);
  rmSync(home, { recursive: true, force: true });
});

describe('planMirror', () => {
  it('copies by path and skips what is over a cap, saying why', () => {
    const big = { name: 'big.bin', path: 'a/big.bin', size: SYNC_LIMITS.fileBytes + 1, modifiedAt: null };
    const many = Array.from({ length: SYNC_LIMITS.files + 1 }, (_, i) => ({ name: `f${i}`, path: `m/f${String(i).padStart(5, '0')}`, size: 1, modifiedAt: null }));
    const { copy, skipped } = planMirror([...many, big]);
    expect(copy).toHaveLength(SYNC_LIMITS.files);
    expect(skipped).toEqual([{ path: 'a/big.bin', reason: 'over 50 MiB' }, { path: many.at(-1)!.path, reason: `past ${SYNC_LIMITS.files} files` }]);
    const total = planMirror([
      { name: 'x', path: 'x', size: SYNC_LIMITS.fileBytes, modifiedAt: null },
      ...Array.from({ length: 21 }, (_, i) => ({ name: `y${i}`, path: `y${String(i).padStart(2, '0')}`, size: SYNC_LIMITS.fileBytes, modifiedAt: null })),
    ]);
    expect(total.skipped.map(s => s.reason)).toEqual(['past the 1 GiB a copy holds', 'past the 1 GiB a copy holds']);
  });
});

describe('termag space sync', () => {
  it('copies every space it reaches into ~/termag/spaces, read-only, and names the default space', async () => {
    expect(await termag('space', 'sync', '--json')).toBe(0);
    const result = lastJson();
    expect(result.root).toBe(mirrorsDir(home));
    expect(result.default).toBe('team');
    expect(result.spaces.map((s: { space: string; kind: string; files: number }) => [s.space, s.kind, s.files])).toEqual([['team', 'synced', 3], ['other', 'synced', 1]]);
    expect(result.spaces[1].access).toEqual({ kind: 'inherited', via: 'parent-box' });
    expect(readFileSync(copy('team', 'plans', 'ask-direct-push.md'), 'utf8')).toBe('# Plan\n');
    expect(readFileSync(copy('team', '.termag', 'memory', 'bugbot.md'), 'utf8')).toBe('memory\n');
    expect(statSync(copy('team', 'status.md')).mode & 0o777).toBe(0o444);
    expect(statSync(copy('team', 'plans')).mode & 0o777).toBe(0o755);
    // A later `space put` of a file read from the copy says which version it replaces.
    expect(versionOf(home, 'team', 'status.md')?.via).toBe('sync');
  });

  it('downloads only what changed, and removes what the space no longer has or someone added', async () => {
    await termag('space', 'sync', 'team');
    fake.downloads = [];
    put('team', 'status.md', '# Status\nShipped.\n');
    fake.files.get('team')!.delete('plans/ask-direct-push.md');
    put('team', 'handoffs/thread-41.md', 'handoff\n');
    writeFileSync(copy('team', 'stray.txt'), 'not in the space');
    expect(await termag('space', 'sync', 'team', '--json')).toBe(0);
    expect(fake.downloads.sort()).toEqual(['team:handoffs/thread-41.md', 'team:status.md']);
    expect(lastJson().spaces[0]).toMatchObject({ downloaded: 2, removed: 2, files: 3 });
    expect(readFileSync(copy('team', 'status.md'), 'utf8')).toBe('# Status\nShipped.\n');
    expect(existsSync(copy('team', 'plans'))).toBe(false);
    expect(existsSync(copy('team', 'stray.txt'))).toBe(false);
  });

  it('puts back a file edited in the copy, and never writes through a link planted in it', async () => {
    await termag('space', 'sync', 'team');
    execFileSync('chmod', ['u+w', copy('team', 'status.md')]);
    writeFileSync(copy('team', 'status.md'), 'edited in place, longer than before');
    const outside = mkdtempSync(join(tmpdir(), 'termag-space-sync-outside-'));
    execFileSync('chmod', ['-R', 'u+w', copy('team', 'plans')]);
    rmSync(copy('team', 'plans'), { recursive: true });
    symlinkSync(outside, copy('team', 'plans'));
    fake.downloads = [];
    expect(await termag('space', 'sync', 'team')).toBe(0);
    expect(readFileSync(copy('team', 'status.md'), 'utf8')).toBe('# Status\n');
    expect(statSync(copy('team', 'plans')).isDirectory()).toBe(true);
    expect(existsSync(join(outside, 'ask-direct-push.md'))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('never writes through a link planted at a download\'s partial file (Bugbot, #1031)', async () => {
    await termag('space', 'sync', 'team');
    const outside = mkdtempSync(join(tmpdir(), 'termag-space-sync-outside-'));
    writeFileSync(join(outside, 'target'), 'untouched');
    symlinkSync(join(outside, 'target'), `${copy('team', 'status.md')}.termag-partial`);
    put('team', 'status.md', '# Status\nShipped.\n');
    expect(await termag('space', 'sync', 'team')).toBe(0);
    expect(readFileSync(copy('team', 'status.md'), 'utf8')).toBe('# Status\nShipped.\n');
    expect(readFileSync(join(outside, 'target'), 'utf8')).toBe('untouched');
    expect(existsSync(`${copy('team', 'status.md')}.termag-partial`)).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  it('clears only its own space\'s leftover staging, never a sibling space\'s in use (Bugbot, #1031)', async () => {
    mkdirSync(mirrorsDir(home), { recursive: true });
    mkdirSync(join(mirrorsDir(home), '.staging-team-abc123'));
    mkdirSync(join(mirrorsDir(home), '.staging-team-notes-xyz789'));
    expect(await termag('space', 'sync', 'team')).toBe(0);
    expect(existsSync(join(mirrorsDir(home), '.staging-team-abc123'))).toBe(false);
    expect(existsSync(join(mirrorsDir(home), '.staging-team-notes-xyz789'))).toBe(true);
  });

  it('keeps a copy it could not remove as its own, and removes it next time (Bugbot, #1031)', async () => {
    await termag('space', 'sync');
    fake.spaces = fake.spaces.filter(s => s.name !== 'other');
    execFileSync('chmod', ['0555', mirrorsDir(home)]);
    try {
      // The copy of team can't be updated either, so the sync says it failed.
      expect(await termag('space', 'sync', '--json')).toBe(1);
      expect(lastJson().removed).toEqual([]);
    } finally {
      execFileSync('chmod', ['0755', mirrorsDir(home)]);
    }
    expect(await termag('space', 'sync', '--json')).toBe(0);
    expect(lastJson().removed).toEqual(['other']);
    expect(existsSync(copy('other'))).toBe(false);
  });

  it('keeps its lock through a sync longer than a stale lock\'s age (Bugbot, #1031)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    let release!: () => void;
    let held!: () => void;
    const waiting = new Promise<void>(r => (held = r));
    fake.hold = { release: new Promise<void>(r => (release = r)), held };
    try {
      const first = termag('space', 'sync', 'team');
      await waiting;
      vi.advanceTimersByTime(11 * 60_000);
      expect(await termag('space', 'sync', 'team')).toBe(0);
      expect(out.at(-1)).toBe('team: another sync is running');
      release();
      expect(await first).toBe(0);
      expect(existsSync(join(home, '.termag', 'spaces', '.mirrors', '.team.lock'))).toBe(false);
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it('copies what it reaches when a stale copy can\'t be removed (Bugbot, #1031)', async () => {
    await termag('space', 'sync');
    fake.spaces = fake.spaces.filter(s => s.name !== 'other');
    const elsewhere = mkdtempSync(join(tmpdir(), 'termag-space-sync-elsewhere-'));
    rmSync(copy('other'), { recursive: true, force: true });
    symlinkSync(elsewhere, copy('other'));
    put('team', 'new.md', 'new\n');
    expect(await termag('space', 'sync', '--json')).toBe(1);
    const result = lastJson();
    expect(result.spaces.map((s: { space: string; kind: string }) => `${s.space}:${s.kind}`)).toEqual(['other:failed', 'team:synced']);
    expect(result.spaces[0].error).toMatch(/is a symlink/);
    expect(readFileSync(copy('team', 'new.md'), 'utf8')).toBe('new\n');
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('leaves a copy another sync is still downloading into, and removes it next time (Bugbot, #1031)', async () => {
    await termag('space', 'sync');
    put('other', 'late.txt', 'late\n');
    let release!: () => void;
    let held!: () => void;
    const waiting = new Promise<void>(r => (held = r));
    fake.hold = { release: new Promise<void>(r => (release = r)), held };
    try {
      const first = termag('space', 'sync', 'other');
      await waiting;
      fake.spaces = fake.spaces.filter(s => s.name !== 'other');
      expect(await termag('space', 'sync', '--json')).toBe(0);
      expect(lastJson().removed).toEqual([]);
      expect(existsSync(copy('other', 'notes.txt'))).toBe(true);
      release();
      await first;
    } finally {
      release();
    }
    expect(await termag('space', 'sync', '--json')).toBe(0);
    expect(lastJson().removed).toEqual(['other']);
    expect(existsSync(copy('other'))).toBe(false);
  });

  it('remembers the version it downloaded, not the listing\'s, for a later put (Security agent, #1031)', async () => {
    let release!: () => void;
    let held!: () => void;
    const waiting = new Promise<void>(r => (held = r));
    fake.hold = { release: new Promise<void>(r => (release = r)), held };
    try {
      const syncing = termag('space', 'sync', 'team');
      await waiting;
      // Changed after the listing, before its download.
      put('team', '.termag/memory/bugbot.md', 'changed\n');
      release();
      expect(await syncing).toBe(0);
    } finally {
      release();
    }
    const path = [...fake.files.get('team')!.keys()].sort()[0]!;
    const now = fake.files.get('team')!.get(path)!;
    expect(readFileSync(copy('team', path), 'utf8')).toBe(now.toString('utf8'));
    expect(versionOf(home, 'team', path)?.etag).toBe(etagOf(now));
  });

  it('removes the copy of a space it no longer reaches, and leaves a folder it never made', async () => {
    await termag('space', 'sync');
    mkdirSync(copy('mine'));
    writeFileSync(copy('mine', 'keep.txt'), 'by hand');
    fake.spaces = fake.spaces.filter(s => s.name !== 'other');
    expect(await termag('space', 'sync', '--json')).toBe(0);
    expect(lastJson().removed).toEqual(['other']);
    expect(existsSync(copy('other'))).toBe(false);
    expect(readFileSync(copy('mine', 'keep.txt'), 'utf8')).toBe('by hand');

    fake.spaces = [];
    expect(await termag('space', 'sync', 'team')).toBe(3);
    expect(existsSync(copy('team'))).toBe(false);
  });

  it('refuses a ~/termag/spaces, or a ~/termag, that is a symlink', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'termag-space-sync-elsewhere-'));
    mkdirSync(join(home, 'termag'));
    symlinkSync(elsewhere, mirrorsDir(home));
    expect(await termag('space', 'sync', 'team')).toBe(1);
    expect(err.join('\n')).toMatch(/is a symlink/);
    expect(existsSync(join(elsewhere, 'team'))).toBe(false);

    rmSync(join(home, 'termag'), { recursive: true, force: true });
    mkdirSync(join(elsewhere, 'spaces'), { recursive: true });
    symlinkSync(elsewhere, join(home, 'termag'));
    err = [];
    expect(await termag('space', 'sync', 'team')).toBe(1);
    expect(err.join('\n')).toMatch(/termag is a symlink/);
    expect(existsSync(join(elsewhere, 'spaces', 'team'))).toBe(false);
    rmSync(elsewhere, { recursive: true, force: true });
  });
});
