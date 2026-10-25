import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CliError } from '../errors.js';
import { BEGIN_MARKER, END_MARKER, installBlock, proxyCommandFor, renderBlock, sshConfigPath, upsertBlock } from './sshConfig.js';

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
    expect(lines.slice(3, 6)).toEqual(['Host termag-warm', '  User termag', 'Host termag-*']);
  });

  it('names a non-default orchestrator and quotes paths for the shell', () => {
    expect(proxyCommandFor(['/Applications/My Node/node', '/x/termag.js'], 'http://localhost:3040/termag'))
      .toBe("'/Applications/My Node/node' /x/termag.js --host http://localhost:3040/termag ssh-proxy %h %p");
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
