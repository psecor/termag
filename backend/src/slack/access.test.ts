import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebClient } from '@slack/web-api';

vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false) }));
vi.mock('./userMapping', () => ({ resolveTermagUser: vi.fn(async () => null), isKnownMiss: vi.fn(() => true) }));
vi.mock('../services/sessionAccess', () => {
  class SessionAccessError extends Error {}
  return { SessionAccessError, projectSessionAccess: vi.fn() };
});

import {
  allowedSlackUsers, describeSlackGate, slackChatAllowed, slackProjectAccess, slackRefusalText, slackUserAllowed, slackUserRefusal, SLACK_BOT_FLAG,
} from './access';
import { boolVariation } from '../services/featureFlags';
import { isKnownMiss, resolveTermagUser } from './userMapping';
import { projectSessionAccess, SessionAccessError } from '../services/sessionAccess';

const client = {} as WebClient;
const alice = { id: 'u1', googleEmail: 'alice@example.com', displayName: 'Alice', unixUsername: 'alice', defaultAgentProvider: 'claude' };

describe('allowedSlackUsers', () => {
  it('drops the informational :unixuser half and blank entries', () => {
    expect(allowedSlackUsers('U1:alice, U2 ,,U3:')).toEqual(new Set(['U1', 'U2', 'U3']));
  });

  it('is empty when the list names nobody', () => {
    expect(allowedSlackUsers(undefined).size).toBe(0);
    expect(allowedSlackUsers('').size).toBe(0);
    expect(allowedSlackUsers(' , :x').size).toBe(0);
  });
});

describe('slackUserAllowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveTermagUser).mockResolvedValue(null);
    vi.mocked(boolVariation).mockResolvedValue(false);
  });

  it('lets a listed id in without a termag user or the flag', async () => {
    expect(await slackUserAllowed('U1', client, { ALLOWED_SLACK_USERS: 'U1:alice' })).toBe(true);
    expect(resolveTermagUser).not.toHaveBeenCalled();
    expect(boolVariation).not.toHaveBeenCalled();
  });

  it('still lets the flag in someone the list leaves out', async () => {
    vi.mocked(resolveTermagUser).mockResolvedValue(alice as never);
    vi.mocked(boolVariation).mockResolvedValue(true);
    expect(await slackUserAllowed('U2', client, { ALLOWED_SLACK_USERS: 'U1:bob' })).toBe(true);
    expect(boolVariation).toHaveBeenCalledWith(SLACK_BOT_FLAG, alice, false);
  });

  it('refuses someone in neither', async () => {
    vi.mocked(resolveTermagUser).mockResolvedValue(alice as never);
    expect(await slackUserAllowed('U2', client, { ALLOWED_SLACK_USERS: 'U1:bob' })).toBe(false);
    expect(await slackUserAllowed('U2', client, {})).toBe(false);
  });

  it('refuses an unlisted Slack account with no termag user without reading the flag', async () => {
    expect(await slackUserAllowed('U1', client, {})).toBe(false);
    expect(resolveTermagUser).toHaveBeenCalledWith('U1', client);
    expect(boolVariation).not.toHaveBeenCalled();
  });

  it('reads the flag, falling back off, when there is no list', async () => {
    vi.mocked(resolveTermagUser).mockResolvedValue(alice as never);
    vi.mocked(boolVariation).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await slackUserAllowed('U1', client, {})).toBe(true);
    expect(await slackUserAllowed('U1', client, {})).toBe(false);
    expect(boolVariation).toHaveBeenCalledWith(SLACK_BOT_FLAG, alice, false);
  });
});

