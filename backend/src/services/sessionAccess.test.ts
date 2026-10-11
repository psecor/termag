import { describe, it, expect } from 'vitest';
import { legalSessions, isSessionRole, isOnCallerHost, SESSION_ROLES } from './sessionAccess';

describe('legalSessions', () => {
  it('builds every role for main, collapsing the workstream segment', () => {
    expect(legalSessions('alice', 'termag', ['main'])).toEqual([
      'alice-termag-agent', 'alice-termag-ctrl', 'alice-termag-data', 'alice-termag-data-ctrl', 'alice-termag-review',
    ]);
  });
  it('threads non-main workstreams through the name', () => {
    expect(legalSessions('alice', 'termag', ['feature'])).toContain('alice-termag-feature-agent');
    expect(legalSessions('alice', 'termag', ['feature'])).toContain('alice-termag-feature-data-ctrl');
  });
  it('defaults to main when a project has no workstreams', () => {
    expect(legalSessions('alice', 'termag', [])).toEqual(legalSessions('alice', 'termag', ['main']));
  });
  it('covers all workstreams × roles', () => {
    expect(legalSessions('alice', 'p', ['main', 'a', 'b'])).toHaveLength(3 * SESSION_ROLES.length);
  });
  it('handles hyphenated project and workstream names verbatim', () => {
    expect(legalSessions('alice', 'ic-okr-viewer', ['small-fixes']))
      .toContain('alice-ic-okr-viewer-small-fixes-agent');
  });
});

describe('isSessionRole', () => {
  it('accepts the four roles and rejects anything else', () => {
    for (const r of SESSION_ROLES) expect(isSessionRole(r)).toBe(true);
    expect(isSessionRole('shell')).toBe(false);
    expect(isSessionRole('')).toBe(false);
    expect(isSessionRole(undefined)).toBe(false);
  });
});

describe('isOnCallerHost', () => {
  it('matches a box token to projects on that box only', () => {
    expect(isOnCallerHost('box-1', 'box-1')).toBe(true);
    expect(isOnCallerHost('box-2', 'box-1')).toBe(false);
    expect(isOnCallerHost(null, 'box-1')).toBe(false);
  });
  it('matches a per-user token to box-less projects', () => {
    expect(isOnCallerHost(null, null)).toBe(true);
    expect(isOnCallerHost('box-1', null)).toBe(false);
  });
  it('is false for a browser session, which has no host', () => {
    expect(isOnCallerHost(null, undefined)).toBe(false);
    expect(isOnCallerHost('box-1', undefined)).toBe(false);
  });
});
