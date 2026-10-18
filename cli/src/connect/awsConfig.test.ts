import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AWS_BEGIN_MARKER, AWS_END_MARKER, awsConfigPath, installAwsProfile, parseAwsCliVersion, profileState,
  removeAwsProfile, renderAwsBlock, supportsSsoSession,
} from './awsConfig.js';

const LEGACY = `[profile termag-boxes]
sso_start_url = https://your-org.awsapps.com/start/
sso_region = us-east-1
sso_account_id = 123456789012
sso_role_name = TermagUser
region = us-east-2
`;

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'termag-awsconfig-'));
  path = join(dir, '.aws', 'config');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('renderAwsBlock', () => {
  it('writes the profile in the [sso-session] form, which gets a refresh token', () => {
    const block = renderAwsBlock('termag-boxes');
    expect(block.split('\n')).toEqual([
      AWS_BEGIN_MARKER,
      expect.stringContaining('termag CLI'),
      '[sso-session termag]',
      'sso_start_url = https://your-org.awsapps.com/start/',
      'sso_region = us-east-1',
      'sso_registration_scopes = sso:account:access',
      '',
      '[profile termag-boxes]',
      'sso_session = termag',
      'sso_account_id = 123456789012',
      'sso_role_name = TermagUser',
      'region = us-east-2',
      AWS_END_MARKER,
    ]);
  });
});

describe('the AWS CLI version', () => {
  it('reads v2 and v1 output', () => {
    expect(parseAwsCliVersion('aws-cli/2.15.30 Python/3.11.8 Darwin/23.4.0 exe/x86_64 prompt/off')).toEqual([2, 15]);
    expect(parseAwsCliVersion('aws-cli/1.29.0 Python/3.9 Linux/6')).toEqual([1, 29]);
    expect(parseAwsCliVersion('command not found')).toBeNull();
  });

  it('needs 2.9 or later for [sso-session]', () => {
    expect(supportsSsoSession([2, 9])).toBe(true);
    expect(supportsSsoSession([2, 15])).toBe(true);
    expect(supportsSsoSession([3, 0])).toBe(true);
    expect(supportsSsoSession([2, 8])).toBe(false);
    expect(supportsSsoSession([1, 29])).toBe(false);
  });
});

describe('profileState', () => {
  it('tells termag\'s profile from the user\'s, and the legacy form from the new one', () => {
    expect(profileState('', 'termag-boxes')).toBe('missing');
    expect(profileState('[profile other]\nregion = us-east-1\n', 'termag-boxes')).toBe('missing');
    expect(profileState(renderAwsBlock('termag-boxes'), 'termag-boxes')).toBe('managed');
    expect(profileState(LEGACY, 'termag-boxes')).toBe('own-legacy');
    expect(profileState('[profile termag-boxes]\nsso_session = mine\n', 'termag-boxes')).toBe('own');
    expect(profileState('[default]\nregion = us-east-1\n', 'default')).toBe('own');
  });

  it('calls termag\'s block shadowed when the user\'s file defines the same profile or session too', () => {
    const ours = renderAwsBlock('termag-boxes');
    expect(profileState(`${ours}\n\n${LEGACY}`, 'termag-boxes')).toBe('shadowed');
    expect(profileState(`${LEGACY}\n${ours}\n`, 'termag-boxes')).toBe('shadowed');
    expect(profileState(`${ours}\n[sso-session termag]\nsso_start_url = x\n`, 'termag-boxes')).toBe('shadowed');
    expect(profileState(`${ours}\n[profile example-org-default]\nsso_start_url = x\n`, 'termag-boxes')).toBe('managed');
  });

  it('ignores comments and spacing inside headers', () => {
    expect(profileState('# [profile termag-boxes]\n[ profile   termag-boxes ]\nsso_start_url=x\n', 'termag-boxes'))
      .toBe('own-legacy');
  });
});

