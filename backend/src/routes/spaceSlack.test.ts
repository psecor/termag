import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../slack/app', () => ({ getSlackApp: () => null }));

import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { spaceSlackRouter } from './spaceSlack';
import type { SpaceCaller } from '../services/spaces/spaceAccess';
import { MemorySpaceStore } from '../services/spaces/spacesTestkit';
import { createFakeWorkspace, fakeSlackId, fakeWorkspaceEnabled, type FakeWorkspace } from '../services/spaceSlack/fakeWorkspace';
import { DEFAULT_SPACE_SLACK_LIMITS, type SpaceSlackLimits } from '../services/spaceSlack/limits';
import type { ManageDeps } from '../services/spaceSlack/manage';
import { memoryAdminStore } from '../services/spaceSlack/manageTestkit';
import { MemorySpaceSlackStore } from '../services/spaceSlack/spaceSlackTestkit';
import type { ThreadFreezer } from '../services/spaceSlack/link';

let spaces: MemorySpaceStore;
let store: MemorySpaceSlackStore;
let ws: FakeWorkspace;
let flagOn: Set<string>;
let limits: SpaceSlackLimits;
let slackOff: boolean;
let server: Server;
/** The admin store, with an optional hook that runs after markDisabled (a link landing mid-disable). */
let afterDisable: (() => Promise<void>) | null;
let freezer: ThreadFreezer | undefined;
function adminFor() {
  const admin = memoryAdminStore(store, spaces);
  const markDisabled = admin.markDisabled;
  admin.markDisabled = async (id, at) => { const r = await markDisabled(id, at); if (afterDisable) { const hook = afterDisable; afterDisable = null; await hook(); } return r; };
  return admin;
}
let origin: string;

function services(): Promise<ManageDeps & { slack: FakeWorkspace['client'] | null }> {
  return Promise.resolve({
    spaces, store: ws.wrapStore(store), admin: adminFor(), slack: slackOff ? null : ws.client, botUserId: ws.botUserId,
    ...(freezer ? { freezer } : {}),
    channelsEnabled: async (id: string) => flagOn.has(id),
    limitsFor: async () => limits,
  });
}

