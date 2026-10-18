import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from './context.js';
import type { Api } from './api.js';
import { findBox, parseProjectRef, startAndWait, waitForRunning } from './lifecycle.js';
import { run } from './main.js';
import { BOXES, startFakeOrchestrator, type FakeOrchestrator } from './test/fakeOrchestrator.js';

let home: string;
let orch: FakeOrchestrator;
let out: string[];
let err: string[];
let questions: string[];
let answer: boolean;

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    env: { TERMAG_URL: orch.host },
    home,
    hostname: 'zane-mbp.local',
    interactive: true,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    fetch: globalThis.fetch,
    openBrowser: (url) => { void fetch(url).catch(() => {}); },
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    loginTimeoutMs: 5000,
    confirm: async (q) => { questions.push(q); return answer; },
    pollIntervalMs: 5,
    ...overrides,
  };
}

const agentless = () => ctx({ interactive: false });
const stdout = () => out.join('\n');
const stderr = () => err.join('\n');
const lastJson = () => JSON.parse(out.at(-1)!);
const mutations = () => orch.lifecycle.calls.map(c => c.route);
const box = (name: string) => orch.lifecycle.boxes.find(b => b.name === name);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'termag-cli-lifecycle-'));
  orch = await startFakeOrchestrator();
  questions = [];
  answer = true;
  out = [];
  err = [];
  expect(await run(['login'], ctx())).toBe(0);
  out = [];
  err = [];
});

afterEach(async () => {
  await orch.close();
  rmSync(home, { recursive: true, force: true });
});

describe('termag box create', () => {
  it('creates the box and returns while it provisions', async () => {
    orch.lifecycle.provisionPolls = Infinity;
    expect(await run(['box', 'create', 'newbox'], ctx())).toBe(0);
    expect(stdout()).toContain('Creating box newbox (provisioning)');
    expect(orch.lifecycle.calls).toEqual([{ route: 'POST /boxes', body: { name: 'newbox' } }]);
  });

  it('--wait reports progress on stderr and ends running', async () => {
    orch.lifecycle.provisionPolls = 3;
    expect(await run(['box', 'create', 'newbox', '--wait'], ctx())).toBe(0);
    expect(stderr()).toMatch(/^newbox: provisioning \(\d+s\)$/m);
    expect(stdout()).toBe('Created box newbox; it is running.');
  });

  it('--wait --json prints only the final box', async () => {
    expect(await run(['box', 'create', 'newbox', '--wait', '--json'], ctx())).toBe(0);
    expect(err).toEqual([]);
    expect(lastJson()).toMatchObject({ box: { name: 'newbox', state: 'running', agentConnected: true }, created: true, claimed: false });
  });

  it('--wait fails with exit 1 when provisioning fails', async () => {
    orch.lifecycle.provisionOutcome = 'failed';
    expect(await run(['box', 'create', 'newbox', '--wait'], ctx())).toBe(1);
    expect(stderr()).toContain('Box newbox failed: RunInstances refused');
  });

  it('--wait times out with exit 5', async () => {
    orch.lifecycle.provisionPolls = Infinity;
    expect(await run(['box', 'create', 'newbox', '--wait', '--timeout', '0.05'], ctx())).toBe(5);
    expect(stderr()).toMatch(/Timed out after 0s waiting for newbox to be running \(it is provisioning\)/);
  });

  it('refuses names outside the rule before asking the orchestrator', async () => {
    expect(await run(['box', 'create', 'my box'], ctx())).toBe(2);
    expect(await run(['box', 'create', 'dev/box'], ctx())).toBe(2);
    expect(await run(['box', 'create'], ctx())).toBe(2);
    expect(await run(['box', 'create', 'x', '--timeout', 'soon'], ctx())).toBe(2);
    expect(mutations()).toEqual([]);
    expect(stderr()).toContain('letters, digits, - and _ only');
  });

  it('fails on an existing name, and --if-not-exists returns that box instead', async () => {
    expect(await run(['box', 'create', 'devbox'], ctx())).toBe(1);
    expect(stderr()).toContain('A box named "devbox" already exists');
    orch.lifecycle.calls = [];
    out = [];
    expect(await run(['box', 'create', 'devbox', '--if-not-exists', '--json'], ctx())).toBe(0);
    expect(lastJson()).toMatchObject({ box: { id: 'i1', name: 'devbox' }, created: false });
    expect(mutations()).toEqual([]);
  });

  it('refuses when GitHub is required, prints the server sentence, and does not wait', async () => {
    const sentence = 'Connect GitHub in Settings before adding a box';
    orch.override.set('/api/cli/v1/boxes', (res) => {
      res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: sentence, code: 'github-required' }));
    });
    const before = orch.requests.length;
    expect(await run(['box', 'create', 'newbox', '--wait'], ctx())).toBe(1);
    expect(stderr()).toContain(sentence);
    expect(orch.requests.slice(before).filter(r => r.method === 'GET')).toEqual([]);
    expect(orch.lifecycle.calls).toEqual([]);
    out = [];
    err = [];
    const again = orch.requests.length;
    expect(await run(['box', 'create', 'newbox', '--wait', '--json'], ctx())).toBe(1);
    expect(JSON.parse(err.at(-1)!)).toEqual({ error: { code: 'precondition', message: sentence } });
    expect(orch.requests.slice(again).filter(r => r.method === 'GET')).toEqual([]);
  });

  it('--if-not-exists survives losing a race to another create', async () => {
    let reads = 0;
    orch.override.set('/api/cli/v1/boxes', (res) => {
      // The first read misses the box; the POST then conflicts and the re-read finds it.
      if (reads++ === 0) { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"boxes":[]}'); return; }
      orch.override.delete('/api/cli/v1/boxes');
      res.writeHead(409, { 'Content-Type': 'application/json' }).end('{"error":"A box named \\"devbox\\" already exists"}');
    });
    expect(await run(['box', 'create', 'devbox', '--if-not-exists', '--json'], ctx())).toBe(0);
    expect(lastJson()).toMatchObject({ box: { id: 'i1' }, created: false });
  });
});

