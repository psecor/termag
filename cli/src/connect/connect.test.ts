import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import { run } from '../main.js';
import { BOXES, PROJECTS, startFakeOrchestrator, type FakeOrchestrator } from '../test/fakeOrchestrator.js';

// Stand-ins for aws, session-manager-plugin, ssh, termag and infocmp: each logs its
// argv, and files in the state directory steer what aws reports.
const FAKE = `#!${process.execPath}
const { appendFileSync, existsSync, rmSync } = require('node:fs');
const { basename, join } = require('node:path');
const state = process.env.FAKE_STATE;
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(join(state, 'calls.jsonl'), JSON.stringify({ name, args }) + '\\n');
const has = (f) => existsSync(join(state, f));
if (name === 'aws') {
  const cmd = args.slice(0, 2).join(' ');
  if (args[0] === '--version') { process.stdout.write((has('aws-2.8') ? 'aws-cli/2.8.12' : 'aws-cli/2.15.30') + ' Python/3.11.8 Darwin/23.4.0\\n'); process.exit(0); }
  if (cmd === 'configure list-profiles') { process.stdout.write(has('no-profile') ? 'default\\n' : 'default\\ntermag-boxes\\n'); process.exit(0); }
  if (cmd === 'sts get-caller-identity') {
    if (has('sso-expired')) { process.stderr.write('\\nError when retrieving token from sso: Token has expired and refresh failed\\n'); process.exit(255); }
    if (has('no-token')) { process.stderr.write('\\nError loading SSO Token: Token for termag does not exist\\n'); process.exit(255); }
    if (has('sso-cache-corrupt-bare')) { process.stderr.write("\\n'b07d3c50e209cb6974636adb6cce2cab6858d6cc'\\n"); process.exit(255); }
    if (has('sso-cache-corrupt')) { process.stderr.write("\\naws: [ERROR]: 'b07d3c50e209cb6974636adb6cce2cab6858d6cc'\\n"); process.exit(255); }
    if (has('network-down')) { process.stderr.write('\\nCould not connect to the endpoint URL\\n'); process.exit(255); }
    process.stdout.write('{}'); process.exit(0);
  }
  if (cmd === 'sso login') { if (!has('sso-login-fails')) { rmSync(join(state, 'sso-expired'), { force: true }); rmSync(join(state, 'no-token'), { force: true }); rmSync(join(state, 'sso-cache-corrupt'), { force: true }); } process.exit(has('sso-login-fails') ? 1 : 0); }
  process.exit(0);
}
if (name === 'infocmp') {
  if (has('no-local-entry')) { process.stderr.write('infocmp: no such entry\\n'); process.exit(1); }
  process.stdout.write(args.at(-1) + '|a terminal,\\n\\tam,\\n\\tcols#80,\\n'); process.exit(0);
}
if (name === 'ssh' && args.includes('-G')) {
  process.stdout.write(has('ssh-config') ? require('node:fs').readFileSync(join(state, 'ssh-config'), 'utf8') : 'requesttty auto\\n');
  process.exit(0);
}
if (name === 'ssh') require('node:fs').writeFileSync(join(state, 'ssh-env.json'), JSON.stringify({ TERM: process.env.TERM }));
if (name === 'ssh') process.exit(Number(process.env.FAKE_SSH_EXIT || 0));
process.exit(0);
`;

const CONNECT_BOXES = [
  { ...BOXES[0], ec2InstanceId: 'i-0devbox', region: 'us-west-2', hostUnixUser: 'alice' },
  { ...BOXES[1], name: 'parked', addressable: true, ec2InstanceId: 'i-0parked', region: 'us-east-2', hostUnixUser: 'alice' },
  { id: 'i3', name: 'mine', addressable: true, kind: 'external', state: 'running', status: 'ready', agentConnected: true, error: null, ec2InstanceId: null, region: null, hostUnixUser: 'alice', projects: [] },
];
const CONNECT_PROJECTS = PROJECTS.map(p => ({
  ...p,
  directory: `/home/alice/termag/projects/${p.name}`,
  sessions: { agent: `alice-${p.name}-agent`, ctrl: `alice-${p.name}-ctrl` },
}));

let home: string;
let bin: string;
let state: string;
let orch: FakeOrchestrator;
let out: string[];
let err: string[];

function serve(body: unknown) {
  return (res: ServerResponse) => { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)); };
}

function ctx(overrides: Partial<Ctx> = {}, env: NodeJS.ProcessEnv = {}): Ctx {
  return {
    env: { TERMAG_URL: orch.host, PATH: bin, FAKE_STATE: state, TERMAG_TOOL_FALLBACK_DIRS: '', ...env },
    home,
    hostname: 'zane-mbp.local',
    interactive: true,
    stderrIsTTY: true,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    fetch: globalThis.fetch,
    openBrowser: (url) => { void fetch(url).catch(() => {}); },
    readFile: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
    loginTimeoutMs: 5000,
    ...overrides,
  };
}

