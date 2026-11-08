import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebClient } from '@slack/web-api';

const ld = vi.hoisted(() => ({ initialized: true, value: true, calls: [] as Array<{ key: string; context: unknown; fallback: boolean }> }));
vi.mock('./featureFlags', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./featureFlags')>()),
  flagsInitialized: () => ld.initialized,
  boolVariationForContext: vi.fn(async (key: string, context: unknown, fallback: boolean) => {
    ld.calls.push({ key, context, fallback });
    return ld.value;
  }),
}));
vi.mock('./termagVersion', () => ({ termagVersion: async () => ({ sha: 'abc123', source: 'git' }) }));

import { serviceSlackFlagContext, type FlagSlackWorkspace } from './featureFlags';
import {
  BOT_WORKSPACE_RETRY_MS,
  botWorkspaceLookup,
  gateSlackClient,
  resetSlackInteractionsForTests,
  SLACK_OFF_COMMAND_TEXT,
  SLACK_OFF_ERROR,
  slackInteractionsEnabled,
  slackInteractionsMiddleware,
  workspaceOfRequest,
} from './slackInteractionsFlag';

const BOT = { team_id: 'T0BOT', enterprise_id: 'E0ORG', team: 'Main' };

/** A real WebClient whose network layer is a spy (auth.test answers as BOT), then gated. */
function gatedClient(enabled: boolean | ((ws: FlagSlackWorkspace) => boolean), workspace: FlagSlackWorkspace | null = { teamId: 'T0BOT' }) {
  const client = new WebClient('xoxb-test', { retryConfig: { retries: 0 } });
  const sent: string[] = [];
  (client as any).makeRequest = vi.fn(async (url: string) => {
    sent.push(url);
    return { status: 200, headers: {}, request: { path: url }, data: { ok: true, ...BOT } };
  });
  gateSlackClient(client, async () => workspace, async (ws) => (typeof enabled === 'function' ? enabled(ws) : enabled));
  return { client, sent };
}