describe('termag box start and stop', () => {
  it('starts a stopped box addressed by id, and --wait sees it come up', async () => {
    expect(await run(['box', 'start', 'i2', '--wait'], ctx())).toBe(0);
    expect(mutations()).toEqual(['POST /boxes/i2/start']);
    expect(stderr()).toMatch(/old box: starting/);
    expect(stdout()).toBe('old box is running.');
  });

  it('--wait keeps renewing the access token while it polls', async () => {
    orch.accessTtlS = 30;
    const credsFile = join(home, '.config/termag/credentials.json');
    const creds = JSON.parse(readFileSync(credsFile, 'utf8'));
    creds.hosts[orch.host].accessTokenExpiresAt = new Date(Date.now() + 30_000).toISOString();
    writeFileSync(credsFile, JSON.stringify(creds));
    const refreshes = () => orch.requests.filter(r => r.method === 'POST' && r.path === '/api/cli/v1/token').length;
    const before = refreshes();
    expect(await run(['box', 'start', 'i2', '--wait'], ctx())).toBe(0);
    expect(refreshes()).toBeGreaterThan(before + 1);
    const stored = JSON.parse(readFileSync(credsFile, 'utf8')).hosts[orch.host];
    expect(orch.requests.at(-1)?.auth).toBe(`Bearer ${stored.accessToken}`);
  });

  it('--wait lets a hibernating box finish, then resumes it', async () => {
    orch.lifecycle.parkPolls = 3;
    Object.assign(box('devbox')!, { state: 'hibernating', status: 'hibernating', agentConnected: false });
    expect(await run(['box', 'start', 'devbox', '--wait'], ctx())).toBe(0);
    expect(mutations()).toEqual(['POST /boxes/i1/start']);
    expect(stderr()).toMatch(/devbox: hibernating, starting it once that finishes/);
    expect(stdout()).toBe('devbox is running.');
  });

  it('--wait lets a stopping box stop, and times out with the way to carry on', async () => {
    orch.lifecycle.parkPolls = Infinity;
    Object.assign(box('devbox')!, { state: 'stopping', status: 'stopping', agentConnected: false });
    expect(await run(['box', 'start', 'devbox', '--wait', '--timeout', '1'], ctx())).toBe(5);
    expect(stderr()).toContain('Timed out waiting for devbox to finish stopping; run `termag box start devbox --wait` again');
    expect(mutations()).toEqual([]);
  });

  it('without --wait, a box still parking is the orchestrator\'s refusal', async () => {
    orch.lifecycle.parkPolls = Infinity;
    Object.assign(box('devbox')!, { state: 'hibernating', status: 'hibernating', agentConnected: false });
    expect(await run(['box', 'start', 'devbox'], ctx())).not.toBe(0);
    expect(mutations()).toEqual(['POST /boxes/i1/start']);
  });

  it('leaves a running box alone', async () => {
    expect(await run(['box', 'start', 'devbox', '--json'], ctx())).toBe(0);
    expect(lastJson()).toMatchObject({ started: false, box: { state: 'running' } });
    expect(mutations()).toEqual([]);
  });

  it('stops a running box, and a second stop is a no-op', async () => {
    expect(await run(['box', 'stop', 'devbox'], ctx())).toBe(0);
    expect(stdout()).toContain('Stopping devbox; its disk and projects are kept.');
    expect(box('devbox')?.state).toBe('stopping');
    expect(await run(['box', 'stop', 'devbox'], ctx())).toBe(0);
    expect(mutations()).toEqual(['POST /boxes/i1/stop']);
  });

  it('--wait gives up on a box that stops instead', async () => {
    const seq = [{ ...BOXES[0], state: 'stopping', status: 'stopping', agentConnected: false }];
    const api = { request: async () => ({ boxes: seq }) } as unknown as Api;
    const starting = { ...BOXES[0], state: 'starting', status: 'starting', agentConnected: false };
    await expect(waitForRunning(ctx(), api, starting, 60, true)).rejects.toThrow('devbox is stopping');
  });

  it('--wait gives the start its own time after a long hibernate', async () => {
    const t0 = Date.now();
    let startedAt = 0;
    const state = () => {
      if (!startedAt) return Date.now() - t0 < 1900 ? 'hibernating' : 'hibernated';
      return Date.now() - startedAt < 1200 ? 'starting' : 'running';
    };
    const view = () => ({ ...BOXES[0], state: state(), status: state(), agentConnected: state() === 'running' });
    const api = {
      request: async (method: string) => {
        if (method === 'POST') { startedAt = Date.now(); return { box: view() }; }
        return { boxes: [view()] };
      },
    } as unknown as Api;
    const hibernating = { ...BOXES[0], state: 'hibernating', status: 'hibernating', agentConnected: false };
    await expect(startAndWait(ctx(), api, hibernating, 2, true)).resolves.toMatchObject({ started: true, box: { state: 'running' } });
  });

  it('leaves a hibernated box alone on stop', async () => {
    Object.assign(box('devbox')!, { state: 'hibernated', status: 'hibernated', agentConnected: false });
    expect(await run(['box', 'stop', 'devbox', '--json'], ctx())).toBe(0);
    expect(lastJson()).toMatchObject({ stopped: false, box: { state: 'hibernated' } });
    expect(mutations()).toEqual([]);
  });

  it('--wait gives up on a box that hibernates instead', async () => {
    const seq = [{ ...BOXES[0], state: 'hibernating', status: 'hibernating', agentConnected: false }];
    const api = { request: async () => ({ boxes: seq }) } as unknown as Api;
    const starting = { ...BOXES[0], state: 'starting', status: 'starting', agentConnected: false };
    await expect(waitForRunning(ctx(), api, starting, 60, true)).rejects.toThrow('devbox is hibernating');
  });

  it('exits 3 for an unknown box and 2 for a project reference', async () => {
    expect(await run(['box', 'stop', 'nope'], ctx())).toBe(3);
    expect(stderr()).toContain('No box named "nope"');
    expect(await run(['box', 'stop', 'devbox/webapp-fix'], ctx())).toBe(2);
  });
});

