import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from './context.js';
import type { ExecResult } from './system.js';
import { saveLogin } from './credentials.js';
import { run } from './main.js';
import { startFakeOrchestrator, type FakeOrchestrator } from './test/fakeOrchestrator.js';

const GH_TOKEN = 'gho_' + 'S3cr3t'.repeat(6);

function ed25519Line(comment: string): string {
  const raw = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const str = (b: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(b.length); return Buffer.concat([len, b]); };
  return `ssh-ed25519 ${Buffer.concat([str(Buffer.from('ssh-ed25519')), str(raw)]).toString('base64')} ${comment}`;
}

/** The laptop's programs, as `termag doctor` sees them. */
interface Machine {
  installed: Set<string>;
  ghToken: string | null;
  ghLogin: string;
  orgs: Record<string, 'member' | 'sso' | 'none'>;
  awsSession: boolean;
  calls: string[];
  interactive: string[];
}

let home: string;
let orch: FakeOrchestrator;
let m: Machine;
let out: string[];
let err: string[];
let questions: string[];
let answers: string[];

function exec(cmd: string, args: string[]): Promise<ExecResult> {
  const line = [cmd, ...args].join(' ');
  m.calls.push(line);
  const r = (code: number, stdout = '', stderr = ''): Promise<ExecResult> => Promise.resolve({ code, stdout, stderr });
  if (!m.installed.has(cmd)) return r(127);
  if (line === 'gh auth token') return m.ghToken ? r(0, m.ghToken + '\n') : r(1, '', 'no oauth token found for github.com');
  if (line === 'gh api user --jq .login') return r(0, m.ghLogin + '\n');
  const org = /^gh api --include user\/memberships\/orgs\/(.+)$/.exec(line)?.[1];
  if (org) {
    const state = m.orgs[org] ?? 'none';
    if (state === 'member') return r(0, 'HTTP/2.0 200 OK\nContent-Type: application/json\n\n{"state":"active"}');
    if (state === 'sso') {
      return r(1, `HTTP/2.0 403 Forbidden\nX-Github-Sso: required; url=https://github.com/orgs/${org}/sso?authorization_request=r1\n\n{}`);
    }
    return r(1, 'HTTP/2.0 404 Not Found\n\n{}');
  }
  if (line === 'session-manager-plugin --version') return r(0, '1.2.650.0\n');
  if (line === 'aws --version') return r(0, 'aws-cli/2.17.0\n');
  if (line.startsWith('aws sts get-caller-identity --profile termag-boxes')) {
    return m.awsSession
      ? r(0, JSON.stringify({ Arn: 'arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_TermagUser_x/alice@example.com' }))
      : r(255, '', '\nError when retrieving token from sso: Token has expired and refresh failed\n');
  }
  return r(1, '', `unexpected: ${line}`);
}

async function execInteractive(cmd: string, args: string[]): Promise<number> {
  const line = [cmd, ...args].join(' ');
  m.interactive.push(line);
  if (line === 'aws sso login --profile termag-boxes') { m.awsSession = true; return 0; }
  if (cmd === 'ssh-keygen') { writeFileSync(`${args[args.indexOf('-f') + 1]}.pub`, ed25519Line('generated') + '\n'); return 0; }
  return 127;
}

function ctx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    env: { TERMAG_URL: orch.host },
    home,
    hostname: 'zane-mbp.local',
    interactive: false,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    fetch: globalThis.fetch,
    openBrowser: (url) => { void fetch(url).catch(() => {}); },
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    exec,
    execInteractive,
    prompt: async (q) => { questions.push(q); return answers.shift() ?? 'y'; },
    platform: 'linux',
    loginTimeoutMs: 5000,
    ...overrides,
  };
}

const all = () => [...out, ...err].join('\n');
const sshDir = () => join(home, '.ssh');
const awsConfig = () => join(home, '.aws', 'config');

function signIn(): void {
  const token = 'tmcli_' + 'd'.repeat(64);
  orch.tokens.set(token, { deviceName: 'zane-mbp.local', revoked: false });
  saveLogin(join(home, '.config', 'termag', 'credentials.json'), orch.host, {
    token, deviceName: 'zane-mbp.local', email: 'alice@example.com', unixUsername: 'alice',
    expiresAt: '2026-10-09T00:00:00.000Z', maxExpiresAt: '2026-11-01T00:00:00.000Z',
  });
}