beforeEach(() => {
  ld.initialized = true;
  ld.value = true;
  ld.calls.length = 0;
  resetSlackInteractionsForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('serviceSlackFlagContext', () => {
  it('is the service context alone with no workspace', () => {
    expect(serviceSlackFlagContext('abc', 'production', null)).toEqual({ kind: 'service', key: 'termag-orchestrator', version: 'abc', environment: 'production' });
  });

  it('adds the workspace and its Enterprise Grid org', () => {
    expect(serviceSlackFlagContext('abc', 'production', { teamId: 'T0ABC', enterpriseId: 'E0ORG', name: 'Main' })).toEqual({
      kind: 'multi',
      service: { key: 'termag-orchestrator', version: 'abc', environment: 'production' },
      'slack-workspace': { key: 'T0ABC', name: 'Main', enterpriseId: 'E0ORG' },
      'slack-org': { key: 'E0ORG' },
    });
  });

  it('adds only the workspace outside Enterprise Grid, and drops ids not in Slack\'s shape', () => {
    expect(serviceSlackFlagContext(null, 'development', { teamId: 'T0ABC' })).toEqual({
      kind: 'multi',
      service: { key: 'termag-orchestrator', environment: 'development' },
      'slack-workspace': { key: 'T0ABC' },
    });
    expect(serviceSlackFlagContext(null, 'development', { teamId: 'not-a-team', enterpriseId: 'nope' })).toEqual({
      kind: 'service', key: 'termag-orchestrator', environment: 'development',
    });
  });
});

describe('slackInteractionsEnabled', () => {
  it('reads the flag for the service + Slack context, falling back on', async () => {
    ld.value = false;
    expect(await slackInteractionsEnabled({ teamId: 'T0ABC' })).toBe(false);
    expect(ld.calls).toEqual([{
      key: 'slack-interactions-enabled',
      context: expect.objectContaining({
        kind: 'multi',
        service: expect.objectContaining({ key: 'termag-orchestrator', version: 'abc123' }),
        'slack-workspace': { key: 'T0ABC' },
      }),
      fallback: true,
    }]);
  });

  it('is off while a flag source is configured but has no flags yet, without evaluating', async () => {
    ld.initialized = false;
    expect(await slackInteractionsEnabled({ teamId: 'T0ABC' })).toBe(false);
    expect(ld.calls).toEqual([]);
  });
});

describe('workspaceOfRequest', () => {
  it('prefers Bolt\'s context, then the payload', () => {
    expect(workspaceOfRequest({ teamId: 'T1', enterpriseId: 'E1' }, { team_id: 'T2' })).toEqual({ teamId: 'T1', enterpriseId: 'E1' });
    expect(workspaceOfRequest({}, { team_id: 'T2', enterprise_id: 'E2' })).toEqual({ teamId: 'T2', enterpriseId: 'E2' });
    expect(workspaceOfRequest(undefined, { team: { id: 'T3' }, enterprise: { id: 'E3' } })).toEqual({ teamId: 'T3', enterpriseId: 'E3' });
    expect(workspaceOfRequest(undefined, {})).toBeNull();
  });
});

describe('botWorkspaceLookup', () => {
  it('asks auth.test once and keeps the answer', async () => {
    const test = vi.fn(async () => BOT);
    const lookup = botWorkspaceLookup({ auth: { test } });
    expect(await lookup()).toEqual({ teamId: 'T0BOT', enterpriseId: 'E0ORG', name: 'Main' });
    await lookup();
    expect(test).toHaveBeenCalledOnce();
  });

  it('after a failure is null, and asks again only once BOT_WORKSPACE_RETRY_MS has passed', async () => {
    let t = 1_000_000;
    const test = vi.fn().mockRejectedValueOnce(new Error('ratelimited')).mockResolvedValue(BOT);
    const lookup = botWorkspaceLookup({ auth: { test } }, () => t);
    expect(await lookup()).toBeNull();
    t += BOT_WORKSPACE_RETRY_MS - 1;
    expect(await lookup()).toBeNull();
    expect(test).toHaveBeenCalledOnce();
    t += 1;
    expect(await lookup()).toEqual(expect.objectContaining({ teamId: 'T0BOT' }));
    expect(test).toHaveBeenCalledTimes(2);
  });

  it('treats an auth.test answer with no team as a failure', async () => {
    const lookup = botWorkspaceLookup({ auth: { test: async () => ({ ok: true }) } });
    expect(await lookup()).toBeNull();
  });

  it('works through a gated client while the switch is off (auth.test is let through)', async () => {
    const client = new WebClient('xoxb-test', { retryConfig: { retries: 0 } });
    const sent: string[] = [];
    (client as any).makeRequest = vi.fn(async (url: string) => {
      sent.push(url);
      return { status: 200, headers: {}, request: { path: url }, data: { ok: true, ...BOT } };
    });
    const lookup = botWorkspaceLookup(client);
    const seen: Array<FlagSlackWorkspace | null> = [];
    gateSlackClient(client, lookup, async (ws) => { seen.push(ws); return false; });
    await expect(client.chat.postMessage({ channel: 'C1', text: 'hi' })).rejects.toMatchObject({ data: { error: SLACK_OFF_ERROR } });
    expect(sent).toEqual(['auth.test']);
    expect(seen).toEqual([{ teamId: 'T0BOT', enterpriseId: 'E0ORG', name: 'Main' }]);
  });
});

describe('gateSlackClient', () => {
  it('on: every method goes through', async () => {
    const { client, sent } = gatedClient(true);
    await client.chat.postMessage({ channel: 'C1', text: 'hi' });
    await client.views.publish({ user_id: 'U1', view: { type: 'home', blocks: [] } });
    expect(sent).toEqual(['chat.postMessage', 'views.publish']);
  });

  it('off: refuses bound methods with a Slack-shaped error, and sends nothing', async () => {
    const { client, sent } = gatedClient(false);
    await expect(client.chat.postMessage({ channel: 'C1', text: 'hi' })).rejects.toMatchObject({
      code: 'slack_webapi_platform_error',
      data: { ok: false, error: SLACK_OFF_ERROR },
    });
    await expect(client.conversations.create({ name: 'x' })).rejects.toMatchObject({ data: { error: SLACK_OFF_ERROR } });
    await expect(client.apiCall('chat.postEphemeral', { channel: 'C1', user: 'U1', text: 'x' })).rejects.toMatchObject({ data: { error: SLACK_OFF_ERROR } });
    expect(sent).toEqual([]);
  });

  it('off: auth.test still goes through, for the Slack MCP sign-in\'s workspace pin', async () => {
    const { client, sent } = gatedClient(false);
    expect((await client.auth.test()).team_id).toBe('T0BOT');
    expect(sent).toEqual(['auth.test']);
  });

  it('decides for the client\'s workspace', async () => {
    const { client, sent } = gatedClient((ws) => ws?.enterpriseId === 'E0ON', { teamId: 'T1', enterpriseId: 'E0ON' });
    await client.chat.postMessage({ channel: 'C1', text: 'hi' });
    expect(sent).toEqual(['chat.postMessage']);
  });

  it('fails closed: with the workspace unknown, refuses even where the flag would say on', async () => {
    const enabled = vi.fn(async () => true);
    const client = new WebClient('xoxb-test', { retryConfig: { retries: 0 } });
    const sent: string[] = [];
    (client as any).makeRequest = vi.fn(async (url: string) => { sent.push(url); return { status: 200, headers: {}, request: { path: url }, data: { ok: true } }; });
    gateSlackClient(client, async () => null, enabled);
    await expect(client.chat.postMessage({ channel: 'C1', text: 'hi' })).rejects.toMatchObject({ data: { error: SLACK_OFF_ERROR } });
    expect(sent).toEqual([]);
    expect(enabled).not.toHaveBeenCalled();
  });

  it('decides per call, so turning the switch back on needs no restart', async () => {
    let on = false;
    const { client, sent } = gatedClient(() => on);
    await expect(client.chat.postMessage({ channel: 'C1', text: 'a' })).rejects.toBeTruthy();
    on = true;
    await client.chat.postMessage({ channel: 'C1', text: 'b' });
    expect(sent).toEqual(['chat.postMessage']);
  });

  it('is idempotent', async () => {
    const { client, sent } = gatedClient(true);
    gateSlackClient(client, async () => null, async () => false);
    await client.chat.postMessage({ channel: 'C1', text: 'hi' });
    expect(sent).toEqual(['chat.postMessage']);
  });
});

describe('slackInteractionsMiddleware', () => {
  it('off: acks a slash command with the notice, and runs no listener', async () => {
    const ack = vi.fn(async () => {});
    const next = vi.fn(async () => {});
    await slackInteractionsMiddleware(async () => false)({ command: { command: '/t' }, ack, next });
    expect(ack).toHaveBeenCalledWith({ response_type: 'ephemeral', text: SLACK_OFF_COMMAND_TEXT });
    expect(next).not.toHaveBeenCalled();
  });

  it('off: acks an action or view with nothing, and drops an event (no ack)', async () => {
    const ack = vi.fn(async () => {});
    const next = vi.fn(async () => {});
    await slackInteractionsMiddleware(async () => false)({ body: { type: 'block_actions' }, ack, next });
    expect(ack).toHaveBeenCalledWith();
    await slackInteractionsMiddleware(async () => false)({ body: { type: 'event_callback' }, next });
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed: a request naming no workspace is dropped without asking the flag', async () => {
    const enabled = vi.fn(async () => true);
    const ack = vi.fn(async () => {});
    const next = vi.fn(async () => {});
    await slackInteractionsMiddleware(enabled)({ command: { command: '/t' }, body: {}, ack, next });
    expect(next).not.toHaveBeenCalled();
    expect(enabled).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ response_type: 'ephemeral', text: SLACK_OFF_COMMAND_TEXT });
  });

  it('decides for the request\'s workspace and org', async () => {
    const seen: Array<FlagSlackWorkspace | null> = [];
    const next = vi.fn(async () => {});
    const mw = slackInteractionsMiddleware(async (ws) => { seen.push(ws); return ws?.teamId === 'T0ON'; });
    await mw({ context: { teamId: 'T0ON', enterpriseId: 'E0ORG' }, body: {}, next });
    await mw({ context: { teamId: 'T0OFF' }, body: {}, next });
    expect(next).toHaveBeenCalledOnce();
    expect(seen).toEqual([{ teamId: 'T0ON', enterpriseId: 'E0ORG' }, { teamId: 'T0OFF', enterpriseId: null }]);
  });

  it('on: gates the listener\'s client and runs the listener', async () => {
    const listenerClient = new WebClient('xoxb-test');
    const next = vi.fn(async () => {});
    await slackInteractionsMiddleware(async () => true)({ context: { teamId: 'T0ON' }, body: { type: 'event_callback' }, client: listenerClient, next });
    expect(next).toHaveBeenCalledOnce();
    const wrapped = (listenerClient as any).makeRequest;
    gateSlackClient(listenerClient, async () => null);
    expect((listenerClient as any).makeRequest).toBe(wrapped);
  });
});