describe('termag box rm', () => {
  it('needs --yes when no terminal is attached', async () => {
    expect(await run(['box', 'rm', 'devbox'], agentless())).toBe(2);
    expect(stderr()).toContain('pass --yes');
    expect(questions).toEqual([]);
    expect(mutations()).toEqual([]);
  });

  it('asks first, naming the projects it will archive', async () => {
    answer = false;
    expect(await run(['box', 'rm', 'devbox'], ctx())).toBe(1);
    expect(questions).toEqual(['Terminate devbox and archive its projects (webapp-fix, flaky-test)? [y/N] ']);
    expect(mutations()).toEqual([]);
    answer = true;
    expect(await run(['box', 'rm', 'devbox'], ctx())).toBe(0);
    expect(orch.lifecycle.calls).toEqual([{ route: 'DELETE /boxes/i1', body: { confirmed: true } }]);
    expect(stdout()).toContain('Terminated devbox and archived 2 project(s).');
  });

  it('--yes skips the question', async () => {
    expect(await run(['box', 'terminate', 'devbox', '--yes', '--json'], agentless())).toBe(0);
    expect(questions).toEqual([]);
    expect(lastJson()).toEqual({ box: { id: 'i1', name: 'devbox' }, terminated: true, archivedProjects: 2 });
  });

  it("refuses a box's own credentials", async () => {
    orch.boxTokens.add('tmag_box');
    writeAgentConfig(orch.host.replace(/^http/, 'ws') + '/ws/agent', 'tmag_box');
    const onBox = ctx({ env: {}, home: boxHome });
    expect(await run(['box', 'rm', 'devbox', '--yes'], onBox)).toBe(1);
    expect(stderr()).toContain("box's own credentials can't terminate boxes");
    expect(box('devbox')).toBeDefined();
  });
});

