import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from './context.js';
import { run } from './main.js';
import {
  LIMITS, contextFor, defaultSpace, generationOf, kindOf, memoryPutRefusal, noticeOf, parseDuration, parseFront, planLoad, renderIndex, secretReason, sessionPlace, spaceDir,
} from './spaceMemory.js';

/**
 * A stand-in for the orchestrator's spaces routes (the space-memory ones
 * included) and for S3 behind its presigned URLs, which honours If-Match and
 * If-None-Match on a PUT the way S3 does: 412 when the condition fails.
 */
interface Fake {
  host: string;
  files: Map<string, Buffer>;
  /** GET /spaces/:space/memory: 'on', or 'old' (an orchestrator from before it: a bare 404). */
  memory: 'on' | 'old';
  role: 'owner' | 'editor' | 'viewer';
  spaces: Array<{ name: string; access?: { kind: 'explicit' } | { kind: 'inherited'; via: string } }>;
  writers: Record<string, unknown>;
  /** The orchestrator signs conditions (false: one from before space memory, which ignores them). */
  conditional: boolean;
  uploads: Array<{ path: string; condition: Record<string, string> }>;
  confirms: Array<{ path: string; note?: string }>;
  confirmBodies: Array<Record<string, unknown>>;
  deletes: string[];
  /** Each /tree request: its prefix, and whether it was recursive. */
  trees: Array<{ prefix: string; recursive: boolean }>;
  /** GET /session-space's answers by `project@workstream`; one missing is a 404. */
  sessionSpaces: Map<string, string | null>;
  sessionAsks: string[];
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
  const fake: Fake = {
    host: '', files: new Map(), memory: 'on', role: 'owner', spaces: [{ name: 'team', access: { kind: 'explicit' } }, { name: 'other', access: { kind: 'inherited', via: 'b' } }],
    writers: {}, conditional: true, uploads: [], confirms: [], confirmBodies: [], deletes: [], trees: [],
    sessionSpaces: new Map(), sessionAsks: [], close: async () => {},
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    if (p === '/s3/get') {
      const f = fake.files.get(url.searchParams.get('path')!);
      if (!f) { res.writeHead(404).end(); return; }
      res.writeHead(200).end(f);
      return;
    }
    if (p === '/s3/put') {
      const path = url.searchParams.get('path')!;
      const data = await body(req);
      const cur = fake.files.get(path);
      if (req.headers['if-none-match'] === '*' && cur) { res.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>'); return; }
      if (req.headers['if-match'] && (!cur || etagOf(cur) !== req.headers['if-match'])) { res.writeHead(412).end('<Error><Code>PreconditionFailed</Code></Error>'); return; }
      fake.files.set(path, data);
      res.writeHead(200, { ETag: etagOf(data) }).end();
      return;
    }
    if (req.headers.authorization !== 'Bearer tmag_box') { sendJson(res, 401, { error: 'no' }); return; }
    if (p === '/termag/api/cli/v1/session-space') {
      const key = `${url.searchParams.get('project')}@${url.searchParams.get('workstream')}`;
      fake.sessionAsks.push(key);
      if (!fake.sessionSpaces.has(key)) { sendJson(res, 404, { error: 'No such project or workstream on this box', code: 'not_found' }); return; }
      sendJson(res, 200, { space: fake.sessionSpaces.get(key) });
      return;
    }
    const m = /^\/termag\/api\/cli\/v1\/spaces(?:\/([^/]+)(\/.*)?)?$/.exec(p);
    if (!m) { sendJson(res, 404, { error: 'not found' }); return; }
    const [, rawSpace, rest = ''] = m;
    if (!rawSpace) {
      sendJson(res, 200, { spaces: fake.spaces.map(s => ({ id: s.name, name: s.name, description: null, role: fake.role, readOnly: false, usedBytes: 0, quotaBytes: 1 << 30, access: s.access })) });
      return;
    }
    const space = decodeURIComponent(rawSpace);
    if (!fake.spaces.some(s => s.name === space)) { sendJson(res, 404, { error: 'Not found', code: 'not_found' }); return; }
    const json = req.method === 'POST' ? JSON.parse((await body(req)).toString('utf8') || '{}') : {};
    if (rest === '/memory') {
      if (fake.memory === 'old') { sendJson(res, 404, { error: 'Not found', code: 'not_found' }); return; }
      sendJson(res, 200, { space, role: fake.role, readOnly: false, writable: fake.role !== 'viewer', me: 'u-me', writers: fake.writers });
      return;
    }
    if (rest === '/memory/log') {
      sendJson(res, 200, { space, entries: [{ at: '2026-10-27T10:00:00.000Z', action: 'file.put', path: '.termag/memory/a.md', bytes: 9, note: 'why', email: 'bob@example.com', name: 'Bob', box: 'bob-box', userId: 'u-bob', versionId: 'v1' }] });
      return;
    }
    if (rest === '/tree') {
      const prefix = url.searchParams.get('prefix') ?? '';
      const recursive = url.searchParams.get('recursive') === '1';
      fake.trees.push({ prefix, recursive });
      const files = [...fake.files.keys()].filter(k => k.startsWith(prefix) && (recursive || !k.slice(prefix.length).includes('/'))).sort()
        .map(k => ({ name: k.split('/').at(-1)!, path: k, size: fake.files.get(k)!.length, modifiedAt: '2026-10-27T09:00:00.000Z', etag: etagOf(fake.files.get(k)!) }));
      sendJson(res, 200, { prefix, dirs: [], files, nextCursor: null });
      return;
    }
    if (rest === '/files/download') {
      if (!fake.files.has(json.path)) { sendJson(res, 404, { error: 'No such file', code: 'file_not_found' }); return; }
      sendJson(res, 200, { url: `${fake.host}/s3/get?path=${encodeURIComponent(json.path)}`, size: fake.files.get(json.path)!.length, etag: etagOf(fake.files.get(json.path)!) });
      return;
    }
    if (rest === '/files/upload') {
      const condition: Record<string, string> = json.ifMatch ? { 'if-match': json.ifMatch } : json.ifNoneMatch ? { 'if-none-match': json.ifNoneMatch } : {};
      fake.uploads.push({ path: json.path, condition });
      sendJson(res, 200, {
        kind: 'single', path: json.path, url: `${fake.host}/s3/put?path=${encodeURIComponent(json.path)}`, method: 'PUT',
        headers: { 'content-type': json.contentType, ...(fake.conditional ? condition : {}) },
        ...(fake.conditional && Object.keys(condition).length ? { conditional: true } : {}),
      });
      return;
    }
    if (rest === '/files/uploaded') { fake.confirms.push({ path: json.path, ...(json.note ? { note: json.note } : {}) }); fake.confirmBodies.push(json); sendJson(res, 200, { ok: true }); return; }
    if (rest === '/files' && req.method === 'DELETE') {
      const path = url.searchParams.get('path')!;
      fake.deletes.push(`${path}|${url.searchParams.get('note') ?? ''}`);
      fake.files.delete(path);
      sendJson(res, 200, { ok: true, deleted: 1, failed: [] });
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
let stdin: string;
let env: NodeJS.ProcessEnv;

function ctx(): Ctx {
  return {
    env, home, hostname: 'devbox', interactive: false,
    out: t => out.push(t), err: t => err.push(t), fetch: globalThis.fetch,
    openBrowser: () => { throw new Error('no browser'); },
    readFile: p => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    readStdin: async () => stdin,
  };
}
const termag = (...argv: string[]) => run(argv, ctx());
const put = (path: string, text: string) => fake.files.set(path, Buffer.from(text));
const local = (...rel: string[]) => join(spaceDir(home, 'team'), ...rel);
const memory = (name: string, description: string, body = 'A fact.\n') => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

beforeEach(async () => {
  fake = await startFake();
  home = mkdtempSync(join(tmpdir(), 'termag-memory-test-'));
  env = { TERMAG_AGENT_CONFIG: join(home, 'agent.config.json') };
  writeFileSync(join(home, 'agent.config.json'), JSON.stringify({ server_url: `${fake.host.replace(/^http/, 'ws')}/termag/ws/agent`, token: 'tmag_box' }));
  out = [];
  err = [];
  stdin = '';
  put('.termag/prompt.md', '# Read this first\nBe careful.\n');
  put('.termag/memory/e2e-own-tmpdir.md', memory('e2e-own-tmpdir', 'Give each e2e stack its own TMPDIR'));
  put('.termag/memory/bugbot.md', memory('bugbot', 'Bugbot skips drafts'));
  put('.termag/skills/demo-kit/SKILL.md', '---\nname: demo-kit\ndescription: Record a demo\n---\nUse demo-kit.mjs.\n');
  put('.termag/skills/demo-kit/demo-kit.mjs', '#!/usr/bin/env node\nconsole.log(1)\n');
  put('.termag/skills/loose/measure.mjs', 'export {}\n');
  put('.termag/tools/tracker/index.html', '<p>tool</p>');
  put('.termag/notes.txt', 'not memory');
  fake.writers = { '.termag/memory/bugbot.md': { userId: 'u-bob', email: 'bob@example.com', name: 'Bob', box: 'bob-box', at: '2026-10-27T08:00:00.000Z' } };
});

afterEach(async () => {
  await fake.close();
  // The copy is read-only on purpose; make it removable.
  execFileSync('chmod', ['-R', 'u+w', home]);
  rmSync(home, { recursive: true, force: true });
});

describe('pure parts', () => {
  it('knows what is memory: prompt, memories, skills; never tools', () => {
    expect(kindOf('prompt.md')).toEqual({ kind: 'prompt' });
    expect(kindOf('memory/a.md')).toEqual({ kind: 'memory' });
    expect(kindOf('memory/sub/a.md')).toBeNull();
    expect(kindOf('skills/demo-kit/x/y.mjs')).toEqual({ kind: 'skill', skill: 'demo-kit' });
    expect(kindOf('tools/tracker/index.html')).toBeNull();
    expect(kindOf('skills/../x/SKILL.md')).toBeNull();
    expect(kindOf('notes.txt')).toBeNull();
  });

  it('keeps every cap, newest memories first', () => {
    const files = [
      { rel: 'memory/big.md', size: LIMITS.memoryBytes + 1, modifiedAt: '2026-10-02' },
      ...Array.from({ length: LIMITS.memories + 1 }, (_, i) => ({ rel: `memory/m${i}.md`, size: 10, modifiedAt: `2026-10-${String(10 + (i % 15)).padStart(2, '0')}T00:00:${String(i % 60).padStart(2, '0')}` })),
      ...Array.from({ length: LIMITS.skillFiles + 1 }, (_, i) => ({ rel: `skills/s/f${i}.txt`, size: 1, modifiedAt: null })),
      { rel: 'tools/t/data.json', size: 1, modifiedAt: null },
    ];
    const { load, skipped } = planLoad(files);
    expect(skipped).toEqual(expect.arrayContaining([
      { path: 'memory/big.md', reason: 'over 8 KB' },
      expect.objectContaining({ reason: `more than ${LIMITS.memories} memories` }),
      expect.objectContaining({ reason: `skill has more than ${LIMITS.skillFiles} files` }),
    ]));
    expect(load.filter(r => r.startsWith('memory/'))).toHaveLength(LIMITS.memories);
    expect(load).not.toContain('tools/t/data.json');
  });

  it('always keeps prompt.md, however old, when newer files fill the caps (Bugbot, #770)', () => {
    const helpers = Array.from({ length: 4 }, (_, k) => Array.from({ length: LIMITS.skillFiles }, (_, i) => ({
      rel: `skills/s${k}/f${i}.bin`, size: LIMITS.helperBytes, modifiedAt: '2026-10-27T10:00:00Z',
    }))).flat();
    const { load, skipped } = planLoad([{ rel: 'prompt.md', size: 100, modifiedAt: '2020-01-01T00:00:00Z' }, ...helpers]);
    expect(load).toContain('prompt.md');
    expect(skipped.map(x => x.path)).not.toContain('prompt.md');
    expect(skipped.some(x => x.reason.startsWith('over the .termag/ cap'))).toBe(true);
  });

  it('calls a new file in an existing skill a changed skill, not a new one (Bugbot, #770)', () => {
    const seen = { 'skills/k/SKILL.md': '1' };
    const n = noticeOf('team', '/d', seen, { 'skills/k/SKILL.md': { etag: '1' }, 'skills/k/helper.mjs': { etag: '1' } } as never)!;
    expect(n).toContain('~1 skill (k)');
    expect(n).not.toContain('+1 skill');
    // And a file gone from a skill that is still there is a change, not a removal.
    const gone = noticeOf('team', '/d', { 'skills/k/SKILL.md': '1', 'skills/k/x.mjs': '1' }, { 'skills/k/SKILL.md': { etag: '1' } } as never)!;
    expect(gone).toContain('~1 skill (k)');
    expect(gone).not.toContain('-1 skill');
    const removed = noticeOf('team', '/d', { 'skills/k/SKILL.md': '1' }, {} as never)!;
    expect(removed).toContain('-1 skill (k)');
  });

  it('withholds by the first secret line, and says what it looks like', () => {
    expect(secretReason(`a\nb AKIA${'Z'.repeat(16)}`)).toBe('looks like a AWS access key id (line 2)');
    expect(secretReason('just text')).toBeNull();
  });

  it('reads frontmatter and durations', () => {
    expect(parseFront(memory('x', 'what x is', 'body\n'))).toEqual({ name: 'x', description: 'what x is', body: 'body\n' });
    expect(parseFront('no front')).toEqual({ body: 'no front' });
    expect(parseDuration('60s')).toBe(60_000);
    expect(parseDuration('5m')).toBe(300_000);
    expect(() => parseDuration('soon')).toThrow(/duration/);
  });

  it('names the session of a directory in a project\'s checkout, and none elsewhere', () => {
    const projects = join('/home/alice', 'termag', 'projects');
    expect(sessionPlace('/home/alice', join(projects, 'app'))).toEqual({ project: 'app', workstream: 'main' });
    expect(sessionPlace('/home/alice', join(projects, 'app', 'src', 'lib'))).toEqual({ project: 'app', workstream: 'main' });
    expect(sessionPlace('/home/alice', join(projects, 'app', '.worktrees', 'fix-login', 'src'))).toEqual({ project: 'app', workstream: 'fix-login' });
    for (const cwd of [projects, join(projects, 'app', '.worktrees'), '/home/alice/src', '/tmp', join(projects, 'a b'), 7, undefined]) {
      expect(sessionPlace('/home/alice', cwd), String(cwd)).toBeNull();
    }
  });

  it('picks the box\'s first explicit grant, or $TERMAG_SPACE among those it reaches', () => {
    const spaces = [{ name: 'bb', access: { kind: 'inherited', via: 'x' } }, { name: 'aa', access: { kind: 'explicit' } }] as never;
    expect(defaultSpace(spaces, {})).toBe('aa');
    expect(defaultSpace(spaces, { TERMAG_SPACE: 'bb' })).toBe('bb');
    expect(defaultSpace(spaces, { TERMAG_SPACE: 'nope' })).toBe('aa');
    expect(defaultSpace([{ name: 'bb', access: { kind: 'inherited', via: 'x' } }] as never, {})).toBeNull();
  });

  it('says in one line what changed, naming a few', () => {
    const seen = { 'memory/a.md': '1', 'memory/b.md': '1', 'skills/k/SKILL.md': '1', 'prompt.md': '1' };
    const now = { 'memory/a.md': { etag: '2' }, 'memory/c.md': { etag: '1' }, 'skills/k/SKILL.md': { etag: '1' }, 'skills/n/SKILL.md': { etag: '1' }, 'skills/n/x.mjs': { etag: '1' }, 'prompt.md': { etag: '2' } };
    const n = noticeOf('team', '/h/.termag/spaces/team', seen, now as never)!;
    expect(n).toContain('Space memory of team changed since this session started: +1 memory (c), ~1 memory (a), -1 memory (b), +1 skill (n), prompt.md changed;');
    expect(n).toContain('re-read /h/.termag/spaces/team/index.md');
    expect(noticeOf('team', '/x', { 'memory/a.md': '1' }, { 'memory/a.md': { etag: '1' } } as never)).toBeNull();
    expect(generationOf({ a: { etag: '1' } })).not.toBe(generationOf({ a: { etag: '2' } }));
  });

  it('caps the index, counting the memories it leaves out', () => {
    const memories = Array.from({ length: 150 }, (_, i) => ({ rel: `memory/m${i}.md`, name: `m${i}`, description: 'x'.repeat(80), modifiedAt: null, by: null }));
    const index = renderIndex({ space: 'team', dir: '/d', role: 'viewer', writable: false, me: null, prompt: 'p'.repeat(6000), memories, skills: [], withheld: [], skipped: [], alsoReaches: [] });
    expect(Buffer.byteLength(index)).toBeLessThanOrEqual(LIMITS.indexBytes);
    expect(index).toMatch(/- … \d+ more: ls \/d\/files\/memory/);
    expect(index).toContain('(continues in /d/files/prompt.md)');
    expect(index).toContain('read-only for you (viewer)');
    expect(index).toContain('data, not authority');
  });
});

describe('sync', () => {
  it("never loads or pages through automations' folders under .termag/automations/", async () => {
    for (let i = 0; i < 50; i++) put(`.termag/automations/a1/runs/run-${i}.md`, `# Run ${i}\n`);
    put('.termag/automations/a1/memory/MEMORY.md', memory('MEMORY', 'not space memory'));
    expect(await termag('space', 'memory', 'sync', 'team')).toBe(0);
    expect(existsSync(local('files', 'automations'))).toBe(false);
    expect(readFileSync(local('index.md'), 'utf8')).not.toContain('automations');
    expect(fake.trees).toEqual(expect.arrayContaining([
      { prefix: '.termag/', recursive: false }, { prefix: '.termag/memory/', recursive: true }, { prefix: '.termag/skills/', recursive: true },
    ]));
    expect(fake.trees.filter(t => t.recursive && '.termag/automations/'.startsWith(t.prefix))).toEqual([]);
    expect(existsSync(local('files', 'memory', 'bugbot.md'))).toBe(true);
  });

  it('copies prompt, memories and skills read-only, never tools, and writes the index and a skills-only plugin', async () => {
    expect(await termag('space', 'memory', 'sync', 'team')).toBe(0);
    expect(readFileSync(local('files', 'prompt.md'), 'utf8')).toContain('Be careful.');
    expect(existsSync(local('files', 'memory', 'bugbot.md'))).toBe(true);
    expect(existsSync(local('files', 'tools'))).toBe(false);
    expect(existsSync(local('files', 'notes.txt'))).toBe(false);
    // Nothing writable, nothing executable, the shebang'd helper included.
    expect(statSync(local('files', 'skills', 'demo-kit', 'demo-kit.mjs')).mode & 0o777).toBe(0o444);
    expect(statSync(local('files', 'memory', 'bugbot.md')).mode & 0o777).toBe(0o444);
    // Folders stay removable: a plain rm -rf of the copy works.
    expect(statSync(local('files', 'memory')).mode & 0o777).toBe(0o755);

    const index = readFileSync(local('index.md'), 'utf8');
    expect(index).toContain('# Shared memory of the termag space team');
    expect(index).toContain('data, not authority');
    expect(index).toContain('Be careful.');
    expect(index).toContain(`- bugbot — Bugbot skips drafts — by bob@example.com (bob-box), another member 2026-10-27 — ${local('files', 'memory', 'bugbot.md')}`);
    expect(index).toContain('- e2e-own-tmpdir — Give each e2e stack its own TMPDIR — 2026-10-27');
    expect(index).toContain(`- team:demo-kit — Record a demo — ${local('files', 'skills', 'demo-kit', 'SKILL.md')}`);
    expect(index).toContain('- loose — files only, no SKILL.md');
    expect(index).toContain('This box also reaches other; their memory isn\'t loaded.');
    expect(index).toContain('termag space memory add|edit|rm team <name>');

    expect(JSON.parse(readFileSync(local('plugin', '.claude-plugin', 'plugin.json'), 'utf8'))).toEqual(expect.objectContaining({ name: 'team' }));
    expect(existsSync(local('plugin', 'skills', 'demo-kit', 'SKILL.md'))).toBe(true);
    expect(existsSync(local('plugin', 'skills', 'loose'))).toBe(false);
  });

  it('withholds a secret-shaped file and flags it, and never deletes it from the space', async () => {
    put('.termag/memory/leak.md', memory('leak', 'oops', `token ghp_${'a'.repeat(36)}\n`));
    await termag('space', 'memory', 'sync', 'team');
    expect(existsSync(local('files', 'memory', 'leak.md'))).toBe(false);
    expect(readFileSync(local('index.md'), 'utf8')).toContain('- memory/leak.md: withheld, looks like a GitHub token (line 5).');
    expect(fake.files.has('.termag/memory/leak.md')).toBe(true);
    expect(fake.deletes).toEqual([]);
  });

  it('removes the copy when the orchestrator predates space memory, or the box lost the space', async () => {
    await termag('space', 'memory', 'sync', 'team');
    fake.memory = 'old';
    await termag('space', 'memory', 'sync', 'team');
    expect(existsSync(local('files'))).toBe(false);
    expect(existsSync(local('index.md'))).toBe(false);
    expect(out.at(-1)).toContain('nothing loaded (this orchestrator does not serve space memory)');
    fake.memory = 'on';
    await termag('space', 'memory', 'sync', 'team');
    expect(existsSync(local('index.md'))).toBe(true);
    fake.spaces = fake.spaces.filter(s => s.name !== 'team');
    await termag('space', 'memory', 'sync', 'team');
    expect(existsSync(spaceDir(home, 'team'))).toBe(false);
  });

  it('is fresh within --if-older, and unchanged when nothing changed', async () => {
    await termag('space', 'memory', 'sync', 'team', '--json');
    expect(JSON.parse(out.at(-1)!).kind).toBe('synced');
    await termag('space', 'memory', 'sync', 'team', '--if-older', '60s', '--json');
    expect(JSON.parse(out.at(-1)!).kind).toBe('fresh');
    await termag('space', 'memory', 'sync', 'team', '--json');
    expect(JSON.parse(out.at(-1)!).kind).toBe('unchanged');
  });

  it('loads the box\'s first explicit grant when no space is named', async () => {
    await termag('space', 'memory', 'sync', '--json');
    expect(JSON.parse(out.at(-1)!)).toEqual(expect.objectContaining({ kind: 'synced', space: 'team' }));
  });
});

describe('context', () => {
  it('gives a session the index once, then a notice once per change, then nothing', async () => {
    const session = join(home, 's.json');
    await termag('space', 'memory', 'context', 'team', '--session', session, '--refresh', '60s', '--json');
    const start = JSON.parse(out.at(-1)!);
    expect(start).toEqual(expect.objectContaining({ kind: 'start', space: 'team', pluginDir: local('plugin') }));
    expect(start.index).toBe(readFileSync(local('index.md'), 'utf8'));

    await termag('space', 'memory', 'context', 'team', '--session', session, '--refresh', '60s', '--json');
    expect(JSON.parse(out.at(-1)!).kind).toBe('none');

    put('.termag/memory/new-fact.md', memory('new-fact', 'Something learned'));
    await termag('space', 'memory', 'sync', 'team');
    await termag('space', 'memory', 'context', 'team', '--session', session, '--json');
    const notice = JSON.parse(out.at(-1)!);
    expect(notice.kind).toBe('notice');
    expect(notice.notice).toContain('+1 memory (new-fact)');
    await termag('space', 'memory', 'context', 'team', '--session', session, '--json');
    expect(JSON.parse(out.at(-1)!).kind).toBe('none');
  });

  it('tells a session once that memory stopped loading', async () => {
    const session = join(home, 's.json');
    await termag('space', 'memory', 'context', 'team', '--session', session, '--refresh', '0s', '--json');
    fake.memory = 'old';
    await termag('space', 'memory', 'context', 'team', '--session', session, '--refresh', '0s', '--json');
    expect(JSON.parse(out.at(-1)!).notice).toContain('no longer loaded');
    await termag('space', 'memory', 'context', 'team', '--session', session, '--refresh', '0s', '--json');
    expect(JSON.parse(out.at(-1)!).kind).toBe('off');
  });

  it('loads a named space the box reaches, and the box default for one it does not', async () => {
    put('.termag/prompt.md', '# team prompt\n');
    fake.spaces.push({ name: 'design', access: { kind: 'explicit' } });
    await termag('space', 'memory', 'context', 'design', '--session', join(home, 'd.json'), '--refresh', '60s', '--json');
    expect(JSON.parse(out.at(-1)!)).toEqual(expect.objectContaining({ kind: 'start', space: 'design' }));
    // A tab opened in a space this box isn't granted: the chat shows under the box's first, and loads it.
    await termag('space', 'memory', 'context', 'elsewhere', '--session', join(home, 'e.json'), '--refresh', '60s', '--json');
    expect(JSON.parse(out.at(-1)!)).toEqual(expect.objectContaining({ kind: 'start', space: 'team' }));
    // Only context falls back: sync names exactly what it syncs.
    expect(await termag('space', 'memory', 'sync', 'elsewhere', '--json')).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual(expect.objectContaining({ kind: 'gone', space: 'elsewhere' }));
  });

  it('answers Claude Code hooks by session id, and stays quiet in a chat-runner turn', async () => {
    stdin = JSON.stringify({ session_id: 'abcdef12-3456', hook_event_name: 'SessionStart' });
    await termag('space', 'memory', 'context', '--hook', 'SessionStart', '--refresh', '60s');
    const hook = JSON.parse(out.at(-1)!);
    expect(hook.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(hook.hookSpecificOutput.additionalContext).toContain('Shared memory of the termag space team');
    out = [];
    await termag('space', 'memory', 'context', '--hook', 'UserPromptSubmit', '--refresh', '60s');
    expect(out).toEqual([]);
    env.TERMAG_SPACE_MEMORY_MANAGED = '1';
    await termag('space', 'memory', 'context', '--hook', 'SessionStart');
    expect(out).toEqual([]);
  });

  it('loads the space a session in a project\'s checkout was started in, asking once a session', async () => {
    put('.termag/prompt.md', '# design prompt\n');
    fake.spaces.push({ name: 'design', access: { kind: 'explicit' } });
    fake.sessionSpaces.set('app@fix-login', 'design');
    const cwd = join(home, 'termag', 'projects', 'app', '.worktrees', 'fix-login', 'src');
    stdin = JSON.stringify({ session_id: 'abcdef12-3456', hook_event_name: 'SessionStart', cwd });
    await termag('space', 'memory', 'context', '--hook', 'SessionStart', '--refresh', '60s');
    expect(JSON.parse(out.at(-1)!).hookSpecificOutput.additionalContext).toContain('Shared memory of the termag space design');
    await termag('space', 'memory', 'context', '--hook', 'UserPromptSubmit', '--refresh', '60s');
    expect(fake.sessionAsks).toEqual(['app@fix-login']);
  });

  it('loads nothing for a session started in No space, and the box default outside a checkout or with no answer', async () => {
    fake.sessionSpaces.set('app@main', null);
    stdin = JSON.stringify({ session_id: 'nospace-0001', cwd: join(home, 'termag', 'projects', 'app') });
    await termag('space', 'memory', 'context', '--hook', 'SessionStart', '--refresh', '60s');
    expect(out).toEqual([]);
    // Elsewhere on the box, and a project the orchestrator doesn't know: the box's first grant, as before.
    for (const [id, cwd] of [['elsewhere-0001', join(home, 'src')], ['unknown-00001', join(home, 'termag', 'projects', 'byhand')]]) {
      out = [];
      stdin = JSON.stringify({ session_id: id, cwd });
      await termag('space', 'memory', 'context', '--hook', 'SessionStart', '--refresh', '60s');
      expect(JSON.parse(out.at(-1)!).hookSpecificOutput.additionalContext).toContain('Shared memory of the termag space team');
    }
    // $TERMAG_SPACE, set by hand, still names the space; nothing is asked.
    fake.sessionAsks.length = 0;
    env.TERMAG_SPACE = 'team';
    out = [];
    stdin = JSON.stringify({ session_id: 'pinned-00001', cwd: join(home, 'termag', 'projects', 'app') });
    await termag('space', 'memory', 'context', '--hook', 'SessionStart', '--refresh', '60s');
    expect(JSON.parse(out.at(-1)!).hookSpecificOutput.additionalContext).toContain('Shared memory of the termag space team');
    expect(fake.sessionAsks).toEqual([]);
  });

  it('prints nothing for a hook when anything fails', async () => {
    stdin = 'not json';
    await fake.close();
    expect(await termag('space', 'memory', 'context', '--hook', 'SessionStart', '--refresh', '0s')).toBe(0);
    expect(out).toEqual([]);
    expect(contextFor(home, null, null)).toEqual({ kind: 'off', space: null });
  });
});

describe('add, edit, rm, log', () => {
  it('adds a memory with frontmatter, If-None-Match and the note, and the local copy follows', async () => {
    stdin = 'Run e2e with its own TMPDIR.\n';
    expect(await termag('space', 'memory', 'add', 'team', 'own-tmpdir', '--description', 'Each ask its own TMPDIR', '--note', 'learned today')).toBe(0);
    expect(fake.files.get('.termag/memory/own-tmpdir.md')!.toString()).toBe(memory('own-tmpdir', 'Each ask its own TMPDIR', 'Run e2e with its own TMPDIR.\n'));
    expect(fake.uploads.at(-1)!.condition).toEqual({ 'if-none-match': '*' });
    expect(fake.confirms.at(-1)).toEqual({ path: '.termag/memory/own-tmpdir.md', note: 'learned today' });
    expect(existsSync(local('files', 'memory', 'own-tmpdir.md'))).toBe(true);
  });

  it('refuses to add over an existing memory (exit 6), a bad name, no description, or a secret', async () => {
    stdin = 'x\n';
    expect(await termag('space', 'memory', 'add', 'team', 'bugbot', '--description', 'd')).toBe(6);
    expect(err.join('\n')).toMatch(/already exists/);
    expect(await termag('space', 'memory', 'add', 'team', 'Bad_Name', '--description', 'd')).toBe(2);
    expect(await termag('space', 'memory', 'add', 'team', 'nodesc')).toBe(2);
    stdin = `key AKIA${'X'.repeat(16)}\n`;
    expect(await termag('space', 'memory', 'add', 'team', 'leak', '--description', 'd')).toBe(1);
    expect(err.join('\n')).toMatch(/looks like a AWS access key id/);
    expect(fake.files.has('.termag/memory/leak.md')).toBe(false);
  });

  it('edits against the version this box read; a change since is exit 6, with theirs shown', async () => {
    await termag('space', 'memory', 'sync', 'team');
    put('.termag/memory/bugbot.md', memory('bugbot', 'Bugbot skips drafts', 'Someone else\'s edit.\n'));
    stdin = 'My edit.\n';
    expect(await termag('space', 'memory', 'edit', 'team', 'bugbot')).toBe(6);
    expect(err.join('\n')).toContain('changed since you read it');
    expect(err.join('\n')).toContain('Someone else\'s edit.');
    expect(fake.files.get('.termag/memory/bugbot.md')!.toString()).toContain('Someone else\'s edit.');
    // The failed edit refreshed the copy: merging and trying again works, keeping the description.
    stdin = 'Someone else\'s edit. And mine.\n';
    expect(await termag('space', 'memory', 'edit', 'team', 'bugbot', '--note', 'merged')).toBe(0);
    expect(fake.files.get('.termag/memory/bugbot.md')!.toString()).toBe(memory('bugbot', 'Bugbot skips drafts', 'Someone else\'s edit. And mine.\n'));
    expect(fake.uploads.at(-1)!.condition['if-match']).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it('edit replaces the version last read, from space get or memory cat, not just the last sync (question 3)', async () => {
    await termag('space', 'memory', 'sync', 'team');
    put('.termag/memory/bugbot.md', memory('bugbot', 'Bugbot skips drafts', 'Newer, read with space get.\n'));
    // The agent reads the newer version some other way: the edit must replace that one, not the synced one.
    await termag('space', 'get', 'team:.termag/memory/bugbot.md', join(home, 'bugbot.md'));
    stdin = 'Newer, read with space get. Plus mine.\n';
    expect(await termag('space', 'memory', 'edit', 'team', 'bugbot')).toBe(0);
    expect(fake.files.get('.termag/memory/bugbot.md')!.toString()).toContain('Plus mine.');
    // memory cat records what it printed, too.
    put('.termag/memory/bugbot.md', memory('bugbot', 'Bugbot skips drafts', 'Third.\n'));
    await termag('space', 'memory', 'sync', 'team');
    out = [];
    expect(await termag('space', 'memory', 'cat', 'team', 'bugbot')).toBe(0);
    expect(out.at(-1)).toContain('Third.');
    stdin = 'Third. And more.\n';
    expect(await termag('space', 'memory', 'edit', 'team', 'bugbot')).toBe(0);
    expect(fake.uploads.at(-1)!.condition['if-match']).toBe(etagOf(Buffer.from(memory('bugbot', 'Bugbot skips drafts', 'Third.\n'))));
  });

  it('the confirm carries the condition and the PUT\'s ETag, so the orchestrator checks again', async () => {
    stdin = 'x\n';
    await termag('space', 'memory', 'add', 'team', 'confirm-check', '--description', 'd');
    expect(fake.confirmBodies.at(-1)).toEqual(expect.objectContaining({ path: '.termag/memory/confirm-check.md', ifNoneMatch: '*', etag: expect.stringMatching(/^"[0-9a-f]{32}"$/) }));
  });

  it('writes nothing through an orchestrator that cannot sign the condition', async () => {
    fake.conditional = false;
    stdin = 'x\n';
    expect(await termag('space', 'memory', 'add', 'team', 'fresh-one', '--description', 'd')).toBe(1);
    expect(err.join('\n')).toMatch(/cannot sign conditional writes/);
    expect(fake.files.has('.termag/memory/fresh-one.md')).toBe(false);
  });

  it('removes a memory with its note, and prints the log', async () => {
    expect(await termag('space', 'memory', 'rm', 'team', 'bugbot', '--note', 'wrong')).toBe(0);
    expect(fake.deletes).toEqual(['.termag/memory/bugbot.md|wrong']);
    expect(await termag('space', 'memory', 'log', 'team')).toBe(0);
    expect(out.at(-1)).toMatch(/bob@example.com \(bob-box\)\s+put\s+memory\/a.md\s+why/);
  });

  it('lists what loaded and what was withheld', async () => {
    put('.termag/memory/leak.md', memory('leak', 'oops', `xoxb-${'1'.repeat(12)}\n`));
    expect(await termag('space', 'memory', 'ls', 'team')).toBe(0);
    expect(out.at(-1)).toMatch(/memory\/bugbot.md\s+Bugbot skips drafts/);
    expect(out.at(-1)).toMatch(/memory\/leak.md\s+WITHHELD: looks like a Slack token/);
  });
});

describe('space put into .termag/', () => {
  it('refuses a secret-shaped file before uploading anything', async () => {
    const dir = join(home, 'up');
    mkdirSync(dir);
    writeFileSync(join(dir, 'ok.md'), 'fine\n');
    writeFileSync(join(dir, 'bad.md'), `-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\n`);
    expect(await termag('space', 'put', dir, 'team:.termag/memory/', '-r')).toBe(1);
    expect(err.join('\n')).toMatch(/bad.md looks like a private key/);
    expect(fake.uploads).toEqual([]);
  });
  it("doesn't scan an automation's folder, which is not space memory: a run's push must not be refused", async () => {
    const log = join(home, 'run-1.md');
    writeFileSync(log, `# Run 1\nthe agent pasted AKIA${'Z'.repeat(16)}\n`);
    expect(await termag('space', 'put', log, 'team:.termag/automations/a1/runs/run-1.md')).toBe(0);
    expect(fake.uploads.map(u => u.path)).toEqual(['.termag/automations/a1/runs/run-1.md']);
    expect(memoryPutRefusal('.termag/automations/a1/memory/MEMORY.md', `AKIA${'Z'.repeat(16)}`)).toBeNull();
    expect(memoryPutRefusal('.termag/memory/x.md', `AKIA${'Z'.repeat(16)}`)).toMatch(/AWS access key/);
  });
});

describe('space names and paths never reach outside ~/.termag/spaces/<space>/ (Bugbot, #770)', () => {
  const sentinels = () => {
    mkdirSync(join(home, '.termag', 'chats'), { recursive: true });
    writeFileSync(join(home, '.termag', 'keep.txt'), 'keep');
    writeFileSync(join(home, '.termag', 'chats', 'keep.json'), '{}');
    writeFileSync(join(home, 'keep-home.txt'), 'keep');
  };
  const intact = () => {
    expect(readFileSync(join(home, '.termag', 'keep.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(home, '.termag', 'chats', 'keep.json'))).toBe(true);
    expect(readFileSync(join(home, 'keep-home.txt'), 'utf8')).toBe('keep');
    expect(existsSync(join(home, 'agent.config.json'))).toBe(true);
  };

  for (const bad of ['..', '../..', '.', '/', '~', '/etc', 'a/b', '../chats', `${'x'}/..`]) {
    it(`refuses ${JSON.stringify(bad)} as a space, and deletes nothing`, async () => {
      sentinels();
      stdin = 'x\n';
      for (const argv of [
        ['space', 'memory', 'edit', bad, 'bugbot'],
        ['space', 'memory', 'add', bad, 'new-one', '--description', 'd'],
        ['space', 'memory', 'rm', bad, 'bugbot'],
        ['space', 'memory', 'sync', bad],
        ['space', 'memory', 'context', bad, '--session', join(home, 's.json'), '--refresh', '0s'],
        ['space', 'memory', 'ls', bad],
        ['space', 'memory', 'log', bad],
      ]) {
        expect(await termag(...argv), argv.join(' ')).toBe(2);
      }
      intact();
    });
  }

  it('refuses a space name from the server that is not one, and deletes nothing', async () => {
    sentinels();
    fake.spaces = [{ name: '..', access: { kind: 'explicit' } }];
    await termag('space', 'memory', 'sync');
    await termag('space', 'memory', 'context', '--session', join(home, 's.json'), '--refresh', '0s');
    intact();
  });

  it('never follows a symlinked copy out of ~/.termag/spaces', async () => {
    sentinels();
    const outside = join(home, 'outside');
    mkdirSync(join(outside, 'sub'), { recursive: true });
    writeFileSync(join(outside, 'sub', 'tool.sh'), '#!/bin/sh\n', { mode: 0o755 });
    mkdirSync(join(home, '.termag', 'spaces'), { recursive: true });
    symlinkSync(outside, join(home, '.termag', 'spaces', 'team'));
    expect(await termag('space', 'memory', 'sync', 'team')).not.toBe(0);
    expect(existsSync(join(outside, 'sub', 'tool.sh'))).toBe(true);
    expect(statSync(join(outside, 'sub', 'tool.sh')).mode & 0o777).toBe(0o755);
    intact();
  });

  it('never syncs through a symlinked ~/.termag/spaces', async () => {
    sentinels();
    const outside = join(home, 'elsewhere');
    mkdirSync(outside);
    mkdirSync(join(home, '.termag'), { recursive: true });
    symlinkSync(outside, join(home, '.termag', 'spaces'));
    expect(await termag('space', 'memory', 'sync', 'team')).not.toBe(0);
    expect(existsSync(join(outside, 'team'))).toBe(false);
    intact();
  });
});

describe('pane-claude: an interactive pane\'s skills', () => {
  const pane = (...extra: string[]) => termag('space', 'memory', 'pane-claude', '--key', 'p1--main', ...extra);
  const launcher = () => join(home, '.termag', 'spaces', '.panes', 'p1--main', 'claude');
  const frozen = (...rel: string[]) => join(home, '.termag', 'spaces', '.panes', 'p1--main', 'plugin', ...rel);

  it('a fresh launch syncs, freezes the space\'s plugin for the pane, and prints a launcher for it', async () => {
    expect(await pane()).toBe(0);
    expect(out.at(-1)).toBe(launcher());
    expect(readFileSync(launcher(), 'utf8')).toBe(`#!/bin/sh\nexec claude --plugin-dir '${frozen()}' "$@"\n`);
    expect(statSync(launcher()).mode & 0o777).toBe(0o700);
    expect(readFileSync(frozen('skills', 'demo-kit', 'SKILL.md'), 'utf8')).toContain('name: demo-kit');
    expect(existsSync(frozen('.claude-plugin', 'plugin.json'))).toBe(true);
    // Nothing executable in the copy, the space's shebang'd helper included.
    expect(statSync(frozen('skills', 'demo-kit', 'demo-kit.mjs')).mode & 0o111).toBe(0);
  });

  it('a resume keeps the skills its session started with; the next fresh launch takes the new ones', async () => {
    await pane();
    put('.termag/skills/demo-kit/SKILL.md', '---\nname: demo-kit\ndescription: Record a demo, v2\n---\nv2\n');
    await termag('space', 'memory', 'sync', 'team');
    out = [];
    expect(await pane('--resume')).toBe(0);
    expect(out).toEqual([launcher()]);
    expect(readFileSync(frozen('skills', 'demo-kit', 'SKILL.md'), 'utf8')).not.toContain('v2');
    await pane();
    expect(readFileSync(frozen('skills', 'demo-kit', 'SKILL.md'), 'utf8')).toContain('v2');
  });

  it('prints nothing, and leaves no launcher, when nothing loads or the space has no skills', async () => {
    await pane();
    fake.memory = 'old';
    // Within 60 s a pane uses the last sync, as a chat turn does; a sync makes it current.
    await termag('space', 'memory', 'sync', 'team');
    out = [];
    expect(await pane()).toBe(0);
    expect(out).toEqual([]);
    expect(existsSync(launcher())).toBe(false);
    fake.memory = 'on';
    for (const k of [...fake.files.keys()]) if (k.startsWith('.termag/skills/')) fake.files.delete(k);
    await termag('space', 'memory', 'sync', 'team');
    out = [];
    expect(await pane()).toBe(0);
    expect(out).toEqual([]);
  });

  it('a resume of a pane that started with no skills stays without them', async () => {
    fake.memory = 'old';
    await pane();
    fake.memory = 'on';
    out = [];
    expect(await pane('--resume')).toBe(0);
    expect(out).toEqual([]);
  });

  it('never fails the launch: an unreachable orchestrator prints nothing; a bad key is refused', async () => {
    await fake.close();
    expect(await pane()).toBe(0);
    expect(out).toEqual([]);
    for (const bad of ['..', '../x', 'a/b', '']) expect(await termag('space', 'memory', 'pane-claude', '--key', bad)).toBe(2);
    expect(existsSync(join(home, 'agent.config.json'))).toBe(true);
  });
});

describe('no write or delete follows a symlink out of ~/.termag/spaces (Bugbot sweep 11, #770)', () => {
  /** A folder outside the spaces dir, with a file that must survive, and the link to it planted at `at`. */
  function plant(at: string, inside: string[] = []) {
    const outside = mkdtempSync(join(home, 'outside-'));
    for (const rel of inside) { mkdirSync(join(outside, rel), { recursive: true }); writeFileSync(join(outside, rel, 'keep.txt'), 'keep'); }
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    mkdirSync(join(home, '.termag', 'spaces'), { recursive: true });
    symlinkSync(outside, join(home, '.termag', 'spaces', at));
    return outside;
  }
  const untouched = (outside: string, inside: string[] = []) => {
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    for (const rel of inside) expect(readFileSync(join(outside, rel, 'keep.txt'), 'utf8')).toBe('keep');
    expect(readdirSync(outside).sort()).toEqual(['keep.txt', ...inside.map(r => r.split('/')[0])].sort());
  };

  it('.panes: pane-claude neither deletes nor writes through it', async () => {
    const outside = plant('.panes', ['p1--main']);
    out = [];
    expect(await termag('space', 'memory', 'pane-claude', '--key', 'p1--main')).toBe(0);
    expect(out).toEqual([]);
    untouched(outside, ['p1--main']);
  });

  it('.versions: space get downloads but writes no version through it', async () => {
    const outside = plant('.versions');
    await termag('space', 'get', 'team:.termag/prompt.md', join(home, 'p.md'));
    untouched(outside);
    expect(err.join('\n')).toMatch(/symlink/);
  });

  it('.sessions: a hook writes no session file through it', async () => {
    const outside = plant('.sessions');
    stdin = JSON.stringify({ session_id: 'abcdef12-3456' });
    await termag('space', 'memory', 'context', '--hook', 'SessionStart', '--refresh', '60s');
    untouched(outside);
  });

  it('default.json and a sync lock: never written through a planted link', async () => {
    const target = join(home, 'precious.txt');
    writeFileSync(target, 'precious');
    mkdirSync(join(home, '.termag', 'spaces'), { recursive: true });
    symlinkSync(target, join(home, '.termag', 'spaces', 'default.json'));
    symlinkSync(target, join(home, '.termag', 'spaces', '.team.lock'));
    await termag('space', 'memory', 'sync');
    await termag('space', 'memory', 'sync', 'team');
    expect(readFileSync(target, 'utf8')).toBe('precious');
  });

  it('a symlinked ~/.termag is refused too', async () => {
    const outside = mkdtempSync(join(home, 'outside-'));
    symlinkSync(outside, join(home, '.termag'));
    expect(await termag('space', 'memory', 'sync', 'team')).not.toBe(0);
    expect(readdirSync(outside)).toEqual([]);
  });

  it('an explicit --session file that is a symlink is refused', async () => {
    const target = join(home, 'precious.json');
    writeFileSync(target, '"precious"');
    symlinkSync(target, join(home, 's.json'));
    await termag('space', 'memory', 'context', 'team', '--session', join(home, 's.json'), '--refresh', '60s', '--json');
    expect(readFileSync(target, 'utf8')).toBe('"precious"');
  });
});

describe('the refresh falls back to the box default when the list call fails (Bugbot sweep 11, #770)', () => {
  it('a named space this box never synced, with the orchestrator out of reach, gets the cached default', async () => {
    // The box default (team) was synced and cached earlier.
    await termag('space', 'memory', 'sync');
    await fake.close();
    await termag('space', 'memory', 'context', 'elsewhere', '--session', join(home, 's.json'), '--refresh', '0s', '--json');
    expect(JSON.parse(out.at(-1)!)).toEqual(expect.objectContaining({ kind: 'start', space: 'team' }));
  });

  it('a named space it did sync keeps its own copy offline', async () => {
    await termag('space', 'memory', 'sync', 'team');
    await fake.close();
    await termag('space', 'memory', 'context', 'team', '--session', join(home, 's2.json'), '--refresh', '0s', '--json');
    expect(JSON.parse(out.at(-1)!)).toEqual(expect.objectContaining({ kind: 'start', space: 'team' }));
  });
});

describe('deleting a memory forgets its version (Bugbot sweep 14, #770)', () => {
  it('a space put of a path removed with memory rm is not refused as changed', async () => {
    stdin = 'A fact.\n';
    expect(await termag('space', 'memory', 'add', 'team', 'gone-soon', '--description', 'd')).toBe(0);
    expect(await termag('space', 'memory', 'rm', 'team', 'gone-soon')).toBe(0);
    writeFileSync(join(home, 'again.md'), memory('gone-soon', 'd', 'Back.\n'));
    expect(await termag('space', 'put', join(home, 'again.md'), 'team:.termag/memory/gone-soon.md')).toBe(0);
    expect(fake.files.get('.termag/memory/gone-soon.md')!.toString()).toContain('Back.');
  });

});
