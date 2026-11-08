import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredOAuth, OAuthClient, PreregisteredClient } from './mcpOAuth';
import { authorizeTeam, resetSlackTeamForTests } from './mcpOAuthSlackTeam';

// A Slack sign-in with the termag app (undistributed) must land in the app's
// own workspace, or Slack answers invalid_team_for_non_distributed_app.

const SLACK: DiscoveredOAuth = {
  resource: 'https://mcp.slack.com', scopes: [], issuer: 'https://mcp.slack.com',
  authorizationEndpoint: 'https://slack.com/oauth/v2_user/authorize', tokenEndpoint: 'https://slack.com/api/oauth.v2.user.access',
  registrationEndpoint: null, revocationEndpoint: null, cimdSupported: false, tokenAuthMethods: ['client_secret_post'],
};
const PRE_CLIENT: OAuthClient = {
  clientId: '111.222', authMethod: 'client_secret_post', via: 'preregistered', redirectUri: 'https://t.example/cb', issuer: SLACK.issuer, resource: SLACK.resource,
};
const PRE: PreregisteredClient = { issuer: SLACK.issuer, resource: SLACK.resource, clientId: '111.222', clientSecret: 's', tokenTypes: ['user'] };
const bot = (team_id: unknown = 'T0BOTTEAM') => ({ auth: { test: vi.fn(async () => ({ team_id: team_id as string })) } });

afterEach(() => { resetSlackTeamForTests(); vi.restoreAllMocks(); });

describe('authorizeTeam', () => {
  it("pins the bot's own workspace, asking Slack once per process", async () => {
    const b = bot();
    expect(await authorizeTeam(SLACK, PRE_CLIENT, PRE, () => b)).toBe('T0BOTTEAM');
    expect(await authorizeTeam(SLACK, PRE_CLIENT, PRE, () => b)).toBe('T0BOTTEAM');
    expect(b.auth.test).toHaveBeenCalledTimes(1);
  });

  it("prefers the entry's own team, without asking Slack", async () => {
    const b = bot();
    expect(await authorizeTeam(SLACK, PRE_CLIENT, { ...PRE, team: 'T0OVERRIDE' }, () => b)).toBe('T0OVERRIDE');
    expect(b.auth.test).not.toHaveBeenCalled();
  });

  it('pins nothing for a client termag registered itself, or a server that is not Slack', async () => {
    const b = bot();
    expect(await authorizeTeam(SLACK, { ...PRE_CLIENT, via: 'dcr' }, null, () => b)).toBeUndefined();
    const other = { ...SLACK, authorizationEndpoint: 'https://auth.example.test/authorize' };
    expect(await authorizeTeam(other, PRE_CLIENT, { ...PRE, team: 'T0OVERRIDE' }, () => b)).toBeUndefined();
    expect(b.auth.test).not.toHaveBeenCalled();
  });

  it('pins nothing when the bot is off, or auth.test fails or names no workspace, and asks again next time', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await authorizeTeam(SLACK, PRE_CLIENT, PRE, () => null)).toBeUndefined();
    const failing = { auth: { test: vi.fn(async () => { throw new Error('invalid_auth'); }) } };
    expect(await authorizeTeam(SLACK, PRE_CLIENT, PRE, () => failing)).toBeUndefined();
    expect(await authorizeTeam(SLACK, PRE_CLIENT, PRE, () => bot(null))).toBeUndefined();
    expect(await authorizeTeam(SLACK, PRE_CLIENT, PRE, () => bot('T0LATER'))).toBe('T0LATER');
  });
});