function calls(name?: string): string[][] {
  const file = join(state, 'calls.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => JSON.parse(l) as { name: string; args: string[] })
    .filter(c => !name || c.name === name)
    .map(c => c.args);
}

// The session's ssh, not an `ssh -G` that only reads the configuration.
const sshArgv = () => { const c = calls('ssh').filter(a => !a.includes('-G')); expect(c).toHaveLength(1); return c[0]; };
const sshEnv = () => JSON.parse(readFileSync(join(state, 'ssh-env.json'), 'utf8')) as Record<string, string>;
const flag = (name: string) => writeFileSync(join(state, name), '');
const removeTool = (name: string) => rmSync(join(bin, name));

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'termag-connect-'));
  bin = join(home, 'bin');
  state = join(home, 'state');
  mkdirSync(bin);
  mkdirSync(state);
  for (const tool of ['aws', 'session-manager-plugin', 'ssh', 'termag', 'infocmp']) {
    writeFileSync(join(bin, tool), FAKE);
    chmodSync(join(bin, tool), 0o755);
  }
  orch = await startFakeOrchestrator();
  orch.override.set('/api/cli/v1/boxes', serve({ boxes: CONNECT_BOXES }));
  orch.override.set('/api/cli/v1/projects', serve({ projects: CONNECT_PROJECTS }));
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

describe('termag ssh <box>', () => {
  it('connects over SSM with TermagSSH and the termag-boxes profile, in the box\'s region', async () => {
    expect(await run(['ssh', 'devbox'], ctx())).toBe(0);
    const argv = sshArgv();
    expect(argv).toContain(`ProxyCommand=${join(bin, 'aws')} ssm start-session --target i-0devbox --document-name TermagSSH --parameters portNumber=%p --region us-west-2 --profile termag-boxes`);
    expect(argv).toContain('User=alice');
    expect(argv).toContain('HostKeyAlias=i-0devbox');
    expect(argv.at(-1)).toBe('termag-devbox');
    expect(argv).not.toContain('-t');
  });

  it('checks the AWS side before connecting', async () => {
    await run(['ssh', 'devbox'], ctx());
    expect(calls('aws').map(a => a.slice(0, 2).join(' '))).toEqual(['configure list-profiles', 'sts get-caller-identity']);
    expect(calls('aws')[1]).toEqual(['sts', 'get-caller-identity', '--profile', 'termag-boxes', '--output', 'json']);
  });

  it('passes ssh options through and keeps them ahead of its own', async () => {
    expect(await run(['ssh', 'devbox', '-N', '-L', '3000:localhost:3000'], ctx())).toBe(0);
    const argv = sshArgv();
    expect(argv.slice(0, 3)).toEqual(['-N', '-L', '3000:localhost:3000']);
    expect(argv.at(-1)).toBe('termag-devbox');
  });

  it('accepts termag flags before the box', async () => {
    expect(await run(['--host', orch.host, 'ssh', 'devbox', '-A'], ctx({}, { TERMAG_URL: '' }))).toBe(0);
    expect(sshArgv()[0]).toBe('-A');
  });

  it('runs a command line given as one argument as is', async () => {
    expect(await run(['ssh', 'devbox', '--', 'uptime | cut -c1-20'], ctx())).toBe(0);
    expect(sshArgv().at(-1)).toBe('uptime | cut -c1-20');
  });

  it('honors TERMAG_AWS_PROFILE and TERMAG_SSM_DOCUMENT', async () => {
    await run(['ssh', 'devbox'], ctx({}, { TERMAG_AWS_PROFILE: 'termag-boxes', TERMAG_SSM_DOCUMENT: 'AWS-StartSSHSession' }));
    expect(sshArgv().find(a => a.startsWith('ProxyCommand='))).toContain('--document-name AWS-StartSSHSession');
  });

  it('returns ssh\'s own exit status', async () => {
    expect(await run(['ssh', 'devbox', '--', 'false'], ctx({}, { FAKE_SSH_EXIT: '7' }))).toBe(7);
  });

  it('never lets ssh prompt without a terminal', async () => {
    expect(await run(['ssh', 'devbox', '--', 'true'], ctx({ interactive: false }))).toBe(0);
    expect(sshArgv()).toContain('BatchMode=yes');
  });

  it('refuses a stray word, which ssh would take for the host (exit 2)', async () => {
    expect(await run(['ssh', 'devbox', 'ls'], ctx())).toBe(2);
    expect(err.join('\n')).toContain('put the remote command after `--`');
    expect(calls('ssh')).toEqual([]);
  });
});