/** A laptop where everything is in place. */
function healthy(): string {
  signIn();
  const key = ed25519Line('zane@mbp');
  writeFileSync(join(sshDir(), 'id_ed25519.pub'), key + '\n');
  orch.doctor.sshKeys.push(key);
  orch.doctor.github.connected = { label: '@alice-gh', updatedAt: '2026-10-01T00:00:00.000Z' };
  mkdirSync(join(home, '.aws'));
  writeFileSync(awsConfig(), '[profile termag-boxes]\nsso_account_id = 123456789012\nsso_role_name = TermagUser\n');
  m.awsSession = true;
  writeFileSync(join(sshDir(), 'config'), '# >>> termag ssh-config >>>\nHost termag-*\n  ProxyCommand termag ssh-proxy %h %p\nHost *\n# <<< termag ssh-config <<<\n');
  return key;
}

async function doctorJson(c: Ctx = ctx()) {
  out = [];
  const code = await run(['doctor', '--json'], c);
  const report = JSON.parse(out.join('\n'));
  const byId = Object.fromEntries(report.checks.map((x: { id: string }) => [x.id, x]));
  return { code, report, byId };
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'termag-doctor-'));
  mkdirSync(join(home, '.ssh'), { mode: 0o700 });
  orch = await startFakeOrchestrator();
  m = {
    installed: new Set(['gh', 'aws', 'session-manager-plugin', 'ssh-keygen']),
    ghToken: GH_TOKEN, ghLogin: 'alice-gh', orgs: { 'example-org': 'member', 'example-team': 'member' },
    awsSession: false, calls: [], interactive: [],
  };
  out = []; err = []; questions = []; answers = [];
});

afterEach(async () => {
  await orch.close();
  rmSync(home, { recursive: true, force: true });
});

