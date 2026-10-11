import { describe, expect, it } from 'vitest';
import { githubOrgLine } from './githubOrgCopy';

const SSO = 'https://github.com/orgs/example-org/sso?authorization_request=1';

describe('githubOrgLine', () => {
  it('uses the org name when access is ok', () => {
    expect(githubOrgLine('example-org', { status: 'ok' })).toEqual({ text: 'example-org' });
  });

  it('links the SSO sentence only when the authorize URL is present', () => {
    expect(githubOrgLine('example-org', { status: 'sso-required', ssoUrl: SSO })).toEqual({
      text: 'Authorize this token for example-org SSO',
      href: SSO,
    });
    expect(githubOrgLine('example-org', { status: 'sso-required', ssoUrl: null })).toEqual({
      text: 'Authorize this token for example-org SSO',
    });
  });

  it('uses the app-policy, rate-limit, and error sentences', () => {
    expect(githubOrgLine('example-labs', { status: 'app-policy' })).toEqual({
      text: 'example-labs restricts OAuth apps; ask an org owner to approve GitHub CLI',
    });
    expect(githubOrgLine('example-org', { status: 'rate-limited', retryAfter: null })).toEqual({
      text: 'GitHub rate-limited requests for example-org. Try again later.',
    });
    expect(githubOrgLine('example-org', { status: 'error', retryAfter: '2023-11-14T22:14:20.000Z' })).toEqual({
      text: 'Could not reach GitHub to check example-org. Try Re-check.',
    });
  });
});