describe('slackUserRefusal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveTermagUser).mockResolvedValue(null);
    vi.mocked(boolVariation).mockResolvedValue(false);
  });

  it('says why: no termag user, or the flag off; null for a listed id or the flag on', async () => {
    vi.mocked(isKnownMiss).mockReturnValue(true);
    expect(await slackUserRefusal('U1', client, {})).toBe('no-termag-user');
    vi.mocked(resolveTermagUser).mockResolvedValue(alice as never);
    expect(await slackUserRefusal('U1', client, {})).toBe('flag-off');
    vi.mocked(boolVariation).mockResolvedValue(true);
    expect(await slackUserRefusal('U1', client, {})).toBeNull();
    expect(await slackUserRefusal('U9', client, { ALLOWED_SLACK_USERS: 'U9' })).toBeNull();
  });

  it('does not claim there is no account when the Slack lookup failed', async () => {
    vi.mocked(isKnownMiss).mockReturnValue(false);
    expect(await slackUserRefusal('U1', client, {})).toBe('lookup-failed');
    expect(slackRefusalText('lookup-failed')).toMatch(/^termag couldn't check your access just now\./);
    expect(slackRefusalText('lookup-failed')).not.toContain('no account');
  });

  it('points both at the channel to ask in, and an unmatched account at its email', () => {
    expect(slackRefusalText('flag-off')).toBe("You don't have access to termag's `/t` yet. Ask for access in #termag-help.");
    expect(slackRefusalText('no-termag-user')).toMatch(/no account with your Slack email.*#termag-help\.$/);
  });
});

describe('slackProjectAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // u1 owns or was shared p-own; every other project is someone else's.
    vi.mocked(projectSessionAccess).mockImplementation(async (userId, projectId) => {
      if (userId === 'u1' && projectId === 'p-own') return (() => ({})) as never;
      throw new (SessionAccessError as unknown as new (s: number, m: string) => Error)(404, 'Project not found');
    });
  });

  it('gives a listed id every project and the local sessions, without asking', async () => {
    const access = slackProjectAccess('U1', null, { ALLOWED_SLACK_USERS: 'U1:alice' });
    expect(access.unscoped).toBe(true);
    expect(await access.mayReach('p-other')).toBe(true);
    expect(await access.mayReach(null)).toBe(true);
    expect(projectSessionAccess).not.toHaveBeenCalled();
  });

  it('limits someone the flag let in to what their termag user owns or was shared', async () => {
    const access = slackProjectAccess('U2', 'u1', { ALLOWED_SLACK_USERS: 'U1:alice' });
    expect(access.unscoped).toBe(false);
    expect(await access.mayReach('p-own')).toBe(true);
    expect(await access.mayReach('p-other')).toBe(false);
    expect(projectSessionAccess).toHaveBeenCalledWith('u1', 'p-own');
  });

  it('refuses a session no project builds, and everything without a termag user', async () => {
    expect(await slackProjectAccess('U2', 'u1', {}).mayReach(null)).toBe(false);
    expect(await slackProjectAccess('U2', null, {}).mayReach('p-own')).toBe(false);
    expect(projectSessionAccess).not.toHaveBeenCalled();
  });

  it('lets an unexpected error through rather than reading it as a refusal', async () => {
    vi.mocked(projectSessionAccess).mockRejectedValueOnce(new Error('db down'));
    await expect(slackProjectAccess('U2', 'u1', {}).mayReach('p-own')).rejects.toThrow('db down');
  });
});

describe('slackChatAllowed', () => {
  it('keeps the executor to the listed ids, whatever the flag says', () => {
    expect(slackChatAllowed('U1', { ALLOWED_SLACK_USERS: 'U1:alice' })).toBe(true);
    expect(slackChatAllowed('U2', { ALLOWED_SLACK_USERS: 'U1:alice' })).toBe(false);
    expect(slackChatAllowed('U1', {})).toBe(false);
    expect(boolVariation).not.toHaveBeenCalled();
  });
});

describe('describeSlackGate', () => {
  it('names both sources', () => {
    expect(describeSlackGate({ ALLOWED_SLACK_USERS: 'U1:a,U2:b' })).toBe('slack-bot-enabled per termag user (/t into their own projects), plus 2 ids in ALLOWED_SLACK_USERS (any project, DMs and @mentions)');
    expect(describeSlackGate({ ALLOWED_SLACK_USERS: 'U1:a' })).toBe('slack-bot-enabled per termag user (/t into their own projects), plus 1 id in ALLOWED_SLACK_USERS (any project, DMs and @mentions)');
    expect(describeSlackGate({})).toBe('slack-bot-enabled per termag user (/t into their own projects); DMs and @mentions answer nobody without ALLOWED_SLACK_USERS');
  });
});