describe('termag doctor', () => {
  it('passes every check on a set-up laptop and exits 0', async () => {
    healthy();
    const { code, report, byId } = await doctorJson();
    expect(code).toBe(0);
    expect(report).toMatchObject({ host: orch.host, ok: true, summary: { ok: 9, warn: 0, fail: 0 } });
    expect(Object.keys(byId)).toEqual([
      'login', 'ssh-key', 'github', 'github-sso', 'aws-profile', 'session-manager-plugin', 'aws-sso', 'ssh-config', 'claude',
    ]);
    expect(byId.login.detail).toContain('alice@example.com');
    expect(byId['ssh-key'].detail).toMatch(/~\/\.ssh\/id_ed25519\.pub \(SHA256:.+\) is registered/);
    expect(byId.github.detail).toContain('@alice-gh');
    expect(byId['aws-sso'].detail).toContain('assumed-role');
    expect(byId.claude.detail).toMatch(/^on:/);
    expect(byId['ssh-config'].detail).toBe('termag ssh-config entry in ~/.ssh/config');
    expect(all()).not.toContain(GH_TOKEN);
  });

  it('prints one line per check, a fix under each problem, and a summary', async () => {
    healthy();
    rmSync(join(sshDir(), 'config'));
    m.installed.delete('session-manager-plugin');
    expect(await run(['doctor'], ctx())).toBe(1);
    const text = out.join('\n');
    expect(text).toContain(`Checking termag setup for ${orch.host}`);
    expect(text).toMatch(/^ok {4}Login {8}alice@example\.com/m);
    expect(text).toMatch(/^fail {2}SSM plugin {3}session-manager-plugin is not installed\n {19}fix: install it: https:\/\/docs\.aws/m);
    expect(text).toMatch(/^warn {2}SSH config .+\n +fix: termag ssh-config --install/m);
    expect(text).toContain('1 problem, 1 warning.');
  });

  it('exits 0 with only warnings', async () => {
    healthy();
    m.orgs['example-org'] = 'sso';
    const { code, byId } = await doctorJson();
    expect(code).toBe(0);
    expect(byId['github-sso']).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('not SSO-authorized for example-org'),
      fix: 'authorize it at https://github.com/orgs/example-org/sso?authorization_request=r1',
    });
  });

  it('without a terminal only reports: no prompts, no writes, exit 1', async () => {
    signIn();
    const key = ed25519Line('zane@mbp');
    writeFileSync(join(sshDir(), 'id_ed25519.pub'), key + '\n');
    out = [];
    expect(await run(['doctor'], ctx({ interactive: false }))).toBe(1);
    expect(questions).toEqual([]);
    expect(m.interactive).toEqual([]);
    expect(orch.doctor.sshKeys).toEqual([]);
    expect(orch.doctor.githubTokens).toEqual([]);
    expect(existsSync(awsConfig())).toBe(false);
    const text = out.join('\n');
    expect(text).toContain(`fix: add ~/.ssh/id_ed25519.pub in the web UI: ${orch.host}/settings (SSH keys)`);
    expect(text).toContain('fix: run `termag doctor` in a terminal to store your gh token');
    expect(text).toContain('fix: run `termag doctor` in a terminal to add it');
    expect(text).not.toContain(GH_TOKEN);
  });

  it('--json never prompts, even at a terminal', async () => {
    signIn();
    const { code, byId } = await doctorJson(ctx({ interactive: true }));
    expect(code).toBe(1);
    expect(questions).toEqual([]);
    expect(byId['aws-profile'].status).toBe('fail');
  });

  it('at a terminal asks once per fix and applies what was accepted', async () => {
    signIn();
    const key = ed25519Line('zane@mbp');
    writeFileSync(join(sshDir(), 'id_ed25519.pub'), key + '\n');
    writeFileSync(join(sshDir(), 'config'), 'Host termag-*\n');
    // The SSH key is the one check doctor can't fix: adding a key is web-only.
    expect(await run(['doctor'], ctx({ interactive: true }))).toBe(1);
    expect(questions).toHaveLength(3);
    expect(questions[0]).toContain('Store your `gh` login\'s token with termag?');
    expect(questions[1]).toContain('Add the termag-boxes profile');
    expect(questions[2]).toContain('aws sso login --profile termag-boxes');

    expect(orch.doctor.sshKeys).toEqual([]);
    expect(orch.requests.some(r => r.method === 'POST' && r.path.endsWith('/ssh-keys'))).toBe(false);
    expect(orch.doctor.githubTokens).toEqual([GH_TOKEN]);
    expect(m.interactive).toEqual(['aws sso login --profile termag-boxes']);
    const awsText = readFileSync(awsConfig(), 'utf8');
    expect(awsText).toContain('# >>> termag aws-config >>>');
    expect(awsText).toContain('[profile termag-boxes]\nsso_session = termag');
    expect(awsText).not.toContain('sso_start_url = https://your-org.awsapps.com/start/\nsso_region = us-east-1\nsso_account_id');
    const text = out.join('\n');
    expect(text).toMatch(/^fail +SSH key +~\/\.ssh\/id_ed25519\.pub .+ is not registered/m);
    expect(text).toContain(`add ~/.ssh/id_ed25519.pub in the web UI: ${orch.host}/settings (SSH keys)`);
    expect(text).toMatch(/^ok +GitHub +connected as @alice-gh .+ \(fixed\)$/m);
    expect(all()).not.toContain(GH_TOKEN);

    // Once the key is added in the web UI, a second run has nothing to ask.
    orch.doctor.sshKeys.push(key);
    questions = [];
    expect(await run(['doctor'], ctx({ interactive: true }))).toBe(0);
    expect(questions).toEqual([]);
  });

  it('a declined fix stays a failure', async () => {
    healthy();
    rmSync(awsConfig());
    answers = ['n'];
    expect(await run(['doctor'], ctx({ interactive: true }))).toBe(1);
    expect(questions).toHaveLength(1);
    expect(existsSync(awsConfig())).toBe(false);
    expect(out.join('\n')).toMatch(/^fail +AWS SSO +needs the termag-boxes profile/m);
  });

  it('does not write the [sso-session] profile for an AWS CLI older than 2.9', async () => {
    signIn();
    const oldAws = (cmd: string, args: string[]) =>
      [cmd, ...args].join(' ') === 'aws --version' ? Promise.resolve({ code: 0, stdout: 'aws-cli/2.8.1\n', stderr: '' }) : exec(cmd, args);
    answers = ['n', 'n', 'y', 'n'];
    await run(['doctor'], ctx({ interactive: true, exec: oldAws }));
    expect(out.join('\n')).toContain('fix failed: AWS CLI 2.8 predates the [sso-session] profile');
    expect(existsSync(awsConfig())).toBe(false);
  });

  it('--yes applies fixes without asking', async () => {
    healthy();
    m.awsSession = false;
    expect(await run(['doctor', '--yes'], ctx({ interactive: true }))).toBe(0);
    expect(questions).toEqual([]);
    expect(m.interactive).toEqual(['aws sso login --profile termag-boxes']);
  });

  it('offers to generate an SSH key when there is none', async () => {
    healthy();
    rmSync(join(sshDir(), 'id_ed25519.pub'));
    orch.doctor.sshKeys = [];
    expect(await run(['doctor'], ctx({ interactive: true }))).toBe(1);
    expect(questions[0]).toContain('Generate ~/.ssh/id_ed25519 with ssh-keygen?');
    expect(m.interactive[0]).toBe(`ssh-keygen -t ed25519 -f ${join(sshDir(), 'id_ed25519')}`);
    expect(orch.doctor.sshKeys).toHaveLength(0);
    expect(out.join('\n')).toContain(`add ~/.ssh/id_ed25519.pub in the web UI: ${orch.host}/settings (SSH keys)`);
  });

  it('accepts another registered key in ~/.ssh', async () => {
    healthy();
    rmSync(join(sshDir(), 'id_ed25519.pub'));
    const rsa = ed25519Line('second');
    writeFileSync(join(sshDir(), 'id_ecdsa.pub'), rsa + '\n');
    orch.doctor.sshKeys = [rsa];
    const { byId } = await doctorJson();
    expect(byId['ssh-key']).toMatchObject({ status: 'ok', detail: expect.stringContaining('~/.ssh/id_ecdsa.pub') });
  });

  it('not signed in: login fails, orchestrator checks are skipped, local checks still run', async () => {
    const { code, byId } = await doctorJson();
    expect(code).toBe(1);
    expect(byId.login).toMatchObject({ status: 'fail', fix: 'termag login' });
    for (const id of ['github', 'claude']) expect(byId[id]).toMatchObject({ status: 'warn', skipped: true });
    expect(byId['ssh-key']).toMatchObject({ status: 'fail', detail: 'no SSH key in ~/.ssh' });
    expect(byId['session-manager-plugin'].status).toBe('ok');
    expect(orch.requests).toEqual([]);
  });

  it('a revoked sign-in fails Login with the fix', async () => {
    healthy();
    for (const t of orch.tokens.values()) t.revoked = true;
    const { byId } = await doctorJson();
    expect(byId.login).toMatchObject({ status: 'fail', fix: 'termag login' });
  });

  it('GitHub: gh missing, gh signed out, and a different stored login', async () => {
    signIn();
    m.installed.delete('gh');
    let r = await doctorJson();
    expect(r.byId.github).toMatchObject({ status: 'fail', detail: 'not connected, and gh is not installed' });
    expect(r.byId['github-sso']).toMatchObject({ status: 'warn', skipped: true });

    m.installed.add('gh');
    m.ghToken = null;
    r = await doctorJson();
    expect(r.byId.github).toMatchObject({ status: 'fail', fix: 'gh auth login, then `termag doctor`' });

    m.ghToken = GH_TOKEN;
    m.ghLogin = 'someone-else';
    orch.doctor.github.connected = { label: '@alice-gh', updatedAt: '2026-10-01T00:00:00.000Z' };
    r = await doctorJson();
    expect(r.byId.github).toMatchObject({ status: 'warn', detail: "termag holds @alice-gh's token, but gh is signed in as @someone-else" });
  });

  it('GitHub and Claude when the orchestrator lacks the credential store or the gateway', async () => {
    healthy();
    orch.doctor.github = { available: false, connected: null };
    orch.doctor.claudeGateway = { available: true, enabled: false };
    let r = await doctorJson();
    expect(r.code).toBe(0);
    expect(r.byId.github).toMatchObject({ status: 'warn', detail: expect.stringContaining('no credential store') });
    expect(r.byId.claude).toMatchObject({ status: 'warn', fix: 'turn it on in the web UI (Settings, Credentials)' });
    orch.doctor.claudeGateway = { available: false, enabled: false };
    r = await doctorJson();
    expect(r.byId.claude).toMatchObject({ status: 'ok', detail: expect.stringMatching(/^off:/) });
  });

  it('flags a termag-boxes profile that points at another account', async () => {
    healthy();
    writeFileSync(awsConfig(), '[profile termag-boxes]\nsso_account_id = 111111111111\nsso_role_name = PowerUser\n');
    const { byId } = await doctorJson();
    expect(byId['aws-profile']).toMatchObject({ status: 'warn', detail: expect.stringContaining('111111111111 as PowerUser') });
  });

  it('honors AWS_CONFIG_FILE', async () => {
    healthy();
    const alt = join(home, 'aws-alt');
    writeFileSync(alt, readFileSync(awsConfig(), 'utf8'));
    rmSync(awsConfig());
    const { byId } = await doctorJson(ctx({ env: { TERMAG_URL: orch.host, AWS_CONFIG_FILE: alt } }));
    expect(byId['aws-profile']).toMatchObject({ status: 'ok', detail: expect.stringContaining('~/aws-alt') });
  });

  it('offers brew for the SSM plugin on macOS', async () => {
    healthy();
    m.installed.delete('session-manager-plugin');
    answers = ['n'];
    await run(['doctor'], ctx({ interactive: true, platform: 'darwin' }));
    expect(questions).toEqual(['  Install it with `brew install --cask session-manager-plugin`? [Y/n] ']);
  });

  it('on a box, the laptop checks are skipped and still pass', async () => {
    const boxHome = join(home, '.config', 'termag');
    mkdirSync(boxHome, { recursive: true });
    writeFileSync(join(boxHome, 'agent.config.json'), JSON.stringify({ server_url: orch.host.replace('http', 'ws') + '/ws/agent', token: 'tmag_box' }));
    orch.boxTokens.add('tmag_box');
    const { code, byId } = await doctorJson(ctx({ env: {} }));
    expect(code).toBe(0);
    expect(byId.login.detail).toContain("this box's own credentials");
    for (const id of ['ssh-key', 'github', 'github-sso', 'aws-profile', 'session-manager-plugin', 'aws-sso', 'ssh-config']) {
      expect(byId[id]).toMatchObject({ status: 'ok', skipped: true });
    }
    expect(byId.claude.status).toBe('ok');
    expect(m.calls).toEqual([]);
  });

  it('an orchestrator without the doctor routes gets warnings, not failures', async () => {
    healthy();
    orch.override.set('/api/cli/v1/credentials', (res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'No such CLI endpoint', code: 'not_found' }));
    });
    const { code, byId } = await doctorJson();
    expect(code).toBe(0);
    expect(byId.github).toMatchObject({ status: 'warn', detail: 'skipped: this orchestrator predates `termag doctor`' });
  });
});

describe('termag login runs doctor', () => {
  it('prints the checks after signing in', async () => {
    healthy();
    rmSync(join(home, '.config', 'termag', 'credentials.json'));
    expect(await run(['login'], ctx({ interactive: true }))).toBe(0);
    const text = out.join('\n');
    expect(text.indexOf('Signed in to')).toBeLessThan(text.indexOf('Checking termag setup'));
    expect(text).toContain('All checks passed.');
  });

  it('--json carries the doctor report, and a failing check does not fail the login', async () => {
    m.installed.clear();
    expect(await run(['login', '--json'], ctx({ interactive: true }))).toBe(0);
    const body = JSON.parse(out.join('\n'));
    expect(body.user.email).toBe('alice@example.com');
    expect(body.doctor).toMatchObject({ host: orch.host, ok: false });
    expect(body.doctor.checks[0]).toMatchObject({ id: 'login', status: 'ok' });
    expect(questions).toEqual([]);
  });
});
