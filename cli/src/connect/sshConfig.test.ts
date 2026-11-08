import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../errors.js';
import { BEGIN_MARKER, END_MARKER, installBlock, proxyCommandFor, renderBlock, sshConfigPath, sshHosts, upsertBlock } from './sshConfig.js';
import type { ConnectBox, ConnectProject } from './target.js';

const block = renderBlock({ user: 'alice', proxyCommand: proxyCommandFor(['/usr/local/bin/termag'], null) });
const newer = renderBlock({ user: 'alice', proxyCommand: proxyCommandFor(['/opt/homebrew/bin/termag'], null) });

const USER_CONFIG = [
  'IdentityFile ~/.ssh/work_ed25519',
  '',
  'Host github.com',
  '  User git',
  '',
  'Host *',
  '  ServerAliveInterval 60',
  '',
].join('\n');

describe('renderBlock', () => {
  it('is one Host termag-* entry that routes through the CLI, then hands back to every host', () => {
    const lines = block.split('\n');
    expect(lines[0]).toBe(BEGIN_MARKER);
    expect(lines.at(-1)).toBe(END_MARKER);
    expect(lines).toContain('Host termag-*');
    expect(lines).toContain('  User alice');
    expect(lines).toContain('  ProxyCommand /usr/local/bin/termag ssh-proxy %h %p');
    expect(lines.at(-2)).toBe('Host *');
  });

  it('puts each per-box user ahead of the wildcard, since ssh keeps the first User it finds', () => {
    const lines = renderBlock({ user: 'alice', proxyCommand: 'p', hostUsers: [{ alias: 'termag-warm', user: 'termag' }] }).split('\n');
    expect(lines.slice(4, 7)).toEqual(['Host termag-warm', '  User termag', 'Host termag-*']);
  });

  it("puts each session host ahead of the wildcard, aimed at its box's alias so the ProxyCommand's %h reaches it", () => {
    const lines = renderBlock({
      user: 'alice', proxyCommand: 'p',
      sessionHosts: [{ alias: 'termag-dev.api', hostName: 'termag-dev', user: 'termag', session: 'alice-api-agent' }],
    }).split('\n');
    expect(lines.slice(4, 10)).toEqual([
      'Host termag-dev.api',
      '  HostName termag-dev',
      '  User termag',
      '  RequestTTY yes',
      '  RemoteCommand tmux attach-session -t alice-api-agent \';\' set-option -w window-size latest',
      'Host termag-*',
    ]);
  });

  it('names a non-default orchestrator and quotes paths for the shell', () => {
    expect(proxyCommandFor(['/Applications/My Node/node', '/x/termag.js'], 'http://localhost:3040/termag'))
      .toBe("'/Applications/My Node/node' /x/termag.js --host http://localhost:3040/termag ssh-proxy %h %p");
  });
});

describe('sshHosts', () => {
  const box = (id: string, name: string, hostUnixUser: string | null): ConnectBox => ({
    id, name, hostUnixUser, addressable: true, kind: 'ec2', state: 'running', status: 'ready', agentConnected: true, error: null, projects: [],
  } as unknown as ConnectBox);
  const project = (boxId: string, name: string, sessions: ConnectProject['sessions']): ConnectProject => ({
    id: `${boxId}-${name}`, name, ref: name, box: { id: boxId, name: boxId }, provider: 'claude', status: 'idle',
    waitingReason: null, rateLimited: null, workstreams: ['main'], sessions,
  });
  const sessions = (name: string) => ({ agent: `alice-${name}-agent`, ctrl: `alice-${name}-ctrl` });

  it("gives each project an agent and a ctrl host as its box's own user, by the session names the API reports", () => {
    const hosts = sshHosts('alice', [box('i1', 'warm', 'termag'), box('i2', 'dev', 'alice')], [
      project('i1', 'web', { agent: 'alice-web-agent', ctrl: 'alice-web-ctrl' }),
      project('i2', 'api', sessions('api')),
    ]);
    expect(hosts.hostUsers).toEqual([{ alias: 'termag-warm', user: 'termag' }]);
    expect(hosts.sessionHosts).toEqual([
      { alias: 'termag-dev.api', hostName: 'termag-dev', user: 'alice', session: 'alice-api-agent' },
      { alias: 'termag-dev.api.ctrl', hostName: 'termag-dev', user: 'alice', session: 'alice-api-ctrl' },
      { alias: 'termag-warm.web', hostName: 'termag-warm', user: 'termag', session: 'alice-web-agent' },
      { alias: 'termag-warm.web.ctrl', hostName: 'termag-warm', user: 'termag', session: 'alice-web-ctrl' },
    ]);
    expect(hosts.skipped).toEqual([]);
  });

  it("skips, and names, a project whose name or session can't go in ssh_config; drops ones it can't reach", () => {
    const hosts = sshHosts('alice', [box('i1', 'dev', null)], [
      project('i1', 'my.app', sessions('my_app')),
      project('i1', 'ok', { agent: 'alice-ok-agent', ctrl: 'x\n  ProxyCommand touch /tmp/pwned' }),
      project('i1', 'old', null),
      project('elsewhere', 'theirs', sessions('theirs')),
    ]);
    expect(hosts.sessionHosts).toEqual([]);
    expect(hosts.skipped).toEqual(['dev/my.app', 'dev/ok']);
  });
});