describe('termag ssh <box>/<project>', () => {
  it('opens a login shell in the project directory, with a terminal', async () => {
    expect(await run(['ssh', 'devbox/webapp-fix'], ctx())).toBe(0);
    const argv = sshArgv();
    expect(argv.slice(-3)).toEqual(['-t', 'termag-devbox', 'cd /home/alice/termag/projects/webapp-fix && exec "${SHELL:-/bin/sh}" -l']);
  });

  it('runs a command there with every word intact', async () => {
    expect(await run(['ssh', 'devbox/webapp-fix', '--', 'claude', '-p', "fix the test, don't push"], ctx())).toBe(0);
    const argv = sshArgv();
    expect(argv.at(-1)).toBe(`cd /home/alice/termag/projects/webapp-fix && claude -p 'fix the test, don'\\''t push'`);
    expect(argv).not.toContain('-t');
  });

  it('forwards ports without starting a shell for -N', async () => {
    expect(await run(['ssh', 'devbox/webapp-fix', '-N', '-L', '3000:localhost:3000'], ctx())).toBe(0);
    expect(sshArgv().at(-1)).toBe('termag-devbox');
  });

  it('falls back to the conventional directory for an orchestrator that predates `directory`', async () => {
    orch.override.set('/api/cli/v1/projects', serve({ projects: PROJECTS }));
    await run(['ssh', 'devbox/flaky-test', '--', 'pwd'], ctx());
    expect(sshArgv().at(-1)).toBe('cd termag/projects/flaky-test && pwd');
  });

  it('exits 3 for an unknown project and names the ones on the box', async () => {
    expect(await run(['ssh', 'devbox/nope'], ctx())).toBe(3);
    expect(err.join('\n')).toContain('webapp-fix, flaky-test');
  });
});

describe('box state and reachability', () => {
  it('exits 3 for an unknown box', async () => {
    expect(await run(['ssh', 'ghost'], ctx())).toBe(3);
    expect(err.join('\n')).toContain('your boxes: devbox, parked, mine');
  });

  it('explains a stopped box instead of trying', async () => {
    expect(await run(['ssh', 'parked'], ctx())).toBe(1);
    expect(err.join('\n')).toContain('parked is stopped');
    expect(calls()).toEqual([]);
  });

  it('refuses a box that is not on EC2', async () => {
    expect(await run(['ssh', 'mine'], ctx())).toBe(1);
    expect(err.join('\n')).toContain('not an EC2 box');
  });

  it('exits 2 for a malformed reference', async () => {
    expect(await run(['ssh', 'a/b/c'], ctx())).toBe(2);
    expect(await run(['ssh'], ctx())).toBe(2);
  });

  it('needs a sign-in (exit 4)', async () => {
    await run(['logout'], ctx());
    expect(await run(['ssh', 'devbox'], ctx())).toBe(4);
  });
});