describe('termag project create', () => {
  it('creates the project with its agent', async () => {
    expect(await run(['project', 'create', 'devbox/new', '--agent', 'claude'], ctx())).toBe(0);
    expect(orch.lifecycle.calls).toEqual([{ route: 'POST /projects', body: { boxId: 'i1', name: 'new', agent: 'claude' } }]);
    expect(stdout()).toBe('Created devbox/new (claude).');
  });

  it('checks its arguments before asking the orchestrator', async () => {
    expect(await run(['project', 'create', 'devbox/new'], ctx())).toBe(2);
    expect(stderr()).toContain('--agent is required');
    expect(await run(['project', 'create', 'new', '--agent', 'claude'], ctx())).toBe(2);
    expect(await run(['project', 'create', 'devbox/a/b', '--agent', 'claude'], ctx())).toBe(2);
    expect(await run(['project', 'create', 'devbox/no.dots', '--agent', 'claude'], ctx())).toBe(2);
    expect(mutations()).toEqual([]);
    expect(await run(['project', 'create', 'nobox/new', '--agent', 'claude'], ctx())).toBe(3);
  });

  it('--if-not-exists returns the existing project', async () => {
    expect(await run(['project', 'create', 'devbox/flaky-test', '--agent', 'claude'], ctx())).toBe(1);
    out = [];
    expect(await run(['project', 'create', 'devbox/flaky-test', '--agent', 'claude', '--if-not-exists', '--json'], ctx())).toBe(0);
    expect(lastJson()).toMatchObject({ project: { ref: 'devbox/flaky-test', provider: 'codex' }, created: false });
    expect(mutations()).toEqual(['POST /projects']);
  });

  it('works with the box credentials, with no login', async () => {
    orch.boxTokens.add('tmag_box');
    writeAgentConfig(orch.host.replace(/^http/, 'ws') + '/ws/agent', 'tmag_box');
    expect(await run(['project', 'create', 'devbox/from-box', '--agent', 'claude'], ctx({ env: {}, home: boxHome }))).toBe(0);
    expect(orch.requests.at(-1)?.auth).toBe('Bearer tmag_box');
  });
});

describe('termag project create --from', () => {
  it('sends a template name and says what the agent pane clones', async () => {
    expect(await run(['project', 'create', 'devbox/g', '--agent', 'claude', '--from', 'webapp'], ctx())).toBe(0);
    expect(orch.lifecycle.calls).toEqual([{ route: 'POST /projects', body: { boxId: 'i1', name: 'g', agent: 'claude', from: 'webapp' } }]);
    expect(stdout()).toBe('Created devbox/g (claude); its agent pane clones https://github.com/example-org/webapp.git first.');
    expect(err).toEqual([]);
  });

  it('takes a GitHub URL and reports it in --json', async () => {
    expect(await run(['project', 'create', 'devbox/r', '--agent', 'claude', '--from', 'git@github.com:o/r.git', '--json'], ctx())).toBe(0);
    expect(lastJson()).toMatchObject({ project: { ref: 'devbox/r' }, created: true, repoUrl: 'git@github.com:o/r.git' });
  });

  it("passes on the orchestrator's refusal of anything else", async () => {
    expect(await run(['project', 'create', 'devbox/x', '--agent', 'claude', '--from', 'gonflaon'], ctx())).toBe(2);
    expect(stderr()).toContain('webapp, research');
    expect(await run(['project', 'create', 'devbox/x', '--agent', 'claude', '--from', ' '], ctx())).toBe(2);
    expect(orch.lifecycle.calls).toHaveLength(1);
  });

  it('warns when an orchestrator from before --from ignores it', async () => {
    orch.override.set('/api/cli/v1/projects', (res) => {
      const project = { id: 'p-old', name: 'old', ref: 'devbox/old', box: { id: 'i1', name: 'devbox' }, provider: 'claude' };
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ project, restored: false }));
    });
    expect(await run(['project', 'create', 'devbox/old', '--agent', 'claude', '--from', 'webapp'], ctx())).toBe(0);
    expect(stderr()).toBe('termag: the orchestrator ignored --from (it predates it); devbox/old starts empty.');
  });
});

