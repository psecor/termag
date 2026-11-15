import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import { run } from '../main.js';

// `termag preview run` against a fake agent socket: what it asks, how it
// follows the log, and how it names what the sandbox refused.
let dir: string;
let runtime: string;
let logPath: string;
let server: Server;
let asked: Array<Record<string, unknown>>;
let out: string[];
let err: string[];
let statuses: Array<Record<string, unknown>>;
let interrupt: () => void;

function fakeAgent(answer: (req: Record<string, unknown>) => unknown): Promise<void> {
  mkdirSync(join(runtime, 'termag'), { recursive: true });
  server = createServer((sock) => {
    let buf = '';
    sock.on('data', (b) => {
      buf += b;
      if (!buf.includes('\n')) return;
      const req = JSON.parse(buf);
      asked.push(req);
      sock.end(`${JSON.stringify(answer(req))}\n`);
    });
  });
  return new Promise(res => server.listen(join(runtime, 'termag', 'agent.sock'), () => res()));
}

function ctx(over: Partial<Ctx> = {}): Ctx {
  return {
    env: { XDG_RUNTIME_DIR: runtime, TERMAG_URL: 'http://127.0.0.1:1' },
    home: dir,
    hostname: 'box',
    interactive: false,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    fetch: globalThis.fetch,
    openBrowser: () => {},
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    pollIntervalMs: 5,
    cwd: () => join(dir, 'app', 'src'),
    exec: async (cmd, args) => (cmd === 'git' && args.includes('--show-toplevel') && args[1].startsWith(join(dir, 'app'))
      ? { code: 0, stdout: `${join(dir, 'app')}\n`, stderr: '' }
      : { code: 128, stdout: '', stderr: 'not a git repository' }),
    untilInterrupted: () => new Promise<void>(res => { interrupt = res; }),
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termag-cli-run-'));
  runtime = join(dir, 'run');
  logPath = join(dir, 'r.log');
  mkdirSync(join(dir, 'app', 'src'), { recursive: true });
  writeFileSync(logPath, '');
  asked = [];
  out = [];
  err = [];
  statuses = [];
});

afterEach(async () => {
  await new Promise(res => server ? server.close(() => res(undefined)) : res(undefined));
  rmSync(dir, { recursive: true, force: true });
});