describe('pre-connect checks', () => {
  it('needs the AWS CLI', async () => {
    removeTool('aws');
    expect(await run(['ssh', 'devbox'], ctx())).toBe(1);
    expect(err.join('\n')).toContain('The AWS CLI (v2) is needed');
    expect(calls('ssh')).toEqual([]);
  });

  it('needs the Session Manager plugin', async () => {
    removeTool('session-manager-plugin');
    expect(await run(['ssh', 'devbox'], ctx())).toBe(1);
    expect(err.join('\n')).toContain('session-manager-plugin');
  });

  it('with no termag-boxes profile, writes the [sso-session] one and signs in once', async () => {
    flag('no-profile');
    flag('no-token');
    expect(await run(['ssh', 'devbox'], ctx())).toBe(0);
    const config = readFileSync(join(home, '.aws', 'config'), 'utf8');
    expect(config).toContain('[sso-session termag]\nsso_start_url = https://your-org.awsapps.com/start/');
    expect(config).toContain('[profile termag-boxes]\nsso_session = termag\nsso_account_id = 123456789012\nsso_role_name = TermagUser');
    expect(calls('aws').map(a => a.slice(0, 2).join(' '))).toEqual(
      ['configure list-profiles', '--version', 'sts get-caller-identity', 'sso login', 'sts get-caller-identity']);
    expect(err.join('\n')).toContain(`added the termag-boxes AWS profile in ${join(home, '.aws', 'config')}`);
    expect(err.join('\n')).toContain('termag-boxes has no AWS SSO session yet; running `aws sso login --profile termag-boxes`');
    expect(calls('ssh')).toHaveLength(1);
  });

  it('keeps the user\'s other profiles and follows AWS_CONFIG_FILE', async () => {
    flag('no-profile');
    const cfg = join(home, 'aws-config');
    writeFileSync(cfg, '[default]\nregion = us-east-1\n');
    expect(await run(['ssh', 'devbox'], ctx({}, { AWS_CONFIG_FILE: cfg }))).toBe(0);
    expect(readFileSync(cfg, 'utf8')).toMatch(/^\[default\]\nregion = us-east-1\n\n# >>> termag aws-config >>>/);
    expect(existsSync(join(home, '.aws', 'config'))).toBe(false);
  });

  it('writes the profile without a terminal too, then asks for the sign-in (exit 4)', async () => {
    flag('no-profile');
    flag('no-token');
    expect(await run(['ssh', 'devbox', '--', 'true'], ctx({ interactive: false }))).toBe(4);
    expect(existsSync(join(home, '.aws', 'config'))).toBe(true);
    expect(err.join('\n')).toContain('`termag-boxes` has no AWS SSO session yet; run `aws sso login --profile termag-boxes`');
    expect(calls('aws').some(a => a[0] === 'sso')).toBe(false);
  });

  it('refuses an AWS CLI too old for [sso-session], before writing anything', async () => {
    flag('no-profile');
    flag('aws-2.8');
    expect(await run(['ssh', 'devbox'], ctx())).toBe(1);
    expect(err.join('\n')).toContain('AWS CLI 2.8 predates the `[sso-session]` profile termag sets up; install 2.9 or later');
    expect(existsSync(join(home, '.aws', 'config'))).toBe(false);
  });

  it('brings a profile it wrote earlier up to date, and otherwise leaves the file alone', async () => {
    mkdirSync(join(home, '.aws'));
    const path = join(home, '.aws', 'config');
    writeFileSync(path, '# >>> termag aws-config >>>\n[profile termag-boxes]\nsso_session = termag\n# <<< termag aws-config <<<\n');
    expect(await run(['ssh', 'devbox'], ctx())).toBe(0);
    expect(err.join('\n')).toContain('updated the termag-boxes AWS profile');
    const current = readFileSync(path, 'utf8');
    expect(current).toContain('[sso-session termag]');
    err = [];
    expect(await run(['ssh', 'devbox'], ctx())).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(current);
    expect(err).toEqual([]);
  });

  it('steps aside when another tool adds its own termag-boxes profile next to termag\'s', async () => {
    flag('no-profile');
    expect(await run(['ssh', 'devbox'], ctx())).toBe(0);
    const path = join(home, '.aws', 'config');
    // What a profile generator appending the legacy form leaves behind.
    const legacy = '[profile termag-boxes]\nsso_start_url = https://your-org.awsapps.com/start/\nsso_role_name = TermagUser\n';
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n${legacy}`);
    rmSync(join(state, 'no-profile'));
    flag('sso-expired');
    err = [];
    expect(await run(['ssh', 'devbox'], ctx())).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(legacy);
    expect(err.join('\n')).toContain('of its own as well as termag\'s, which the AWS CLI rejects; removed termag\'s');
    expect(err.join('\n')).toContain('uses the legacy sso_start_url form');
    expect(calls('ssh')).toHaveLength(2);
  });

  it('never touches a profile named by TERMAG_AWS_PROFILE', async () => {
    flag('no-profile');
    expect(await run(['ssh', 'devbox'], ctx({}, { TERMAG_AWS_PROFILE: 'my-own' }))).toBe(1);
    expect(err.join('\n')).toContain('No `my-own` profile');
    expect(existsSync(join(home, '.aws', 'config'))).toBe(false);
  });

  it('leaves the user\'s own legacy profile, and says why each sign-in is short-lived', async () => {
    mkdirSync(join(home, '.aws'));
    const legacy = '[profile termag-boxes]\nsso_start_url = https://your-org.awsapps.com/start/\nsso_role_name = TermagUser\n';
    writeFileSync(join(home, '.aws', 'config'), legacy);
    flag('sso-expired');
    expect(await run(['ssh', 'devbox'], ctx())).toBe(0);
    expect(readFileSync(join(home, '.aws', 'config'), 'utf8')).toBe(legacy);
    expect(err.join('\n')).toContain('uses the legacy sso_start_url form');
  });

  it('with no terminal, an expired SSO session fails fast (exit 4) and never runs aws sso login', async () => {
    flag('sso-expired');
    expect(await run(['ssh', 'devbox', '--', 'true'], ctx({ interactive: false }))).toBe(4);
    expect(err.join('\n')).toContain('run `aws sso login --profile termag-boxes`');
    expect(calls('aws').some(a => a[0] === 'sso')).toBe(false);
    expect(calls('ssh')).toEqual([]);
  });

  it('at a terminal, renews an expired SSO session and carries on', async () => {
    flag('sso-expired');
    expect(await run(['ssh', 'devbox'], ctx())).toBe(0);
    expect(calls('aws').map(a => a.slice(0, 2).join(' '))).toEqual(
      ['configure list-profiles', 'sts get-caller-identity', 'sso login', 'sts get-caller-identity']);
    expect(err.join('\n')).toContain('termag-boxes has an expired AWS SSO session; running `aws sso login --profile termag-boxes`');
    expect(err.join('\n')).not.toContain('legacy');
    expect(calls('ssh')).toHaveLength(1);
  });

  it('stops when aws sso login fails', async () => {
    flag('sso-expired');
    flag('sso-login-fails');
    expect(await run(['ssh', 'devbox'], ctx())).toBe(4);
    expect(calls('ssh')).toEqual([]);
  });

  // What botocore prints when a racing refresh left a stray tail in the token cache file sha1("termag") names.
  const corruptCache = () => {
    flag('sso-cache-corrupt');
    mkdirSync(join(home, '.aws', 'sso', 'cache'), { recursive: true });
    writeFileSync(join(home, '.aws', 'sso', 'cache', 'b07d3c50e209cb6974636adb6cce2cab6858d6cc.json'), '{"accessToken": "x"}\n}\n');
  };

  it('with no terminal, a corrupted SSO token cache fails fast (exit 4) and names the login that repairs it', async () => {
    corruptCache();
    expect(await run(['ssh', 'devbox', '--', 'true'], ctx({ interactive: false }))).toBe(4);
    expect(err.join('\n')).toContain('has a corrupted AWS SSO token cache; run `aws sso login --profile termag-boxes`');
    expect(calls('aws').some(a => a[0] === 'sso')).toBe(false);
    expect(calls('ssh')).toEqual([]);
  });

  it('at a terminal, repairs a corrupted SSO token cache with aws sso login and carries on', async () => {
    corruptCache();
    expect(await run(['ssh', 'devbox'], ctx())).toBe(0);
    expect(calls('aws').map(a => a.slice(0, 2).join(' '))).toEqual(
      ['configure list-profiles', 'sts get-caller-identity', 'sso login', 'sts get-caller-identity']);
    expect(err.join('\n')).toContain('termag-boxes has a corrupted AWS SSO token cache; running `aws sso login --profile termag-boxes`');
    expect(calls('ssh')).toHaveLength(1);
  });

  it('recognizes the bare key older AWS CLIs print without the error prefix', async () => {
    corruptCache();
    rmSync(join(state, 'sso-cache-corrupt'));
    flag('sso-cache-corrupt-bare');
    expect(await run(['ssh', 'devbox', '--', 'true'], ctx({ interactive: false }))).toBe(4);
    expect(err.join('\n')).toContain('has a corrupted AWS SSO token cache; run `aws sso login --profile termag-boxes`');
  });

  it('does not blame the SSO token cache for a bare key it holds no file for', async () => {
    flag('sso-cache-corrupt');
    expect(await run(['ssh', 'devbox'], ctx())).toBe(1);
    expect(err.join('\n')).toContain("does not work: aws: [ERROR]: 'b07d3c50e209cb6974636adb6cce2cab6858d6cc'");
    expect(calls('aws').some(a => a[0] === 'sso')).toBe(false);
  });

  it('does not offer an SSO login for an unrelated AWS failure', async () => {
    flag('network-down');
    expect(await run(['ssh', 'devbox'], ctx())).toBe(1);
    expect(err.join('\n')).toContain('Could not connect to the endpoint URL');
    expect(calls('aws').some(a => a[0] === 'sso')).toBe(false);
  });
});

describe('termag attach', () => {
  it('attaches to the agent session with a terminal', async () => {
    expect(await run(['attach', 'devbox/webapp-fix'], ctx())).toBe(0);
    expect(sshArgv().slice(-3)).toEqual(['-t', 'termag-devbox', 'tmux attach-session -t alice-webapp-fix-agent \';\' set-option -w window-size latest']);
  });

  it('--ctrl attaches to the ctrl shell', async () => {
    expect(await run(['attach', 'devbox/webapp-fix', '--ctrl'], ctx())).toBe(0);
    expect(sshArgv().at(-1)).toBe('tmux attach-session -t alice-webapp-fix-ctrl \';\' set-option -w window-size latest');
  });

  it('derives the session name for an orchestrator that predates `sessions`', async () => {
    orch.override.set('/api/cli/v1/projects', serve({ projects: PROJECTS }));
    expect(await run(['attach', 'devbox/flaky-test'], ctx())).toBe(0);
    expect(sshArgv().at(-1)).toBe('tmux attach-session -t alice-flaky-test-agent \';\' set-option -w window-size latest');
  });

  it('needs a project (exit 2) and a terminal (exit 1)', async () => {
    expect(await run(['attach', 'devbox'], ctx())).toBe(2);
    expect(await run(['attach', 'devbox/webapp-fix'], ctx({ interactive: false }))).toBe(1);
    expect(err.join('\n')).toContain('needs a terminal');
    expect(calls('ssh')).toEqual([]);
  });
});

describe('a TERM the box may not have', () => {
  const entry = (term: string) => Buffer.from(`${term}|a terminal,\n\tam,\n\tcols#80,\n`).toString('base64');

  it('leaves a TERM every box has alone', async () => {
    expect(await run(['attach', 'devbox/webapp-fix'], ctx({}, { TERM: 'xterm-256color' }))).toBe(0);
    expect(sshArgv().at(-1)).toBe('tmux attach-session -t alice-webapp-fix-agent \';\' set-option -w window-size latest');
    expect(calls('infocmp')).toEqual([]);
    expect(err).toEqual([]);
  });

  it('installs the local entry on a box that lacks it, then attaches under it', async () => {
    expect(await run(['attach', 'devbox/webapp-fix', '--ctrl'], ctx({}, { TERM: 'xterm-ghostty' }))).toBe(0);
    expect(calls('infocmp')).toEqual([['-x', 'xterm-ghostty']]);
    const argv = sshArgv();
    expect(argv.slice(-3, -1)).toEqual(['-t', 'termag-devbox']);
    expect(argv.at(-1)).toBe(
      `if ! infocmp xterm-ghostty >/dev/null 2>&1; then printf %s ${entry('xterm-ghostty')} | base64 -d | tic -x -o "$HOME/.terminfo" - >/dev/null 2>&1; `
      + `infocmp xterm-ghostty >/dev/null 2>&1 || { echo 'termag: could not install the terminfo entry for xterm-ghostty on the box; using TERM=xterm-256color' >&2; TERM=xterm-256color; export TERM; }; fi; `
      + 'tmux attach-session -t alice-webapp-fix-ctrl \';\' set-option -w window-size latest');
    expect(err).toEqual([]);
  });

  it('does the same for the shell termag ssh opens, and gives a plain ssh a login shell to precede', async () => {
    expect(await run(['ssh', 'devbox/webapp-fix'], ctx({}, { TERM: 'xterm-kitty' }))).toBe(0);
    expect(sshArgv().at(-1)).toMatch(/^if ! infocmp xterm-kitty .*; fi; cd \/home\/alice\/termag\/projects\/webapp-fix && exec "\$\{SHELL:-\/bin\/sh\}" -l$/);
    rmSync(join(state, 'calls.jsonl'));
    expect(await run(['ssh', 'devbox'], ctx({}, { TERM: 'xterm-kitty' }))).toBe(0);
    const argv = sshArgv();
    expect(argv.slice(-3, -1)).toEqual(['-t', 'termag-devbox']);
    expect(argv.at(-1)).toMatch(/; fi; exec "\$\{SHELL:-\/bin\/sh\}" -l$/);
  });

  it('leaves commands, -N and -T sessions alone', async () => {
    for (const extra of [['--', 'uptime'], ['-N', '-L', '3000:localhost:3000'], ['-T']]) {
      rmSync(join(state, 'calls.jsonl'), { force: true });
      expect(await run(['ssh', 'devbox', ...extra], ctx({}, { TERM: 'xterm-ghostty' }))).toBe(0);
      expect(sshArgv().join(' ')).not.toContain('infocmp');
    }
    expect(calls('infocmp')).toEqual([]);
  });

  it('checks wezterm and foot too: they are in ncurses-term, which a box need not have', async () => {
    for (const term of ['wezterm', 'foot']) {
      rmSync(join(state, 'calls.jsonl'), { force: true });
      expect(await run(['attach', 'devbox/webapp-fix'], ctx({}, { TERM: term }))).toBe(0);
      const remote = sshArgv().at(-1)!;
      expect(remote.startsWith(`if ! infocmp ${term} `)).toBe(true);
      expect(remote.endsWith('; fi; tmux attach-session -t alice-webapp-fix-agent \';\' set-option -w window-size latest')).toBe(true);
    }
  });

  it("leaves a plain shell alone when ssh's configuration asks for no pty", async () => {
    writeFileSync(join(state, 'ssh-config'), 'user alice\nrequesttty false\n');
    expect(await run(['ssh', 'devbox', '-o', 'RequestTTY=no'], ctx({}, { TERM: 'xterm-ghostty' }))).toBe(0);
    expect(calls('ssh').find(a => a.includes('-G'))).toEqual(['-G', '-o', 'RequestTTY=no', 'termag-devbox']);
    const argv = sshArgv();
    expect(argv.at(-1)).toBe('termag-devbox');
    expect(argv).not.toContain('-t');
    expect(sshEnv().TERM).toBe('xterm-ghostty');
    expect(err).toEqual([]);
  });

  it("adds no command next to ssh's own RemoteCommand, and falls back instead", async () => {
    writeFileSync(join(state, 'ssh-config'), 'requesttty auto\nremotecommand tmux new -A\n');
    expect(await run(['ssh', 'devbox'], ctx({}, { TERM: 'xterm-ghostty' }))).toBe(0);
    const argv = sshArgv();
    expect(argv.at(-1)).toBe('termag-devbox');
    expect(argv).not.toContain('-t');
    expect(sshEnv().TERM).toBe('xterm-256color');
    expect(err).toEqual(["termag: TERM=xterm-ghostty may be unknown on the box and ssh's RemoteCommand leaves no command to install its terminfo entry before; using TERM=xterm-256color for this session"]);
  });

  it('falls back to xterm-256color, with a notice, when there is no local infocmp', async () => {
    removeTool('infocmp');
    expect(await run(['attach', 'devbox/webapp-fix'], ctx({}, { TERM: 'xterm-ghostty' }))).toBe(0);
    expect(sshArgv().at(-1)).toBe('tmux attach-session -t alice-webapp-fix-agent \';\' set-option -w window-size latest');
    expect(sshEnv().TERM).toBe('xterm-256color');
    expect(err).toEqual(['termag: TERM=xterm-ghostty may be unknown on the box and there is no infocmp here to copy its terminfo entry to the box; using TERM=xterm-256color for this session']);
  });

  it('falls back when this machine has no entry either', async () => {
    flag('no-local-entry');
    expect(await run(['attach', 'devbox/webapp-fix'], ctx({}, { TERM: 'xterm-ghostty' }))).toBe(0);
    expect(sshEnv().TERM).toBe('xterm-256color');
    expect(err.join('\n')).toContain('this machine has no terminfo entry for it');
  });

  it('never puts a TERM that is not a plain name into the command line', async () => {
    expect(await run(['attach', 'devbox/webapp-fix'], ctx({}, { TERM: 'x;touch /tmp/pwned' }))).toBe(0);
    expect(sshArgv().at(-1)).toBe('tmux attach-session -t alice-webapp-fix-agent \';\' set-option -w window-size latest');
    expect(calls('infocmp')).toEqual([]);
    expect(sshEnv().TERM).toBe('xterm-256color');
  });
});

describe('termag ssh-proxy (the ssh-config ProxyCommand)', () => {
  it('starts the TermagSSH session for termag-<box> on port 22, writing nothing to stdout', async () => {
    expect(await run(['ssh-proxy', 'termag-devbox', '22'], ctx())).toBe(0);
    expect(calls('aws').at(-1)).toEqual([
      'ssm', 'start-session', '--target', 'i-0devbox', '--document-name', 'TermagSSH',
      '--parameters', 'portNumber=22', '--region', 'us-west-2', '--profile', 'termag-boxes',
    ]);
    expect(out).toEqual([]);
  });

  it('allows port 22 only, as the TermagSSH document does', async () => {
    expect(await run(['ssh-proxy', 'termag-devbox', '2222'], ctx())).toBe(1);
  });

  it('only knows termag-<box> hosts', async () => {
    expect(await run(['ssh-proxy', 'devbox', '22'], ctx())).toBe(2);
  });

  it('without a terminal on stderr (an editor), reports an expired SSO session instead of logging in', async () => {
    flag('sso-expired');
    expect(await run(['ssh-proxy', 'termag-devbox', '22'], ctx({ stderrIsTTY: false }))).toBe(4);
    expect(calls('aws').some(a => a[0] === 'sso' || a[0] === 'ssm')).toBe(false);
  });

  it('with one, renews it like termag ssh', async () => {
    flag('sso-expired');
    expect(await run(['ssh-proxy', 'termag-devbox', '22'], ctx())).toBe(0);
    expect(calls('aws').map(a => a[0])).toContain('sso');
    expect(out).toEqual([]);
  });
});

describe('termag ssh-proxy --wake', () => {
  // The `parked` box moves one step per box list, like a box the orchestrator powers.
  let sim: { state: string; starts: number; startRace: boolean; stuck: boolean };
  const NEXT: Record<string, string> = { stopping: 'stopped', hibernating: 'hibernated', starting: 'running' };
  const view = () => ({ ...CONNECT_BOXES[1], state: sim.state, status: sim.state, agentConnected: sim.state === 'running' });

  beforeEach(() => {
    sim = { state: 'stopped', starts: 0, startRace: false, stuck: false };
    orch.override.set('/api/cli/v1/boxes', (res) => {
      const boxes = [CONNECT_BOXES[0], view(), CONNECT_BOXES[2]];
      if (!sim.stuck && NEXT[sim.state]) sim.state = NEXT[sim.state];
      serve({ boxes })(res);
    });
    orch.override.set('/api/cli/v1/boxes/i2/start', (res) => {
      sim.starts++;
      if (sim.startRace) sim.state = 'starting';
      if (sim.state !== 'stopped' && sim.state !== 'hibernated') {
        res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `Can't start a box that is ${sim.state}` }));
        return;
      }
      sim.state = 'starting';
      res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ box: view() }));
    });
  });

  const proxy = (...flags: string[]) => run(['ssh-proxy', ...flags, 'termag-parked', '22'], ctx({ pollIntervalMs: 5 }));
  const ssmCalls = () => calls('aws').filter(a => a[0] === 'ssm');

  it.each([
    ['stopped', 1],
    ['hibernated', 1],
    ['stopping', 1],
    ['hibernating', 1],
    ['starting', 0],
    ['running', 0],
  ])('connects to a %s box after %i start, with nothing on stdout', async (state, starts) => {
    sim.state = state;
    expect(await proxy('--wake')).toBe(0);
    expect(sim.starts).toBe(starts);
    expect(ssmCalls()).toEqual([[
      'ssm', 'start-session', '--target', 'i-0parked', '--document-name', 'TermagSSH',
      '--parameters', 'portNumber=22', '--region', 'us-east-2', '--profile', 'termag-boxes',
    ]]);
    expect(out).toEqual([]);
  });

  it('says on stderr what it does with a parked box', async () => {
    sim.state = 'stopping';
    expect(await proxy('--wake')).toBe(0);
    expect(err).toEqual([
      'termag: parked is stopping; bringing it up before connecting (--wake)',
      'parked: stopping, starting it once that finishes',
      'parked: starting (0s)',
    ]);
  });

  it('refuses a failed box as without --wake, and starts nothing', async () => {
    sim.state = 'failed';
    expect(await proxy('--wake')).toBe(1);
    expect(err.join('\n')).toContain('parked failed to come up');
    expect(sim.starts).toBe(0);
    expect(calls('aws')).toEqual([]);
  });

  it('without --wake, refuses a stopped box before touching AWS', async () => {
    expect(await proxy()).toBe(1);
    expect(err.join('\n')).toContain('parked is stopped; start it (`termag box start parked` or the web UI) and try again');
    expect(sim.starts).toBe(0);
    expect(calls('aws')).toEqual([]);
  });

  it('waits for a start another connection sent first', async () => {
    sim.startRace = true;
    expect(await proxy('--wake')).toBe(0);
    expect(sim.starts).toBe(1);
    expect(ssmCalls()).toHaveLength(1);
  });

  it('gives up after --timeout with exit 5 and never opens the session', async () => {
    sim.state = 'starting';
    sim.stuck = true;
    expect(await proxy('--wake', '--timeout', '0.1')).toBe(5);
    expect(err.at(-1)).toMatch(/^termag: Timed out after 0s waiting for parked to be running \(it is starting\)$/);
    expect(ssmCalls()).toEqual([]);
    expect(out).toEqual([]);
  });

  it('takes --timeout only with --wake', async () => {
    expect(await proxy('--timeout', '30')).toBe(2);
  });

  it('is written into the ProxyCommand by ssh-config --wake', async () => {
    expect(await run(['ssh-config', '--wake'], ctx())).toBe(0);
    expect(out.join('\n')).toContain(`  ProxyCommand ${join(bin, 'termag')} --host ${orch.host} ssh-proxy --wake %h %p`);
    out = [];
    expect(await run(['ssh-config', '--install', '--wake'], ctx())).toBe(0);
    expect(readFileSync(join(home, '.ssh', 'config'), 'utf8')).toContain('ssh-proxy --wake %h %p');
    expect(out.join('\n')).toContain('Re-run `termag ssh-config --install --wake` after adding a box or a project.');
  });
});