describe('installAwsProfile', () => {
  it('creates ~/.aws/config with 0600 when there is none', () => {
    const result = installAwsProfile(path, 'termag-boxes');
    expect(result).toMatchObject({ action: 'added', backup: null });
    expect(readFileSync(path, 'utf8')).toBe(`${renderAwsBlock('termag-boxes')}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('appends after the user\'s profiles, keeps them, and backs the file up', () => {
    mkdirSync(join(dir, '.aws'));
    writeFileSync(path, '[default]\nregion = us-east-1\n\n\n', { mode: 0o644 });
    const result = installAwsProfile(path, 'termag-boxes');
    expect(result.action).toBe('added');
    expect(readFileSync(path, 'utf8')).toBe(`[default]\nregion = us-east-1\n\n${renderAwsBlock('termag-boxes')}\n`);
    expect(readFileSync(`${path}.termag-backup`, 'utf8')).toBe('[default]\nregion = us-east-1\n\n\n');
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  it('is a no-op when current and rewrites only between the markers when not', () => {
    mkdirSync(join(dir, '.aws'));
    const stale = renderAwsBlock('termag-boxes').replace('region = us-east-2', 'region = us-west-1');
    writeFileSync(path, `[default]\nregion = us-east-1\n\n${stale}\n\n[profile after]\nregion = eu-west-1\n`);
    expect(installAwsProfile(path, 'termag-boxes').action).toBe('updated');
    const updated = readFileSync(path, 'utf8');
    expect(updated).toBe(`[default]\nregion = us-east-1\n\n${renderAwsBlock('termag-boxes')}\n\n[profile after]\nregion = eu-west-1\n`);
    expect(installAwsProfile(path, 'termag-boxes').action).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toBe(updated);
  });

  it('edits a symlinked config where it lives', () => {
    const real = join(dir, 'dotfiles-aws-config');
    writeFileSync(real, '[default]\n');
    mkdirSync(join(dir, '.aws'));
    symlinkSync(real, path);
    installAwsProfile(path, 'termag-boxes');
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toContain('[sso-session termag]');
  });

  it('leaves the user\'s own profile or sso-session of the same name alone', () => {
    mkdirSync(join(dir, '.aws'));
    writeFileSync(path, LEGACY);
    expect(() => installAwsProfile(path, 'termag-boxes')).toThrow('its own `termag-boxes` profile');
    writeFileSync(path, '[sso-session termag]\nsso_start_url = https://example.awsapps.com/start\n');
    expect(() => installAwsProfile(path, 'termag-boxes')).toThrow('`[sso-session termag]` of its own');
    expect(readFileSync(path, 'utf8')).toBe('[sso-session termag]\nsso_start_url = https://example.awsapps.com/start\n');
  });

  it('refuses damaged markers', () => {
    mkdirSync(join(dir, '.aws'));
    writeFileSync(path, `${AWS_BEGIN_MARKER}\n[profile x]\n`);
    expect(() => installAwsProfile(path, 'termag-boxes')).toThrow('termag markers in ~/.aws/config are unmatched');
  });
});

describe('removeAwsProfile', () => {
  it('takes out exactly what installAwsProfile put in', () => {
    mkdirSync(join(dir, '.aws'));
    const before = '[default]\nregion = us-east-1\n';
    writeFileSync(path, before);
    installAwsProfile(path, 'termag-boxes');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n${LEGACY}`);
    expect(removeAwsProfile(path)).toMatchObject({ removed: true });
    expect(readFileSync(path, 'utf8')).toBe(`${before}\n${LEGACY}`);
    expect(profileState(readFileSync(path, 'utf8'), 'termag-boxes')).toBe('own-legacy');
  });

  it('is a no-op without the block', () => {
    mkdirSync(join(dir, '.aws'));
    writeFileSync(path, LEGACY);
    expect(removeAwsProfile(path)).toMatchObject({ removed: false, backup: null });
    expect(readFileSync(path, 'utf8')).toBe(LEGACY);
  });
});

describe('awsConfigPath', () => {
  it('follows AWS_CONFIG_FILE like the AWS CLI', () => {
    expect(awsConfigPath({}, '/home/a')).toBe('/home/a/.aws/config');
    expect(awsConfigPath({ AWS_CONFIG_FILE: '/tmp/cfg' }, '/home/a')).toBe('/tmp/cfg');
  });
});