describe('termag project create --new-box', () => {
  it('creates the box, the project on it while it provisions, then waits for the box', async () => {
    orch.lifecycle.provisionPolls = 3;
    expect(await run(['project', 'create', 'newbox/app', '--new-box', '--agent', 'claude', '--from', 'research'], ctx())).toBe(0);
    expect(orch.lifecycle.calls).toEqual([
      { route: 'POST /boxes', body: { name: 'newbox' } },
      { route: 'POST /projects', body: { boxId: 'i-newbox', name: 'app', agent: 'claude', from: 'research' } },
    ]);
    expect(stderr()).toContain('Created box newbox; newbox/app is set up on it once it is running.');
    expect(stderr()).toMatch(/^newbox: provisioning \(\d+s\)$/m);
    expect(stdout()).toBe('Created box newbox. Created newbox/app (claude); its agent pane clones https://github.com/example-org/research.git first.');
    expect(orch.lifecycle.projects.map(p => p.ref)).toContain('newbox/app');
  });

  it('--json prints the box and the project, and nothing on stderr', async () => {
    expect(await run(['project', 'create', 'newbox/app', '--new-box', '--agent', 'claude', '--json'], ctx())).toBe(0);
    expect(err).toEqual([]);
    expect(lastJson()).toMatchObject({
      box: { name: 'newbox', state: 'running', agentConnected: true }, boxCreated: true, claimed: false,
      project: { ref: 'newbox/app', provider: 'claude' }, created: true, repoUrl: null,
    });
  });

  it('fails on an existing box name, and --if-not-exists uses that box and project', async () => {
    expect(await run(['project', 'create', 'devbox/fresh', '--new-box', '--agent', 'claude'], ctx())).toBe(1);
    expect(stderr()).toContain('A box named "devbox" already exists');
    expect(mutations()).toEqual(['POST /boxes']);
    orch.lifecycle.calls = [];
    out = [];
    expect(await run(['project', 'create', 'devbox/flaky-test', '--new-box', '--agent', 'claude', '--if-not-exists', '--json'], ctx())).toBe(0);
    expect(lastJson()).toMatchObject({ box: { id: 'i1' }, boxCreated: false, project: { ref: 'devbox/flaky-test' }, created: false });
    expect(mutations()).toEqual([]);
  });

  it('a timeout leaves the project with the orchestrator, and a re-run with --if-not-exists picks both up', async () => {
    orch.lifecycle.provisionPolls = Infinity;
    expect(await run(['project', 'create', 'newbox/app', '--new-box', '--agent', 'claude', '--timeout', '0.05'], ctx())).toBe(5);
    expect(stderr()).toContain('waiting for newbox to be running (it is provisioning)');
    expect(mutations()).toEqual(['POST /boxes', 'POST /projects']);
    Object.assign(box('newbox')!, { state: 'running', status: 'ready', agentConnected: true });
    out = [];
    expect(await run(['project', 'create', 'newbox/app', '--new-box', '--agent', 'claude', '--if-not-exists'], ctx())).toBe(0);
    expect(mutations()).toEqual(['POST /boxes', 'POST /projects']);
    expect(stdout()).toBe('newbox/app already exists (claude).');
  });

  it('waits for the box before the project on an orchestrator that predates waiting projects', async () => {
    orch.lifecycle.projectWaitsForBox = false;
    orch.lifecycle.provisionPolls = 2;
    expect(await run(['project', 'create', 'newbox/app', '--new-box', '--agent', 'claude'], ctx())).toBe(0);
    expect(mutations()).toEqual(['POST /boxes', 'POST /projects', 'POST /projects']);
    expect(stdout()).toBe('Created box newbox. Created newbox/app (claude).');
  });

  it('says the project waits on a box that fails to provision, and how to recover it', async () => {
    orch.lifecycle.provisionOutcome = 'failed';
    expect(await run(['project', 'create', 'newbox/app', '--new-box', '--agent', 'claude'], ctx())).toBe(1);
    expect(stderr()).toContain('Box newbox failed: RunInstances refused. newbox/app waits on it: Retry on the project in the web UI launches a new box.');
    expect(mutations()).toEqual(['POST /boxes', 'POST /projects']);
  });

  it('says the box is kept and how to retry when the project is refused', async () => {
    expect(await run(['project', 'create', 'newbox/app', '--new-box', '--agent', 'claude', '--from', 'nope'], ctx())).toBe(2);
    expect(stderr()).toContain('Box newbox is still being created, but the project was not created: from must be a template');
    expect(stderr()).toContain('Retry with `termag project create newbox/app --agent claude --from nope`');
    expect(box('newbox')).toBeDefined();
  });

  it('checks its arguments before creating anything', async () => {
    expect(await run(['project', 'create', 'app', '--new-box', '--agent', 'claude'], ctx())).toBe(2);
    expect(await run(['project', 'create', 'new.box/app', '--new-box', '--agent', 'claude'], ctx())).toBe(2);
    expect(await run(['project', 'create', 'newbox/app', '--new-box'], ctx())).toBe(2);
    expect(await run(['project', 'create', 'newbox/app', '--new-box', '--agent', 'claude', '--timeout', 'soon'], ctx())).toBe(2);
    expect(await run(['project', 'create', 'devbox/app', '--agent', 'claude', '--timeout', '60'], ctx())).toBe(2);
    expect(stderr()).toContain('--timeout goes with --new-box');
    expect(mutations()).toEqual([]);
  });
});

