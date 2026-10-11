import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  awsProfileSection, findTermagSshHost, parseGhInclude, sshKeyFingerprint, ssoAuthorizeUrl,
} from './doctorProbes.js';

describe('sshKeyFingerprint', () => {
  it('matches ssh-keygen -l', () => {
    const line = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKnbhDvvH07XKgxlKXX+HRQGWFLB4n2HqtXIJ6PVTD08 zane@mbp';
    expect(sshKeyFingerprint(line)).toBe('SHA256:e1+nD9oAue2SZcEGu9zqWJMnh871OtkTv+69yFXcXj0');
  });

  it('is null for something that is not a key line', () => {
    expect(sshKeyFingerprint('')).toBeNull();
    expect(sshKeyFingerprint('ssh-ed25519')).toBeNull();
    expect(sshKeyFingerprint('ssh-ed25519 not*base64')).toBeNull();
  });
});

describe('awsProfileSection', () => {
  const text = [
    '[default]', 'region = us-east-1', '',
    '[profile termag-boxes-old]', 'sso_account_id = 1',
    '[profile termag-boxes]  ', 'sso_account_id = 123456789012 # the Termag account', 'sso_role_name=TermagUser',
    '[sso-session other]', 'sso_region = us-east-1',
  ].join('\n');

  it('reads one profile, not one whose name it prefixes', () => {
    expect(awsProfileSection(text, 'termag-boxes')).toEqual({ sso_account_id: '123456789012', sso_role_name: 'TermagUser' });
    expect(awsProfileSection(text, 'default')).toEqual({ region: 'us-east-1' });
  });

  it('is null for a missing profile or file', () => {
    expect(awsProfileSection(text, 'nope')).toBeNull();
    expect(awsProfileSection(null, 'termag-boxes')).toBeNull();
  });

});

describe('parseGhInclude', () => {
  it('reads the status and the SSO header', () => {
    const out = 'HTTP/2.0 403 Forbidden\r\nContent-Type: application/json\r\n'
      + 'X-Github-Sso: required; url=https://github.com/orgs/example-org/sso?authorization_request=abc\r\n\r\n{"message":"Resource protected"}';
    const res = parseGhInclude(out);
    expect(res.status).toBe(403);
    expect(ssoAuthorizeUrl(res.sso)).toBe('https://github.com/orgs/example-org/sso?authorization_request=abc');
  });

  it('ignores a body that looks like a header', () => {
    expect(parseGhInclude('HTTP/2.0 200 OK\n\nX-Github-Sso: required; url=x')).toEqual({ status: 200, sso: null });
    expect(parseGhInclude('')).toEqual({ status: null, sso: null });
  });
});

describe('findTermagSshHost', () => {
  let home: string;
  const read = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
  const list = (p: string) => { try { return readdirSync(p); } catch { return []; } };
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'termag-doctor-ssh-')); mkdirSync(join(home, '.ssh', 'config.d'), { recursive: true }); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('finds the entry in ~/.ssh/config', () => {
    writeFileSync(join(home, '.ssh', 'config'), 'Host github.com\n  User git\n\nHost termag-*\n  ProxyCommand termag ssh-proxy %h %p\n');
    expect(findTermagSshHost(home, read, list)).toEqual({ path: join(home, '.ssh', 'config'), managed: false });
  });

  it('knows the block termag ssh-config --install writes', () => {
    writeFileSync(join(home, '.ssh', 'config'), [
      '# >>> termag ssh-config >>>',
      '# Managed by `termag ssh-config --install`, which replaces everything between these markers.',
      'Host termag-*',
      '  User zane',
      "  ProxyCommand '/usr/local/bin/termag' ssh-proxy %h %p",
      'Host *',
      '# <<< termag ssh-config <<<',
      '',
      'Host github.com',
    ].join('\n'));
    expect(findTermagSshHost(home, read, list)).toEqual({ path: join(home, '.ssh', 'config'), managed: true });
  });

  it('follows Include, relative and globbed', () => {
    writeFileSync(join(home, '.ssh', 'config'), 'Include config.d/*\nHost *\n  ServerAliveInterval 30\n');
    writeFileSync(join(home, '.ssh', 'config.d', 'termag'), 'Host termag-*\n  User zane\n');
    expect(findTermagSshHost(home, read, list)?.path).toBe(join(home, '.ssh', 'config.d', 'termag'));
  });

  it('does not count a comment, a negation or an unrelated host', () => {
    writeFileSync(join(home, '.ssh', 'config'), '# Host termag-*\nHost !termag-x other\nHost termagic\n');
    expect(findTermagSshHost(home, read, list)).toBeNull();
  });

  it('survives an include loop and a missing file', () => {
    writeFileSync(join(home, '.ssh', 'config'), 'Include ~/.ssh/config\nInclude missing\n');
    expect(findTermagSshHost(home, read, list)).toBeNull();
    rmSync(join(home, '.ssh'), { recursive: true });
    expect(findTermagSshHost(home, read, list)).toBeNull();
  });
});
