import { describe, it, expect } from 'vitest';
import { legalSessions, isSessionRole, SESSION_ROLES } from './sessionAccess';

describe('legalSessions', () => {
  it('builds every role for main, collapsing the workstream segment', () => {
    expect(legalSessions('alice', 'termag', ['main'])).toEqual([
      'alice-termag-agent', 'alice-termag-ctrl', 'alice-termag-data', 'alice-termag-data-ctrl',
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
