// A session's sign-in time (auth/signInAge.ts), for the preview links' 12-hour
// rule in google and oidc mode (security-review.md SR18).
import { describe, expect, it } from 'vitest';
import type { Session, SessionData } from 'express-session';
import { markSignedIn, PREVIEW_SIGN_IN_MAX_MS, signedInWithin } from './signInAge';

const session = (over: Partial<SessionData> = {}) => ({ ...over }) as unknown as Session & Partial<SessionData>;

describe('signInAge', () => {
  it('marks a sign-in and reads it back within the window', () => {
    const s = session();
    markSignedIn(s, 1_000);
    expect(s.authenticatedAt).toBe(1_000);
    expect(signedInWithin(s, PREVIEW_SIGN_IN_MAX_MS, 1_000 + PREVIEW_SIGN_IN_MAX_MS)).toBe(true);
    expect(signedInWithin(s, PREVIEW_SIGN_IN_MAX_MS, 1_000 + PREVIEW_SIGN_IN_MAX_MS + 1)).toBe(false);
  });

  it('a session with no sign-in on record, or a bad one, is not recent', () => {
    expect(signedInWithin(session(), PREVIEW_SIGN_IN_MAX_MS, 5)).toBe(false);
    expect(signedInWithin(undefined, PREVIEW_SIGN_IN_MAX_MS, 5)).toBe(false);
    expect(signedInWithin(session({ authenticatedAt: Number.NaN }), PREVIEW_SIGN_IN_MAX_MS, 5)).toBe(false);
    expect(signedInWithin(session({ authenticatedAt: 10 }), PREVIEW_SIGN_IN_MAX_MS, 5)).toBe(false);
    expect(PREVIEW_SIGN_IN_MAX_MS).toBe(12 * 3600_000);
  });
});