const caller = (r: express.Request): SpaceCaller | null => {
  const user = r.get('x-user');
  if (!user) return null;
  const box = r.get('x-box');
  return box ? { kind: 'box', userId: user, instanceId: box } : { kind: 'user', userId: user };
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/web', spaceSlackRouter({ services, caller, via: 'web', slackMode: () => 'fake' }));
  app.use('/cli', spaceSlackRouter({ services, caller, via: 'cli' }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

beforeEach(async () => {
  spaces = new MemorySpaceStore();
  store = new MemorySpaceSlackStore();
  ws = createFakeWorkspace();
  flagOn = new Set(['alice', 'bob', 'carol', 'dave']);
  limits = { ...DEFAULT_SPACE_SLACK_LIMITS };
  slackOff = false;
  afterDisable = null;
  freezer = undefined;
  for (const id of ['alice', 'bob', 'carol', 'dave']) spaces.addUser(id);
  spaces.addBox('alice-box', 'alice', 'alice-box');
  spaces.addBox('bob-box', 'bob', 'bob-box');
  // payments: alice owns, bob owns, carol edits. billing: dave's alone.
  const payments = await spaces.createSpace({ name: 'payments', description: null, userId: 'alice' });
  spaces.memberRows.push({ spaceId: payments.id, userId: 'bob', role: 'owner', createdAt: new Date() });
  spaces.memberRows.push({ spaceId: payments.id, userId: 'carol', role: 'editor', createdAt: new Date() });
  await spaces.createSpace({ name: 'billing', description: null, userId: 'dave' });
  // Every user has a fake Slack id once the store has been asked for it, as on staging.
  await ws.wrapStore(store).slackIdsOf(['alice', 'bob', 'carol', 'dave']);
});

async function call(method: string, path: string, opts: { as?: string; box?: string; body?: unknown; via?: 'web' | 'cli' } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.as) headers['x-user'] = opts.as;
  if (opts.box) headers['x-box'] = opts.box;
  const res = await fetch(`${origin}/${opts.via ?? 'web'}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const linkGeneral = (as = 'alice', via: 'web' | 'cli' = 'web') =>
  call('POST', '/payments/slack/channels', { as, via, body: { channelId: 'C0FAKEGEN1' } });

describe('GET /:space/slack', () => {
  it('answers 404 space_channels_off while the flag is off, the space\'s own 404 for a non-member, and not enabled at first', async () => {
    flagOn.delete('alice');
    expect((await call('GET', '/payments/slack', { as: 'alice' })).body.code).toBe('space_channels_off');
    expect((await call('GET', '/payments/slack', { as: 'dave' })).body.code).toBe('not_found');
    expect((await call('GET', '/payments/slack')).status).toBe(401);
    const r = await call('GET', '/payments/slack', { as: 'carol' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ space: 'payments', enabled: false, channels: [], runner: null, caps: { channelsPerSpace: 5, allowPrivate: true }, you: { owner: false }, slack: 'fake' });
  });

  it('lets a box granted the space read the status', async () => {
    const { id } = (await spaces.findSpace('payments'))!;
    await spaces.addGrant(id, 'alice-box', 'alice');
    expect((await call('GET', '/payments/slack', { as: 'alice', box: 'alice-box' })).status).toBe(200);
  });
});

describe('owners only (confirmed decision 1)', () => {
  it('refuses an editor, and a box token on every write', async () => {
    const editor = await call('POST', '/payments/slack/channels/preview', { as: 'carol', body: { channelId: 'C0FAKEGEN1' } });
    expect(editor).toMatchObject({ status: 403, body: { code: 'not_owner' } });
    await spaces.addGrant((await spaces.findSpace('payments'))!.id, 'alice-box', 'alice');
    const box = await call('POST', '/payments/slack/channels', { as: 'alice', box: 'alice-box', body: { channelId: 'C0FAKEGEN1' } });
    expect(box).toMatchObject({ status: 403, body: { code: 'box_credential' } });
    expect((await call('POST', '/payments/slack/pause', { as: 'carol' })).body.code).toBe('not_owner');
    expect((await call('DELETE', '/payments/slack', { as: 'alice', box: 'alice-box' })).body.code).toBe('box_credential');
  });
});

describe('the picker, GET /slack/channels', () => {
  it('lists public channels and only the private ones the caller is in, with termagIn and why a channel can\'t be picked', async () => {
    const r = await call('GET', '/slack/channels', { as: 'alice' });
    expect(r.status).toBe(200);
    const byName = Object.fromEntries((r.body.channels as Array<{ name: string }>).map(c => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(['general', 'leads', 'partner-shared', 'proj-demo-main', 'team-payments']);
    expect(byName.general).toMatchObject({ id: 'C0FAKEGEN1', private: false, termagIn: false });
    expect(byName.leads).toMatchObject({ private: true, termagIn: true });
    expect(byName.general).not.toHaveProperty('disabled');
    expect(byName['proj-demo-main']).toMatchObject({ disabled: 'channel_workstream' });
    expect(byName['partner-shared']).toMatchObject({ disabled: 'channel_ext_shared' });
    expect(r.body.nextCursor).toBeNull();
  });

  it('filters by name, a leading # ignored', async () => {
    const r = await call('GET', '/slack/channels?query=%23Team', { as: 'alice' });
    expect(r.body.channels.map((c: { name: string }) => c.name)).toEqual(['team-payments']);
  });

  it('marks a linked channel disabled, naming the space only to its members', async () => {
    expect((await linkGeneral()).status).toBe(201);
    const mine = (await call('GET', '/slack/channels?query=general', { as: 'bob' })).body.channels[0];
    expect(mine).toMatchObject({ disabled: 'channel_linked', linkedTo: 'payments' });
    const theirs = (await call('GET', '/slack/channels?query=general', { as: 'dave' })).body.channels[0];
    expect(theirs).toMatchObject({ disabled: 'channel_linked', linkedTo: null });
  });

  it('is for owners of a space, with the flag on and Slack configured', async () => {
    expect((await call('GET', '/slack/channels', { as: 'carol' })).body.code).toBe('not_owner');
    flagOn.delete('alice');
    expect((await call('GET', '/slack/channels', { as: 'alice' })).body.code).toBe('space_channels_off');
    flagOn.add('alice');
    slackOff = true;
    expect((await call('GET', '/slack/channels', { as: 'alice' }))).toMatchObject({ status: 503, body: { code: 'slack_not_configured' } });
  });
});

describe('preview and commit', () => {
  it('previews the bystanders and the first link, then links via web and shows it in the status and the audit', async () => {
    const preview = await call('POST', '/payments/slack/channels/preview', { as: 'alice', body: { channelId: 'C0FAKEGEN1' } });
    // general's 12 seeded bystanders, and dave: a termag user in the channel, not in the space.
    expect(preview).toMatchObject({ status: 200, body: { bystanders: 13, needsInvite: false, firstLink: true, channelName: 'general', isPrivate: false } });
    expect(store.channels.size).toBe(0);

    const commit = await call('POST', '/payments/slack/channels', { as: 'alice', body: { channelId: 'C0FAKEGEN1', runner: { box: { existing: 'alice-box' } } } });
    expect(commit).toMatchObject({ status: 201, body: { already: false, channel: { channelId: 'C0FAKEGEN1', name: 'general', linkedVia: 'web', linkedBy: { userId: 'alice', email: 'alice@example.com' } } } });

    const status = (await call('GET', '/payments/slack', { as: 'carol' })).body;
    expect(status).toMatchObject({
      enabled: true, status: 'active', runner: { userId: 'alice' }, box: { kind: 'existing', name: 'alice-box' },
      channels: [{ channelId: 'C0FAKEGEN1', paused: false }],
    });
    const events = await spaces.events((await spaces.findSpace('payments'))!.id, { limit: 10 });
    expect(events.map(e => e.action)).toEqual(expect.arrayContaining(['slack.enable', 'slack.channel_link']));
    expect(events.find(e => e.action === 'slack.channel_link')!.note).toContain('linkedVia=web');

    // Linking it again is a no-op, answered 200.
    expect((await linkGeneral()).body).toMatchObject({ already: true });
  });

  it('records via: cli from the CLI mount', async () => {
    const r = await linkGeneral('alice', 'cli');
    expect(r.body.channel.linkedVia).toBe('cli');
  });

  it('refuses a new box of any size but small, and a malformed box, instead of making it small', async () => {
    for (const box of [{ new: { size: 'large' } }, { new: null }, { new: {} }, { existing: 7 }, 'large']) {
      const r = await call('POST', '/payments/slack/channels', { as: 'alice', body: { channelId: 'C0FAKEGEN1', runner: { box } } });
      expect(r, JSON.stringify(box)).toMatchObject({ status: 400, body: { code: 'bad_request' } });
    }
    expect(store.channels.size).toBe(0);
  });

  it('takes a box by name, a new small box by default, and refuses another person\'s box', async () => {
    expect((await call('POST', '/payments/slack/channels', { as: 'alice', body: { channelId: 'C0FAKEGEN1', runner: { box: { existing: 'bob-box' } } } })).body.code).toBe('runner_no_box');
    expect((await linkGeneral()).status).toBe(201);
    expect((await call('GET', '/payments/slack', { as: 'alice' })).body.box).toEqual({ kind: 'new', size: 'small' });
  });

  it('creates a channel, refusing a bad or taken name with a suggestion', async () => {
    const bad = await call('POST', '/payments/slack/channels', { as: 'alice', body: { create: { name: 'Bad Name' } } });
    expect(bad).toMatchObject({ status: 400, body: { code: 'name_invalid' } });
    const taken = await call('POST', '/payments/slack/channels', { as: 'alice', body: { create: { name: 'general' } } });
    expect(taken).toMatchObject({ status: 409, body: { code: 'name_taken', suggestion: 'general-2' } });
    const made = await call('POST', '/payments/slack/channels', { as: 'alice', body: { create: { name: 'space-payments', private: true, inviteMembers: true } } });
    expect(made).toMatchObject({ status: 201, body: { channel: { name: 'space-payments', private: true, createdByTermag: true, linkedVia: 'create' }, failedInvites: [] } });
  });

  it('maps the link refusals to HTTP statuses', async () => {
    const at = (channelId: string, as = 'alice') => call('POST', '/payments/slack/channels', { as, body: { channelId } });
    expect(await at('C0FAKEPROJ')).toMatchObject({ status: 400, body: { code: 'channel_workstream' } });
    expect(await at('C0FAKEEXT1')).toMatchObject({ status: 400, body: { code: 'channel_ext_shared' } });
    expect(await at('D0FAKEDM01')).toMatchObject({ status: 400, body: { code: 'channel_dm' } });
    expect(await at('G0FAKEHR01')).toMatchObject({ status: 403, body: { code: 'not_in_channel' } });
    const invite = await at('G0FAKESEC1');
    expect(invite).toMatchObject({ status: 409, body: { code: 'needs_invite' } });
    expect(invite.body.error).toContain('/invite @termag');
    expect(invite.body.error).not.toContain('/t link');
    expect((await call('POST', '/payments/slack/channels/preview', { as: 'alice', body: { channelId: 'G0FAKESEC1' } })).body).toMatchObject({ needsInvite: true });
    expect(await at('not-an-id')).toMatchObject({ status: 400, body: { code: 'bad_request' } });

    // Linked to another space.
    await call('POST', '/billing/slack/channels', { as: 'dave', body: { channelId: 'C0FAKETEAM' } });
    expect(await at('C0FAKETEAM')).toMatchObject({ status: 409, body: { code: 'channel_linked' } });

    // The cap.
    limits.channelsPerSpace = 1;
    expect((await linkGeneral()).status).toBe(201);
    const capped = await at('G0FAKELEAD');
    expect(capped).toMatchObject({ status: 409, body: { code: 'too_many_channels' } });
    expect(capped.body.error).not.toContain('*');

    slackOff = true;
    expect(await at('G0FAKELEAD')).toMatchObject({ status: 503, body: { code: 'slack_not_configured' } });
  });

  it('answers a preview of a channel already linked here as a preview, saying so', async () => {
    await linkGeneral();
    const r = await call('POST', '/payments/slack/channels/preview', { as: 'alice', body: { channelId: 'C0FAKEGEN1' } });
    expect(r).toMatchObject({ status: 200, body: { alreadyLinked: true, needsInvite: false, firstLink: false, channelName: 'general', bystanders: null } });
  });

  it('with onlyIfLinked, commits only while the channel is still linked here', async () => {
    await linkGeneral();
    const again = await call('POST', '/payments/slack/channels', { as: 'alice', body: { channelId: 'C0FAKEGEN1', onlyIfLinked: true } });
    expect(again).toMatchObject({ status: 200, body: { already: true } });
    await call('DELETE', '/payments/slack/channels/C0FAKEGEN1', { as: 'bob' });
    const gone = await call('POST', '/payments/slack/channels', { as: 'alice', body: { channelId: 'C0FAKEGEN1', onlyIfLinked: true } });
    expect(gone).toMatchObject({ status: 409, body: { code: 'not_linked' } });
    expect(store.channels.get('C0FAKEGEN1')!.unlinkedAt).not.toBeNull();
  });

  it('refuses a channel a disable left linked the same way in preview and commit, until the disable is finished', async () => {
    await linkGeneral();
    const markUnlinked = store.markUnlinked.bind(store);
    store.markUnlinked = async () => { throw new Error('db down'); };
    expect((await call('DELETE', '/payments/slack', { as: 'alice' })).body).toMatchObject({ remaining: 1 });
    for (const [path, body] of [
      ['/payments/slack/channels/preview', { channelId: 'C0FAKEGEN1' }],
      ['/payments/slack/channels', { channelId: 'C0FAKEGEN1' }],
      ['/payments/slack/channels', { channelId: 'C0FAKEGEN1', onlyIfLinked: true }],
    ] as const) {
      const r = await call('POST', path, { as: 'alice', body });
      expect(r, `${path} ${JSON.stringify(body)}`).toMatchObject({ status: 409, body: { code: 'disable_unfinished' } });
      expect(r.body.error).toMatch(/disable payments again, or unlink the channel/);
    }
    store.markUnlinked = markUnlinked;
    expect((await call('DELETE', '/payments/slack', { as: 'alice' })).body).toMatchObject({ remaining: 0 });
    // Finished: the channel links again, as a first link.
    expect((await call('POST', '/payments/slack/channels/preview', { as: 'alice', body: { channelId: 'C0FAKEGEN1' } })).body).toMatchObject({ firstLink: true });
  });

  it('with onlyIfLinked, never claims the channel: an unlink landing during the request stays an unlink', async () => {
    await linkGeneral();
    const repeats: Array<boolean | undefined> = [];
    freezer = {
      // The unlink lands while the freeze runs: after the route's check.
      async freezeAtLink(channelId, _space, at, opts) {
        repeats.push(opts?.repeat);
        await store.markUnlinked(channelId, 'owner', at);
        return 0;
      },
      async freezeAtUnlink() { return 0; },
      async spaceThreadCount() { return 0; },
    };
    const claim = vi.spyOn(store, 'claimChannel');
    const r = await call('POST', '/payments/slack/channels', { as: 'alice', body: { channelId: 'C0FAKEGEN1', onlyIfLinked: true } });
    expect(r).toMatchObject({ status: 200, body: { already: true } });
    expect(repeats).toEqual([true]);
    expect(claim).not.toHaveBeenCalled();
    expect(store.channels.get('C0FAKEGEN1')!.unlinkedAt).not.toBeNull();
  });

  it('refuses a create preview when Slack is not configured, as its commit would', async () => {
    slackOff = true;
    const r = await call('POST', '/payments/slack/channels/preview', { as: 'alice', body: { create: { name: 'space-payments' } } });
    expect(r).toMatchObject({ status: 503, body: { code: 'slack_not_configured' } });
  });

  it('never shows that a private channel termag cannot see is linked elsewhere', async () => {
    // billing links the private channel while termag was in it; then termag is removed from it.
    ws.channels.get('G0FAKESEC1')!.is_member = true;
    ws.channels.get('G0FAKESEC1')!.members.push('UFAKEBOT01');
    expect((await call('POST', '/billing/slack/channels', { as: 'dave', body: { channelId: 'G0FAKESEC1' } })).status).toBe(201);
    ws.channels.get('G0FAKESEC1')!.is_member = false;
    const linkedElsewhere = await call('POST', '/payments/slack/channels/preview', { as: 'alice', body: { channelId: 'G0FAKESEC1' } });
    const neverLinked = await call('POST', '/payments/slack/channels/preview', { as: 'alice', body: { channelId: 'G0FAKEHR01' } });
    ws.channels.get('G0FAKEHR01')!.is_member = false;
    const unlinkedInvisible = await call('POST', '/payments/slack/channels/preview', { as: 'alice', body: { channelId: 'G0FAKEHR01' } });
    expect(linkedElsewhere.body).toEqual(unlinkedInvisible.body);
    expect(linkedElsewhere.body).toMatchObject({ needsInvite: true });
    expect(neverLinked.body.code).toBe('not_in_channel');
    const commit = await call('POST', '/payments/slack/channels', { as: 'alice', body: { channelId: 'G0FAKESEC1' } });
    expect(commit).toMatchObject({ status: 409, body: { code: 'needs_invite' } });
  });

  it('takes a channel as Slack writes it, <#C…|name>', async () => {
    const r = await call('POST', '/payments/slack/channels', { as: 'alice', body: { channelId: '<#C0FAKEGEN1|general>' } });
    expect(r.status).toBe(201);
  });
});

describe('unlink', () => {
  it('previews, then unlinks; archive only for a channel termag created; never another space\'s channel', async () => {
    await linkGeneral();
    const preview = await call('GET', '/payments/slack/channels/C0FAKEGEN1', { as: 'alice' });
    expect(preview).toMatchObject({ status: 200, body: { channel: { name: 'general' }, canArchive: false } });
    expect((await call('DELETE', '/payments/slack/channels/C0FAKEGEN1?archive=true', { as: 'alice' })).body.code).toBe('cannot_archive');

    await call('POST', '/billing/slack/channels', { as: 'dave', body: { channelId: 'C0FAKETEAM' } });
    expect((await call('DELETE', '/payments/slack/channels/C0FAKETEAM', { as: 'alice' }))).toMatchObject({ status: 404, body: { code: 'not_linked' } });
    expect((await call('DELETE', '/payments/slack/channels/C0FAKEGEN1', { as: 'carol' })).body.code).toBe('not_owner');

    const done = await call('DELETE', '/payments/slack/channels/C0FAKEGEN1', { as: 'bob' });
    expect(done).toMatchObject({ status: 200, body: { unlinked: 'C0FAKEGEN1', archived: false } });
    expect((await call('GET', '/payments/slack', { as: 'alice' })).body.channels).toEqual([]);
    expect((await call('DELETE', '/payments/slack/channels/C0FAKEGEN1', { as: 'bob' })).body.code).toBe('not_linked');
  });

  it('archives a channel termag created', async () => {
    const made = await call('POST', '/payments/slack/channels', { as: 'alice', body: { create: { name: 'space-payments' } } });
    const id = made.body.channel.channelId;
    expect((await call('GET', `/payments/slack/channels/${id}`, { as: 'alice' })).body.canArchive).toBe(true);
    expect((await call('DELETE', `/payments/slack/channels/${id}?archive=true`, { as: 'alice' })).body.archived).toBe(true);
  });
});

describe('pause, resume, runner, disable', () => {
  it('needs Slack on for the space first', async () => {
    expect((await call('POST', '/payments/slack/pause', { as: 'alice' }))).toMatchObject({ status: 409, body: { code: 'not_enabled' } });
  });

  it('pauses and resumes, recording each', async () => {
    await linkGeneral();
    expect((await call('POST', '/payments/slack/pause', { as: 'bob' })).body.status).toBe('paused');
    expect((await call('POST', '/payments/slack/resume', { as: 'alice' })).body.status).toBe('active');
    const events = await spaces.events((await spaces.findSpace('payments'))!.id, { limit: 10 });
    expect(events.map(e => e.action)).toEqual(expect.arrayContaining(['slack.pause', 'slack.resume']));
  });

  it('hands the runner over: the runner offers to an owner, who accepts with their own box', async () => {
    await linkGeneral();
    expect((await call('POST', '/payments/slack/runner', { as: 'bob', body: { offer: 'alice@example.com' } })).body.code).toBe('not_runner');
    expect((await call('POST', '/payments/slack/runner', { as: 'alice', body: { offer: 'carol@example.com' } })).body.code).toBe('not_an_owner');
    expect((await call('POST', '/payments/slack/runner', { as: 'bob', body: { accept: true } }))).toMatchObject({ status: 409, body: { code: 'no_offer' } });

    const offered = await call('POST', '/payments/slack/runner', { as: 'alice', body: { offer: 'bob@example.com' } });
    expect(offered.body).toMatchObject({ runner: { userId: 'alice' }, pendingRunner: { userId: 'bob', email: 'bob@example.com' } });
    const accepted = await call('POST', '/payments/slack/runner', { as: 'bob', body: { accept: true, box: { existing: 'bob-box' } } });
    expect(accepted.body).toMatchObject({ runner: { userId: 'bob' }, pendingRunner: null, box: { kind: 'existing', name: 'bob-box' }, you: { runner: true } });
  });

  it('keeps an offer however many other events come after it, and refuses a failed or quarantined box on accept', async () => {
    await linkGeneral();
    const { id } = (await spaces.findSpace('payments'))!;
    await call('POST', '/payments/slack/runner', { as: 'alice', body: { offer: 'bob@example.com' } });
    for (let i = 0; i < 250; i++) await spaces.recordEvent({ spaceId: id, actorUserId: 'carol', action: 'file.put', path: `f${i}.md` });
    expect((await call('GET', '/payments/slack', { as: 'bob' })).body.pendingRunner).toMatchObject({ userId: 'bob' });
    for (const status of ['failed', 'quarantined']) {
      spaces.addBox(`bob-${status}`, 'bob', `bob-${status}`, status);
      const r = await call('POST', '/payments/slack/runner', { as: 'bob', body: { accept: true, box: { existing: `bob-${status}` } } });
      expect(r, status).toMatchObject({ status: 400, body: { code: 'runner_no_box' } });
    }
    expect((await call('POST', '/payments/slack/runner', { as: 'bob', body: { accept: true } })).body.runner.userId).toBe('bob');
  });

  it('lets the runner withdraw an offer, and an owner take over when the runner is no longer an owner', async () => {
    await linkGeneral();
    await call('POST', '/payments/slack/runner', { as: 'alice', body: { offer: 'bob@example.com' } });
    expect((await call('POST', '/payments/slack/runner', { as: 'alice', body: { cancel: true } })).body.pendingRunner).toBeNull();
    expect((await call('POST', '/payments/slack/runner', { as: 'bob', body: { accept: true } })).body.code).toBe('no_offer');
    const { id } = (await spaces.findSpace('payments'))!;
    spaces.memberRows.find(m => m.spaceId === id && m.userId === 'alice')!.role = 'editor';
    expect((await call('POST', '/payments/slack/runner', { as: 'bob', body: { accept: true } })).body.runner.userId).toBe('bob');
  });

  it('unlinks a channel whose link lands while the disable runs', async () => {
    await linkGeneral();
    // A link that passed its checks before the disable, and claims its channel just after the row is disabled.
    afterDisable = async () => {
      const ss = (await store.spaceSlack((await spaces.findSpace('payments'))!.id))!;
      await store.claimChannel({ channelId: 'G0FAKELEAD', teamId: '', spaceSlackId: ss.id, name: 'leads', isPrivate: true, createdByTermag: false, linkedById: 'bob', linkedVia: 'web' });
    };
    expect((await call('DELETE', '/payments/slack', { as: 'alice' })).body).toEqual({ disabled: true, unlinked: 2, remaining: 0, unfrozen: 0, reenabled: false });
    expect([...store.channels.values()].filter(c => !c.unlinkedAt)).toEqual([]);
  });

  it('finishes an interrupted disable: a failed unlink leaves the channel listed, and disabling again sweeps it', async () => {
    await linkGeneral();
    await call('POST', '/payments/slack/channels', { as: 'alice', body: { channelId: 'G0FAKELEAD' } });
    const markUnlinked = store.markUnlinked.bind(store);
    let failOnce = 'G0FAKELEAD';
    store.markUnlinked = async (channelId, reason, at) => {
      if (channelId === failOnce) { failOnce = ''; throw new Error('db down'); }
      return markUnlinked(channelId, reason, at);
    };
    expect((await call('DELETE', '/payments/slack', { as: 'alice' })).body).toMatchObject({ disabled: true, remaining: 0 });
    // The failure was retried within the same disable's passes; now make it stick.
    await call('POST', '/payments/slack/channels', { as: 'alice', body: { channelId: 'C0FAKEGEN1' } });
    store.markUnlinked = async () => { throw new Error('db down'); };
    expect((await call('DELETE', '/payments/slack', { as: 'alice' })).body).toMatchObject({ disabled: true, unlinked: 0, remaining: 1 });
    const stranded = (await call('GET', '/payments/slack', { as: 'alice' })).body;
    expect(stranded).toMatchObject({ enabled: false, channels: [{ channelId: 'C0FAKEGEN1' }] });
    store.markUnlinked = markUnlinked;
    expect((await call('DELETE', '/payments/slack', { as: 'alice' })).body).toMatchObject({ disabled: true, unlinked: 1, remaining: 0 });
    // Nothing left to unlink: disabling again only freezes the disable's channels again, harmlessly.
    expect((await call('DELETE', '/payments/slack', { as: 'alice' })).body).toMatchObject({ disabled: true, unlinked: 0, remaining: 0, unfrozen: 0 });
  });

  it('freezes again the threads of a channel whose freeze failed, now and on the next disable', async () => {
    const freezes: string[] = [];
    let failing = 2;
    freezer = {
      async freezeAtLink() { return 0; },
      async freezeAtUnlink(channelId) { freezes.push(channelId); if (failing-- > 0) throw new Error('db down'); return 1; },
      async spaceThreadCount() { return 1; },
    };
    await linkGeneral();
    // The unlink's freeze fails, and so does the immediate retry: the channel is unlinked, its threads not frozen.
    expect((await call('DELETE', '/payments/slack', { as: 'alice' })).body).toMatchObject({ unlinked: 1, remaining: 0, unfrozen: 1 });
    // The next disable freezes them.
    expect((await call('DELETE', '/payments/slack', { as: 'alice' })).body).toMatchObject({ unlinked: 0, remaining: 0, unfrozen: 0 });
    expect(freezes).toEqual(['C0FAKEGEN1', 'C0FAKEGEN1', 'C0FAKEGEN1']);
  });

  it('stops a disable\'s sweep when the space is linked (re-enabled) meanwhile, leaving the new channel', async () => {
    await linkGeneral();
    await call('POST', '/payments/slack/channels', { as: 'alice', body: { channelId: 'G0FAKELEAD' } });
    const ss = (await store.spaceSlack((await spaces.findSpace('payments'))!.id))!;
    // Another owner's first link lands right after the row is disabled: it re-enables the row.
    afterDisable = async () => { ss.disabledAt = null; };
    const r = (await call('DELETE', '/payments/slack', { as: 'alice' })).body;
    expect(r).toMatchObject({ disabled: false, reenabled: true, unlinked: 0 });
    expect([...store.channels.values()].filter(c => !c.unlinkedAt).map(c => c.channelId).sort()).toEqual(['C0FAKEGEN1', 'G0FAKELEAD']);
  });

  it('disables: every channel unlinked, then a new link is a first link again', async () => {
    await linkGeneral();
    await call('POST', '/payments/slack/channels', { as: 'alice', body: { channelId: 'G0FAKELEAD' } });
    expect((await call('DELETE', '/payments/slack', { as: 'bob' })).body).toEqual({ disabled: true, unlinked: 2, remaining: 0, unfrozen: 0, reenabled: false });
    expect((await call('GET', '/payments/slack', { as: 'alice' })).body).toMatchObject({ enabled: false, channels: [] });
    expect([...store.channels.values()].every(c => c.unlinkReason === 'disabled')).toBe(true);
    expect((await call('POST', '/payments/slack/channels/preview', { as: 'bob', body: { channelId: 'C0FAKEGEN1' } })).body.firstLink).toBe(true);
  });
});

describe('the staging fake workspace', () => {
  it('is on only with SPACE_SLACK_FAKE_WORKSPACE=1 under AUTH_MODE=local', () => {
    expect(fakeWorkspaceEnabled({ SPACE_SLACK_FAKE_WORKSPACE: '1', AUTH_MODE: 'local' })).toBe(true);
    expect(fakeWorkspaceEnabled({ SPACE_SLACK_FAKE_WORKSPACE: '1' })).toBe(false);
    expect(fakeWorkspaceEnabled({ AUTH_MODE: 'local' })).toBe(false);
  });

  it('gives each user a stable fake Slack id', () => {
    expect(fakeSlackId('cm1234abcd5678')).toBe(fakeSlackId('cm1234abcd5678'));
    expect(fakeSlackId('cm1234abcd5678')).toMatch(/^UFAKE[A-Z0-9]{1,8}$/);
  });
});
