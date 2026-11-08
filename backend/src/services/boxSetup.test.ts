import { describe, it, expect } from 'vitest';
import { boxSetupRefusal, decideBoxSetup, isSetupOff, parseSetupEnabled, SETUP_DISABLED_CODE, setupOffRefusal } from './boxSetup';

describe('parseSetupEnabled', () => {
  it('reads absent as on, and takes true and false', () => {
    expect(parseSetupEnabled(undefined)).toEqual({ setupEnabled: true });
    expect(parseSetupEnabled(null)).toEqual({ setupEnabled: true });
    expect(parseSetupEnabled(true)).toEqual({ setupEnabled: true });
    expect(parseSetupEnabled(false)).toEqual({ setupEnabled: false });
  });

  it('refuses anything that isn\'t a boolean rather than guessing', () => {
    expect(parseSetupEnabled('false')).toHaveProperty('error');
    expect(parseSetupEnabled(0)).toHaveProperty('error');
    expect(parseSetupEnabled('minimal')).toHaveProperty('error');
  });
});

describe('decideBoxSetup', () => {
  const offRepo = { setupEnabled: false, repos: ['acme/app'] };

  it('takes what was asked over the repo\'s setting, both ways', () => {
    expect(decideBoxSetup(true, offRepo)).toEqual({ setupEnabled: true, from: 'asked', repos: [] });
    expect(decideBoxSetup(false, { setupEnabled: true, repos: [] })).toEqual({ setupEnabled: false, from: 'asked', repos: [] });
  });

  it('takes the repo\'s setupEnabled: false when nothing was asked, and says where it came from', () => {
    expect(decideBoxSetup(undefined, offRepo)).toEqual({ setupEnabled: false, from: 'repo', repos: ['acme/app'] });
  });

  it('is on with no repo setting, or one the caller did not state (null)', () => {
    expect(decideBoxSetup(undefined, null)).toEqual({ setupEnabled: true, from: 'default', repos: [] });
    expect(decideBoxSetup(undefined, { setupEnabled: null, repos: [] })).toEqual({ setupEnabled: true, from: 'default', repos: [] });
    expect(decideBoxSetup(undefined, { setupEnabled: true, repos: [] })).toEqual({ setupEnabled: true, from: 'default', repos: [] });
  });

  it('refuses a value that isn\'t a boolean even when the repo has a setting', () => {
    expect(decideBoxSetup('off', offRepo)).toHaveProperty('error');
  });
});

describe('boxSetupRefusal', () => {
  it('never refuses setup on, whatever the flag', () => {
    expect(boxSetupRefusal(true, 'ec2', false)).toBeNull();
    expect(boxSetupRefusal(true, 'external', false)).toBeNull();
  });

  it('needs the flag to turn setup off', () => {
    expect(boxSetupRefusal(false, 'ec2', true)).toBeNull();
    const refused = boxSetupRefusal(false, 'ec2', false);
    expect(refused?.status).toBe(403);
    expect(refused?.body).toMatchObject({ code: 'setup_off_not_enabled' });
  });

  it('refuses setup off on an external box: termag never sets one up anyway', () => {
    expect(boxSetupRefusal(false, 'external', true)?.status).toBe(400);
  });
});

describe('isSetupOff', () => {
  it('is true only for a stored false', () => {
    expect(isSetupOff({ setupEnabled: false })).toBe(true);
    expect(isSetupOff({ setupEnabled: true })).toBe(false);
    expect(isSetupOff({})).toBe(false);
    expect(isSetupOff(null)).toBe(false);
  });
});

describe('setupOffRefusal', () => {
  it('is a 409 setup_disabled that says termag setup is off on this box', () => {
    const r = setupOffRefusal('Hand off');
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'Hand off: termag setup is off on this box', code: SETUP_DISABLED_CODE });
    expect(SETUP_DISABLED_CODE).toBe('setup_disabled');
  });
});