describe('termag ssh-config', () => {
  it('prints the entry, routed through the termag on PATH and this orchestrator', async () => {
    expect(await run(['ssh-config'], ctx())).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('Host termag-*');
    expect(text).toContain('  User alice');
    expect(text).toContain(`  ProxyCommand ${join(bin, 'termag')} --host ${orch.host} ssh-proxy %h %p`);
    expect(existsSync(join(home, '.ssh', 'config'))).toBe(false);
  });

  it('names the user of each box whose agent runs as someone else, ahead of the wildcard', async () => {
    orch.override.set('/api/cli/v1/boxes', serve({ boxes: [
      ...CONNECT_BOXES,
      { ...CONNECT_BOXES[0], id: 'i4', name: 'warm', hostUnixUser: 'termag' },
      { ...CONNECT_BOXES[0], id: 'i5', name: 'old', hostUnixUser: null },
      { ...CONNECT_BOXES[0], id: 'i6', name: 'evil', hostUnixUser: 'x\n  ProxyCommand touch /tmp/pwned' },
    ] }));
    expect(await run(['ssh-config'], ctx())).toBe(0);
    const lines = out.join('\n').split('\n');
    expect(lines.indexOf('Host termag-warm')).toBeLessThan(lines.indexOf('Host termag-*'));
    expect(lines[lines.indexOf('Host termag-warm') + 1]).toBe('  User termag');
    expect(lines.filter(l => l.startsWith('Host termag-') && !l.includes('.'))).toEqual(['Host termag-warm', 'Host termag-*']);
  });

  it("gives each project an agent and a ctrl host, and names the ones it leaves out", async () => {
    orch.override.set('/api/cli/v1/projects', serve({ projects: [
      ...CONNECT_PROJECTS,
      { ...CONNECT_PROJECTS[0], id: 'p3', name: 'odd name', sessions: { agent: 'alice-odd_name-agent', ctrl: 'alice-odd_name-ctrl' } },
    ] }));
    expect(await run(['ssh-config'], ctx())).toBe(0);
    const lines = out.join('\n').split('\n');
    expect(lines.filter(l => l.startsWith('Host '))).toEqual([
      'Host termag-devbox.flaky-test', 'Host termag-devbox.flaky-test.ctrl',
      'Host termag-devbox.webapp-fix', 'Host termag-devbox.webapp-fix.ctrl',
      'Host termag-*', 'Host *',
    ]);
    const ctrl = lines.indexOf('Host termag-devbox.webapp-fix.ctrl');
    expect(lines.slice(ctrl + 1, ctrl + 5)).toEqual([
      '  HostName termag-devbox', '  User alice', '  RequestTTY yes', '  RemoteCommand tmux attach-session -t alice-webapp-fix-ctrl \';\' set-option -w window-size latest',
    ]);
    expect(err.join('\n')).toContain('devbox/odd name has no termag-<box>.<project> host');
  });

  it('--install writes it once and is idempotent', async () => {
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'config'), 'Host github.com\n  User git\n');
    expect(await run(['ssh-config', '--install'], ctx())).toBe(0);
    expect(out.join('\n')).toContain('Added the termag entry to');
    const first = readFileSync(join(home, '.ssh', 'config'), 'utf8');
    expect(first.endsWith('\n\nHost github.com\n  User git\n')).toBe(true);
    out = [];
    expect(await run(['ssh-config', '--install', '--json'], ctx())).toBe(0);
    expect(JSON.parse(out.join(''))).toMatchObject({ action: 'unchanged' });
    expect(readFileSync(join(home, '.ssh', 'config'), 'utf8')).toBe(first);
  });
});

describe('help', () => {
  it('lists the connect commands', async () => {
    expect(await run(['--help'], ctx())).toBe(0);
    for (const c of ['ssh ', 'attach', 'ssh-config']) expect(out.join('\n')).toContain(c);
    out = [];
    expect(await run(['help', 'ssh'], ctx())).toBe(0);
    expect(out.join('\n')).toContain('termag ssh <box>[/<project>] [<ssh options>] [-- <cmd>]');
  });
});
