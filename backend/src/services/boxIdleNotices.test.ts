import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: { automation: { count: vi.fn(async () => 2) } } }));

const slack = {
  client: null as null | { chat: { postMessage: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } },
  slackId: 'U1' as string | null,
};
vi.mock('../slack/app', () => ({ getSlackApp: () => (slack.client ? { client: slack.client } : null) }));
vi.mock('./briefing/slack', () => ({
  slackEscape: (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  slackIdFor: async () => slack.slackId,
  webBase: () => 'https://termag.example',
}));
const mapped = { user: null as null | { id: string } };
vi.mock('../slack/userMapping', () => ({ resolveTermagUser: async () => mapped.user }));
const kept = { calls: [] as unknown[][], result: { status: 200, body: { lifecycle: { idleLimitHours: 72 } } } as { status: number; body: unknown } };
vi.mock('../routes/instances', () => ({
  keepOwnedBoxRunning: async (...args: unknown[]) => { kept.calls.push(args); return kept.result; },
}));
const events: Array<{ name: string; detail: unknown }> = [];
vi.mock('./productEvents', () => ({ recordProductEvent: (name: string, _ctx: unknown, detail: unknown) => { events.push({ name, detail }); } }));

const {
  aboutDuration, automationsSkippedWhileParked, KEEP_RUNNING_ACTION, parkedMessage, registerBoxIdleSlackActions,
  scanClause, sendIdleNotice, stuckStartMessage, stuckStartWarningMessage, warningMessage,
} = await import('./boxIdleNotices');

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-23T12:00:00Z').getTime();
const box = { id: 'b1', name: 'olive<box>' };
const owner = { id: 'u1', slackUserId: null, googleEmail: 'vic@example.com' };

beforeEach(() => {
  slack.client = { chat: { postMessage: vi.fn(async () => ({ ok: true })), update: vi.fn(async () => ({ ok: true })) } };
  slack.slackId = 'U1';
  mapped.user = null;
  kept.calls = [];
  kept.result = { status: 200, body: { lifecycle: { idleLimitHours: 72 } } };
  events.length = 0;
});

describe('aboutDuration', () => {
  it('rounds to minutes, hours or days', () => {
    expect(aboutDuration(40 * 60_000)).toBe('about 40 minutes');
    expect(aboutDuration(2 * HOUR)).toBe('about 2 hours');
    expect(aboutDuration(24 * HOUR)).toBe('about 24 hours');
    expect(aboutDuration(72 * HOUR)).toBe('about 3 days');
    expect(aboutDuration(0)).toBe('about 1 minute');
  });
});

describe('warningMessage', () => {
  it('says when and why, what survives a stop, and carries Keep running for the box', () => {
    const m = warningMessage(box, { action: 'stop', parkAt: new Date(NOW + 2 * HOUR), idleMs: 70 * HOUR, skippedAutomations: 0 }, NOW);
    expect(m.text).toBe('Your box *olive&lt;box&gt;* will stop in about 2 hours: nothing has happened on it for 3 days. '
      + 'Its disks, projects and checkouts are kept; what runs in its terminals stops with it. Use it, or press Keep running, to keep it up.');
    const actions = (m.blocks[1] as { elements: Array<{ action_id?: string; value?: string; url?: string }> }).elements;
    expect(actions[0]).toMatchObject({ action_id: KEEP_RUNNING_ACTION, value: 'b1' });
    expect(actions[1]).toMatchObject({ url: 'https://termag.example' });
  });

  it('says a hibernated box resumes, and names automations the park will skip', () => {
    const m = warningMessage(box, { action: 'hibernate', parkAt: new Date(NOW + 30 * 60_000), idleMs: 8 * HOUR, skippedAutomations: 2 }, NOW);
    expect(m.text).toMatch(/will hibernate in about 30 minutes/);
    expect(m.text).toMatch(/resumes where it was/);
    expect(m.text).toMatch(/2 automations on it can't wake it, so they are skipped while it is hibernated\./);
  });
});

describe('the warning on a short limit', () => {
  it('says how long in minutes, not "0 hours"', () => {
    const m = warningMessage(box, { action: 'hibernate', parkAt: new Date(NOW + 30 * 60_000), idleMs: 30 * 60_000, skippedAutomations: 0 }, NOW);
    expect(m.text).toMatch(/nothing has happened on it for 30 minutes\./);
  });
});

describe('scanClause', () => {
  it('names the repos with work only on the box, a few of them, and kept checkouts', () => {
    const repos = ['a', 'b', 'c', 'd', 'e'].map(n => ({ path: `/home/vic/src/${n}`, dirty: 1, unpushed: 0, stashes: 0 }));
    expect(scanClause({ repos, errors: [], keptCheckouts: 1 }))
      .toBe('Before it went down, termag found work that exists only on the box: uncommitted or unpushed changes in `a`, `b`, `c` and 2 more, and 1 kept cloud-session checkout. It is all still there.');
  });

  it("never calls a scan clean when some repos couldn't be read", () => {
    const errors = [{ path: '/home/vic/src/app', error: 'git failed' }];
    expect(scanClause({ repos: [], errors, keptCheckouts: 0 }))
      .toBe("Before it went down, termag found no work that exists only on the box in the repos it could read. termag couldn't check one repo on it, so there may be more.");
    expect(scanClause({ repos: [{ path: '/home/vic/src/x' }], errors: [...errors, ...errors], keptCheckouts: 0 }))
      .toMatch(/changes in `x`\. It is all still there\. termag couldn't check 2 repos on it/);
  });

  it('says a clean scan was clean, and a failed or missing one could not tell', () => {
    expect(scanClause({ repos: [], errors: [], keptCheckouts: 0 })).toMatch(/found no work that exists only on the box/);
    expect(scanClause({ error: 'agent not connected' })).toMatch(/couldn't check it/);
    expect(scanClause(null)).toMatch(/couldn't check it/);
  });
});

describe('parkedMessage', () => {
  it('says what a stop kept and lost, and how to get the box back', () => {
    const m = parkedMessage(box, 'stopped', { hours: 72, source: 'default' }, { repos: [], errors: [], keptCheckouts: 0 });
    expect(m.text).toMatch(/^I stopped \*olive&lt;box&gt;\* after 72 hours with no activity \(the default limit\)\. Its disks, projects and checkouts are kept\./);
    expect(m.text).toMatch(/termag box start olive&lt;box&gt;/);
    expect(m.text).toMatch(/Claude picks up the conversation it was in; dev servers and anything else you ran in a terminal need starting again\.$/);
  });

  it('says a hibernated box is where it was', () => {
    const m = parkedMessage(box, 'hibernated', { hours: 8, source: 'own' }, null);
    expect(m.text).toMatch(/^I hibernated \*olive&lt;box&gt;\* after 8 hours with no activity\. Everything is where you left it/);
    expect(m.text).toMatch(/Resume box/);
  });
});

describe('sendIdleNotice', () => {
  it('DMs the owner and records that it went', async () => {
    expect(await sendIdleNotice('warning', owner, box, { text: 't', blocks: [] })).toBe(true);
    expect(slack.client!.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'U1', text: 't' }));
    expect(events).toEqual([{ name: 'box.idle.notice', detail: { kind: 'warning', delivered: true, reason: 'sent' } }]);
  });

  it('records why nothing went: no Slack app, no Slack user, or a post Slack refused', async () => {
    slack.slackId = null;
    expect(await sendIdleNotice('parked', owner, box, { text: 't', blocks: [] })).toBe(false);
    slack.slackId = 'U1';
    slack.client!.chat.postMessage.mockRejectedValueOnce(new Error('channel_not_found'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await sendIdleNotice('parked', owner, box, { text: 't', blocks: [] })).toBe(false);
    slack.client = null;
    expect(await sendIdleNotice('parked', owner, box, { text: 't', blocks: [] })).toBe(false);
    expect(events.map(e => (e.detail as { reason: string }).reason)).toEqual(['no-slack-user', 'post-failed', 'no-slack']);
  });
});

describe('automationsSkippedWhileParked', () => {
  it('counts the enabled automations on the box that cannot wake it', async () => {
    expect(await automationsSkippedWhileParked('b1')).toBe(2);
  });
});

describe('Keep running in Slack', () => {
  function handler() {
    let registered: ((args: any) => Promise<void>) | null = null;
    registerBoxIdleSlackActions({ action: (id: string, fn: any) => { if (id === KEEP_RUNNING_ACTION) registered = fn; } });
    return registered!;
  }
  const click = (fn: (args: any) => Promise<void>) => fn({
    ack: vi.fn(async () => {}), client: slack.client, action: { value: 'b1' },
    body: { user: { id: 'U9' }, container: { channel_id: 'D1', message_ts: '1.2' } },
  });

  it("keeps the clicking owner's box running and edits the message to say so", async () => {
    mapped.user = { id: 'u1' };
    await click(handler());
    expect(kept.calls).toEqual([[{ id: 'u1' }, 'b1', 'slack']]);
    expect(slack.client!.chat.update).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'D1', ts: '1.2', text: 'Kept running. It parks after another 72 hours with no activity.',
    }));
  });

  it("passes on the owner check's refusal, and never acts for a Slack user it can't match", async () => {
    mapped.user = { id: 'someone-else' };
    kept.result = { status: 404, body: { error: 'Box not found' } };
    await click(handler());
    expect(slack.client!.chat.update).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Box not found' }));
    mapped.user = null;
    kept.calls = [];
    await click(handler());
    expect(kept.calls).toEqual([]);
    expect(slack.client!.chat.update).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringMatching(/could not match your Slack account/) }));
  });
});

describe('stuckStartMessage', () => {
  it('says why the box was stopped and what to do', () => {
    const m = stuckStartMessage(box, new Date('2026-10-23T14:02:00Z'));
    expect(m.text).toMatch(/^I stopped \*olive&lt;box&gt;\*: it was started at 14:02 UTC, and its agent never connected/);
    expect(m.text).toMatch(/terminate it if that keeps happening\.$/);
  });
});

describe('stuckStartMessage without a known start', () => {
  it('leaves the time out rather than guess it', () => {
    expect(stuckStartMessage(box, null).text).toMatch(/^I stopped \*olive&lt;box&gt;\*: it was started, and its agent never connected/);
  });
});

describe('stuckStartWarningMessage', () => {
  it('says when the box will be stopped and how to keep it', () => {
    const m = stuckStartWarningMessage(box, new Date('2026-10-23T14:02:00Z'), new Date(NOW + 2 * HOUR), NOW);
    expect(m.text).toMatch(/^Your box \*olive&lt;box&gt;\* was started at 14:02 UTC, and its agent hasn't connected/);
    expect(m.text).toMatch(/It will be stopped in about 2 hours so it stops billing/);
    expect(m.text).toMatch(/systemctl --user restart termag-agent/);
  });
});