describe('termag project rename and archive', () => {
  it('renames a project on its box', async () => {
    expect(await run(['project', 'rename', 'devbox/webapp-fix', 'webapp-fix-2'], ctx())).toBe(0);
    expect(stdout()).toBe('Renamed devbox/webapp-fix to devbox/webapp-fix-2.');
    expect(await run(['project', 'mv', 'devbox/webapp-fix-2', 'devbox/fix', '--json'], ctx())).toBe(0);
    expect(lastJson()).toMatchObject({ project: { ref: 'devbox/fix' }, renamedFrom: 'devbox/webapp-fix-2' });
  });

  it('refuses moving to another box, bad names and unknown projects', async () => {
    expect(await run(['project', 'rename', 'devbox/webapp-fix', 'otherbox/x'], ctx())).toBe(2);
    expect(await run(['project', 'rename', 'devbox/webapp-fix', 'has space'], ctx())).toBe(2);
    expect(await run(['project', 'rename', 'devbox/webapp-fix'], ctx())).toBe(2);
    expect(await run(['project', 'rename', 'devbox/nope', 'x'], ctx())).toBe(3);
    expect(mutations()).toEqual([]);
  });

  it('archives with --yes, and needs it without a terminal', async () => {
    expect(await run(['project', 'archive', 'devbox/flaky-test'], agentless())).toBe(2);
    expect(mutations()).toEqual([]);
    expect(await run(['project', 'archive', 'devbox/flaky-test', '--yes'], agentless())).toBe(0);
    expect(stdout()).toContain('Archived devbox/flaky-test.');
    expect(orch.lifecycle.projects.map(p => p.ref)).toEqual(['devbox/webapp-fix']);
  });

  it('asks before archiving at a terminal', async () => {
    expect(await run(['project', 'archive', 'devbox/flaky-test'], ctx())).toBe(0);
    expect(questions).toEqual(['Archive devbox/flaky-test? [y/N] ']);
  });
});