describe('termag preview run', () => {
  it('asks the agent to run the command for the checkout holding the working directory, follows the log, and names what the sandbox refused', async () => {
    let polls = 0;
    await fakeAgent((req) => {
      if (req.op === 'preview-run') {
        appendFileSync(logPath, 'termag-preview: TCP connections to port 80 are refused (EACCES) in this sandbox\nVITE ready\n');
        return { id: 'abcdef012345', pid: 42, checkout: join(dir, 'app'), logPath };
      }
      polls++;
      if (polls < 3) return { run: { id: 'abcdef012345', state: 'running', diagnosis: [] } };
      appendFileSync(logPath, 'Error: connect EACCES 93.184.215.14:80\n');
      const s = { id: 'abcdef012345', state: 'ended', exit: 1, diagnosis: [{ code: 'port80_refused', targets: ['93.184.215.14'], message: "The app's connection to port 80 (93.184.215.14) was refused: … Use https or another port." }] };
      statuses.push(s);
      return { run: s };
    });
    expect(await run(['preview', 'run', '--port', '5173', '--', 'npx', 'vite', '--port', '5173'], ctx())).toBe(1);
    expect(asked[0]).toEqual({ op: 'preview-run', checkout: join(dir, 'app'), command: ['npx', 'vite', '--port', '5173'], port: 5173 });
    expect(asked.slice(1).every(a => a.op === 'preview-status' && a.id === 'abcdef012345')).toBe(true);
    expect(out.join('\n')).toContain('VITE ready');
    expect(out.join('\n')).toContain('connect EACCES 93.184.215.14:80');
    expect(err[0]).toBe(`termag preview run: abcdef012345 started, confined to a copy of ${join(dir, 'app')} (log ${logPath}). Ctrl-C stops it.`);
    expect(err).toContain("termag preview run: The app's connection to port 80 (93.184.215.14) was refused: … Use https or another port.");
    expect(err.at(-1)).toBe('termag preview run: abcdef012345 ended (1).');
  });

  it('prints the whole end of a long log, past one read (Devin, #1520)', async () => {
    await fakeAgent((req) => {
      if (req.op === 'preview-run') return { id: 'abcdef012345', pid: 42, checkout: join(dir, 'app'), logPath };
      appendFileSync(logPath, `${'x'.repeat(1_500_000)}\nTHE LAST LINE\n`);
      return { run: { id: 'abcdef012345', state: 'ended', exit: 1, diagnosis: [] } };
    });
    expect(await run(['preview', 'run', '--', 'npm', 'run', 'build'], ctx())).toBe(1);
    expect(out.join('\n')).toContain('THE LAST LINE');
  });

  it('Ctrl-C stops the run and exits cleanly', async () => {
    let stopped = false;
    await fakeAgent((req) => {
      if (req.op === 'preview-run') return { id: 'abcdef012345', pid: 42, checkout: join(dir, 'app'), logPath };
      if (req.op === 'preview-stop') { stopped = true; return { stopped: true }; }
      if (!stopped) setTimeout(() => interrupt(), 1);
      return { run: { id: 'abcdef012345', state: stopped ? 'ended' : 'running', exit: stopped ? 'stopped' : undefined, diagnosis: [] } };
    });
    expect(await run(['preview', 'run', '--', 'npm', 'run', 'dev'], ctx())).toBe(0);
    expect(asked.map(a => a.op)).toContain('preview-stop');
    expect(err.at(-1)).toBe('termag preview run: abcdef012345 ended (stopped).');
  });

  it('a Ctrl-C while the run is still starting stops it once it is up (Bugbot, #1520)', async () => {
    let stopped = false;
    await fakeAgent((req) => {
      if (req.op === 'preview-run') { interrupt(); return { id: 'abcdef012345', pid: 42, checkout: join(dir, 'app'), logPath }; }
      if (req.op === 'preview-stop') { stopped = true; return { stopped: true }; }
      return { run: { id: 'abcdef012345', state: stopped ? 'ended' : 'running', exit: stopped ? 'stopped' : undefined, diagnosis: [] } };
    });
    expect(await run(['preview', 'run', '--', 'npm', 'run', 'dev'], ctx())).toBe(0);
    expect(stopped).toBe(true);
  });

  it('says the run ended when the agent goes away mid-run, instead of failing on the socket (Bugbot, #1520)', async () => {
    let polls = 0;
    await fakeAgent((req) => {
      if (req.op === 'preview-run') return { id: 'abcdef012345', pid: 42, checkout: join(dir, 'app'), logPath };
      if (++polls === 2) setTimeout(() => server.close(), 0);
      return { run: { id: 'abcdef012345', state: 'running', diagnosis: [] } };
    });
    expect(await run(['preview', 'run', '--', 'npm', 'run', 'dev'], ctx())).toBe(1);
    expect(err.join('\n')).toContain("abcdef012345 ended: the box's agent stopped");
  });

  it('a live agent that keeps failing to answer about the run gets it stopped, not abandoned (Bugbot, #1520)', async () => {
    let stopped = false;
    await fakeAgent((req) => {
      if (req.op === 'preview-run') return { id: 'abcdef012345', pid: 42, checkout: join(dir, 'app'), logPath };
      if (req.op === 'preview-stop') { stopped = true; return { stopped: true }; }
      return { error: 'could not read the caller (peercred)' };
    });
    expect(await run(['preview', 'run', '--', 'npm', 'run', 'dev'], ctx())).toBe(1);
    expect(stopped).toBe(true);
    expect(err.join('\n')).toContain('Stopped abcdef012345: the agent stopped answering about it');
  });

  it('a stop the agent refuses too isn\'t reported as done; a log printed while failing isn\'t printed twice (Devin, #1520)', async () => {
    await fakeAgent((req) => {
      if (req.op === 'preview-run') return { id: 'abcdef012345', pid: 42, checkout: join(dir, 'app'), logPath };
      appendFileSync(logPath, `line ${asked.length}\n`);
      return { error: 'could not read the caller (peercred)' };
    });
    expect(await run(['preview', 'run', '--', 'npm', 'run', 'dev'], ctx())).toBe(1);
    expect(err.join('\n')).toContain('abcdef012345 may still be running');
    expect(err.join('\n')).not.toContain('Stopped abcdef012345');
    const lines = out.join('\n').split('\n').filter(l => l.startsWith('line '));
    expect(lines).toEqual([...new Set(lines)]);
  });

  // termag preview run is a box's (Linux): what a connect to a leftover file answers differs on macOS.
  it.skipIf(process.platform !== 'linux')('a socket file a dead agent left counts as the agent gone, not as one that won\'t answer (Devin, #1520)', async () => {
    let polls = 0;
    await fakeAgent((req) => {
      if (req.op === 'preview-run') return { id: 'abcdef012345', pid: 42, checkout: join(dir, 'app'), logPath };
      // The agent dies without unlinking its socket: connections are refused while the file stays.
      if (++polls === 2) setTimeout(() => server.close(() => writeFileSync(join(runtime, 'termag', 'agent.sock'), '')), 0);
      return { run: { id: 'abcdef012345', state: 'running', diagnosis: [] } };
    });
    expect(await run(['preview', 'run', '--', 'npm', 'run', 'dev'], ctx())).toBe(1);
    expect(err.join('\n')).toContain("abcdef012345 ended: the box's agent stopped");
  });

  it('says what the agent refused, and when no agent answers', async () => {
    await fakeAgent(() => ({ error: '/usr/local/bin/termag-preview isn\'t on this box: its image predates termag preview run' }));
    expect(await run(['preview', 'run', '--', 'npm', 'start'], ctx())).toBe(1);
    expect(err.join('\n')).toContain("its image predates termag preview run");
    await new Promise(res => server.close(() => res(undefined)));
    err = [];
    expect(await run(['preview', 'run', '--', 'npm', 'start'], ctx())).toBe(1);
    expect(err.join('\n')).toContain('No termag agent answers at');
  });

  // Pinning (the 5a merge follow-up): a box whose image predates the launcher refuses every confined run, and the CLI
  // says so plainly, naming the refusal, whatever the agent's own wording.
  it('a box without the launcher: the plain message, and the refusal named', async () => {
    await fakeAgent(() => ({ error: 'whatever the agent says', code: 'launcher_missing' }));
    expect(await run(['preview', 'run', '--', 'npm', 'start'], ctx())).toBe(1);
    const said = err.join('\n');
    expect(said).toContain("This box's image predates the preview launcher. Update or recreate the box, then try again.");
    expect(said).toContain('termag preview run refused: launcher_missing');
    expect(said).not.toContain('whatever the agent says');
    // With --json, the refusal's name is a field of its own (Devin, #1520).
    err = [];
    expect(await run(['preview', 'run', '--json', '--', 'npm', 'start'], ctx())).toBe(1);
    expect(JSON.parse(err.join('\n'))).toMatchObject({ error: { code: 'failed', refusal: 'launcher_missing' } });
    // Any other named refusal keeps the agent's words and its name.
    await new Promise(res => server.close(() => res(undefined)));
    err = [];
    await fakeAgent(() => ({ error: "this kernel's Landlock (ABI 3) can't confine a run: it needs ABI 4", code: 'landlock_too_old' }));
    expect(await run(['preview', 'run', '--', 'npm', 'start'], ctx())).toBe(1);
    expect(err.join('\n')).toMatch(/needs ABI 4\n\(termag preview run refused: landlock_too_old\)/);
  });

  it('a multi-repository workstream root needs --repo, which must be one of its repositories', async () => {
    await fakeAgent((req) => req.op === 'preview-run'
      ? { id: 'abcdef012345', pid: 1, checkout: req.checkout, logPath }
      : { run: { id: 'abcdef012345', state: 'ended', exit: 0, diagnosis: [] } });
    const root = join(dir, 'ws');
    for (const r of ['api', 'web']) mkdirSync(join(root, r, '.git'), { recursive: true });
    const c = ctx({ cwd: () => root });
    expect(await run(['preview', 'run', '--', 'npm', 'start'], c)).toBe(2);
    expect(err.join('\n')).toContain('name one with --repo: api, web');
    expect(await run(['preview', 'run', '--repo', '../app', '--', 'npm', 'start'], c)).toBe(2);
    expect(await run(['preview', 'run', '--repo', 'web', '--', 'npm', 'start'], c)).toBe(0);
    expect(asked.find(a => a.op === 'preview-run')?.checkout).toBe(join(root, 'web'));
  });

  it('--allow sends the declared ports and prints what the run may reach', async () => {
    await fakeAgent((req) => req.op === 'preview-run'
      ? { id: 'abcdef012345', pid: 1, checkout: req.checkout, logPath, allowed: [443, 3001, 5432] }
      : { run: { id: 'abcdef012345', state: 'ended', exit: 0, diagnosis: [] } });
    expect(await run(['preview', 'run', '--allow', '5432,3001', '--', 'npm', 'run', 'dev'], ctx())).toBe(0);
    expect(asked[0]).toMatchObject({ op: 'preview-run', allow: [5432, 3001] });
    expect(err[1]).toBe('termag preview run: TCP connects reach only ports 443, 3001, 5432.');
    asked = [];
    expect(await run(['preview', 'run', '--allow', '3001,x', '--', 'npm', 'run', 'dev'], ctx())).toBe(2);
    expect(asked).toEqual([]);
  });

  it('needs a command and a valid port', async () => {
    await fakeAgent(() => ({ error: 'not reached' }));
    expect(await run(['preview', 'run'], ctx())).toBe(2);
    expect(await run(['preview', 'run', '--port', '0', '--', 'vite'], ctx())).toBe(2);
    expect(asked).toEqual([]);
  });
});