describe('upsertBlock', () => {
  it('puts the block first and leaves the rest byte for byte', () => {
    const { content, action } = upsertBlock(USER_CONFIG, block);
    expect(action).toBe('added');
    expect(content).toBe(`${block}\n\n${USER_CONFIG}`);
  });

  it('writes just the block into an empty file', () => {
    expect(upsertBlock('', block)).toEqual({ content: `${block}\n`, action: 'added' });
  });

  it('is idempotent', () => {
    const once = upsertBlock(USER_CONFIG, block).content;
    expect(upsertBlock(once, block)).toEqual({ content: once, action: 'unchanged' });
  });

  it('replaces only what is between the markers, wherever they are', () => {
    const moved = `${USER_CONFIG}\n${block}\nHost later\n  Port 2222\n`;
    const { content, action } = upsertBlock(moved, newer);
    expect(action).toBe('updated');
    expect(content).toBe(`${USER_CONFIG}\n${newer}\nHost later\n  Port 2222\n`);
  });

  it('refuses to guess with unmatched or repeated markers', () => {
    for (const broken of [
      `${BEGIN_MARKER}\nHost termag-*\n${USER_CONFIG}`,
      `${USER_CONFIG}\n${END_MARKER}\n`,
      `${block}\n${block}\n`,
      `${END_MARKER}\n${BEGIN_MARKER}\n`,
    ]) {
      expect(() => upsertBlock(broken, block)).toThrow(CliError);
    }
  });
});

describe('installBlock (temp HOME)', () => {
  let home: string;
  let path: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'termag-sshcfg-'));
    path = sshConfigPath(home);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('creates ~/.ssh (0700) and the config (0600) when neither exists', () => {
    const r = installBlock(path, block);
    expect(r).toMatchObject({ action: 'added', backup: null });
    expect(readFileSync(path, 'utf8')).toBe(`${block}\n`);
    expect(statSync(join(home, '.ssh')).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps the user\'s content and mode, and a backup of the previous file', () => {
    mkdirSync(join(home, '.ssh'), { mode: 0o700 });
    writeFileSync(path, USER_CONFIG, { mode: 0o644 });
    const r = installBlock(path, block);
    expect(r.action).toBe('added');
    expect(readFileSync(path, 'utf8')).toBe(`${block}\n\n${USER_CONFIG}`);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readFileSync(r.backup!, 'utf8')).toBe(USER_CONFIG);
  });

  it('does not touch the file when nothing changes', () => {
    installBlock(path, block);
    const before = statSync(path).mtimeMs;
    const r = installBlock(path, block);
    expect(r).toMatchObject({ action: 'unchanged', backup: null });
    expect(statSync(path).mtimeMs).toBe(before);
    expect(readdirSync(join(home, '.ssh')).sort()).toEqual(['config']);
  });

  it('updates the block in place on a re-install', () => {
    mkdirSync(join(home, '.ssh'));
    writeFileSync(path, USER_CONFIG);
    installBlock(path, block);
    expect(installBlock(path, newer).action).toBe('updated');
    expect(readFileSync(path, 'utf8')).toBe(`${newer}\n\n${USER_CONFIG}`);
  });

  it('edits a symlinked config where it lives and keeps the link', () => {
    const dotfiles = join(home, 'dotfiles');
    mkdirSync(dotfiles);
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(dotfiles, 'ssh_config'), USER_CONFIG);
    symlinkSync(join(dotfiles, 'ssh_config'), path);
    const r = installBlock(path, block);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(r.path).toBe(realpathSync(join(dotfiles, 'ssh_config')));
    expect(readFileSync(join(dotfiles, 'ssh_config'), 'utf8')).toBe(`${block}\n\n${USER_CONFIG}`);
  });

  it('leaves a config with damaged markers exactly as it was', () => {
    mkdirSync(join(home, '.ssh'));
    const broken = `${BEGIN_MARKER}\n${USER_CONFIG}`;
    writeFileSync(path, broken);
    expect(() => installBlock(path, block)).toThrow(/unmatched or repeated/);
    expect(readFileSync(path, 'utf8')).toBe(broken);
    expect(readdirSync(join(home, '.ssh'))).toEqual(['config']);
  });
});