describe('termag box set --auto-park', () => {
  it('sets the hours and turns it off', async () => {
    expect(await run(['box', 'set', 'devbox', '--auto-park', '1h'], ctx())).toBe(0);
    expect(stdout()).toBe('devbox hibernates after 1 h idle.');
    expect(await run(['box', 'set', 'devbox', '--auto-park', 'off'], ctx())).toBe(0);
    expect(out.at(-1)).toBe('Auto-park is off for devbox.');
    expect(orch.lifecycle.calls).toEqual([
      { route: 'PATCH /boxes/i1/lifecycle', body: { idleHibernateHours: 1 } },
      { route: 'PATCH /boxes/i1/lifecycle', body: { idleHibernateHours: null } },
    ]);
    expect(err).toEqual([]);
  });

  it('warns on a box that cannot hibernate, and still succeeds', async () => {
    orch.lifecycle.cannotHibernate.add('i1');
    expect(await run(['box', 'set', 'devbox', '--auto-park', '4'], ctx())).toBe(0);
    expect(stderr()).toMatch(/^Warning: .*can't hibernate/);
    expect(stdout()).toBe('devbox hibernates after 4 h idle.');
  });

  it('--json carries the warning in the lifecycle', async () => {
    orch.lifecycle.cannotHibernate.add('i1');
    expect(await run(['box', 'set', 'devbox', '--auto-park', '2h', '--json'], ctx())).toBe(0);
    expect(err).toEqual([]);
    expect(lastJson()).toMatchObject({ box: { id: 'i1', name: 'devbox' }, lifecycle: { idleHibernateHours: 2, warning: expect.stringContaining("can't hibernate") } });
  });

  it('refuses a missing or malformed value before calling the orchestrator', async () => {
    expect(await run(['box', 'set', 'devbox'], ctx())).not.toBe(0);
    expect(await run(['box', 'set', 'devbox', '--auto-park', 'soon'], ctx())).not.toBe(0);
    expect(await run(['box', 'set', 'devbox', '--auto-park', '1d'], ctx())).not.toBe(0);
    expect(await run(['box', 'set', 'devbox', '--terminate-after', '2h'], ctx())).not.toBe(0);
    expect(mutations()).toEqual([]);
  });
});

describe('termag box set --terminate-after', () => {
  it('sends only the settings given', async () => {
    expect(await run(['box', 'set', 'devbox', '--terminate-after', '7d'], ctx())).toBe(0);
    expect(stdout()).toMatch(/^devbox is terminated after 7 days hibernated/);
    expect(await run(['box', 'set', 'devbox', '--terminate-after', 'off', '--auto-park', '1'], ctx())).toBe(0);
    expect(out.slice(-2)).toEqual(['devbox hibernates after 1 h idle.', 'devbox is never terminated automatically.']);
    expect(orch.lifecycle.calls).toEqual([
      { route: 'PATCH /boxes/i1/lifecycle', body: { hibernatedTerminateDays: 7 } },
      { route: 'PATCH /boxes/i1/lifecycle', body: { idleHibernateHours: 1, hibernatedTerminateDays: null } },
    ]);
    expect(err).toEqual([]);
  });

  it('warns on a box that cannot hibernate, and still succeeds', async () => {
    orch.lifecycle.cannotHibernate.add('i1');
    expect(await run(['box', 'set', 'devbox', '--terminate-after', '1', '--json'], ctx())).toBe(0);
    expect(lastJson()).toMatchObject({ lifecycle: { hibernatedTerminateDays: 1, warning: expect.stringContaining("can't hibernate") } });
  });
});

describe('helpers and help', () => {
  it('parses <box>/<project> strictly', () => {
    expect(parseProjectRef('devbox/fix')).toEqual({ box: 'devbox', project: 'fix' });
    for (const bad of ['devbox', '/fix', 'devbox/', 'a/b/c']) expect(() => parseProjectRef(bad)).toThrow();
  });

  it('finds a box by name before id', () => {
    const boxes = [{ id: 'devbox', name: 'other' }, { id: 'i1', name: 'devbox' }] as Parameters<typeof findBox>[0];
    expect(findBox(boxes, 'devbox')?.id).toBe('i1');
    expect(findBox(boxes, 'other')?.id).toBe('devbox');
  });

  it('lists the lifecycle commands in --help', async () => {
    expect(await run(['--help'], ctx())).toBe(0);
    for (const c of ['box create', 'box start', 'box stop', 'box set', 'box rm', 'project create', 'project rename', 'project archive']) {
      expect(stdout()).toContain(c);
    }
  });
});

let boxHome: string;
beforeEach(() => { boxHome = join(home, 'box-home'); });

function writeAgentConfig(termagUrl: string, token: string): void {
  const dir = join(boxHome, 'src', 'termag', 'agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.config.json'), JSON.stringify({ termag_url: termagUrl, token }));
}
