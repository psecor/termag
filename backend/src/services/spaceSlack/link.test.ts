import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db', () => ({ prisma: {} }));
vi.mock('../../slack/app', () => ({ getSlackApp: () => null }));

import { MemorySpaceStore } from '../spaces/spacesTestkit';
import { DEFAULT_SPACE_SLACK_LIMITS, type SpaceSlackLimits } from './limits';
import { link, unlink, type LinkDeps, type LinkInput } from './link';
import { MemorySpaceSlackStore, fakeSlackWorkspace, recordingFreezer } from './spaceSlackTestkit';

let spaces: MemorySpaceStore;
let store: MemorySpaceSlackStore;
let ws: ReturnType<typeof fakeSlackWorkspace>;
let frozen: ReturnType<typeof recordingFreezer>;
let flagOn: Set<string>;
let limits: SpaceSlackLimits;
let deps: LinkDeps;
let payments: string;

const OWNER = { userId: 'u-own', slackId: 'UOWN0001' };
const EDITOR = { userId: 'u-ed', slackId: 'UED00001' };

function setup(opts: { membersNeedJoin?: boolean } = {}) {
  spaces = new MemorySpaceStore();
  store = new MemorySpaceSlackStore();
  ws = fakeSlackWorkspace('UBOT0001', opts);
  frozen = recordingFreezer(3);
  flagOn = new Set(['u-own', 'u-ed', 'u-other']);
  limits = { ...DEFAULT_SPACE_SLACK_LIMITS };
  for (const id of ['u-own', 'u-ed', 'u-other']) spaces.addUser(id);
  store.slackIds.set('u-own', OWNER.slackId).set('u-ed', EDITOR.slackId).set('u-other', 'UOTH0001');
  deps = {
    spaces, store, slack: ws.client, freezer: frozen.freezer, botUserId: ws.botUserId,
    channelsEnabled: async id => flagOn.has(id),
    limitsFor: async () => limits,
  };
  ws.add({ id: 'CPUB0001', name: 'pay-team', members: [OWNER.slackId, EDITOR.slackId, 'UBYST001', 'UBYST002'] });
}

beforeEach(async () => {
  setup();
  payments = (await spaces.createSpace({ name: 'payments', description: null, userId: 'u-own' })).id;
  spaces.memberRows.push({ spaceId: payments, userId: 'u-ed', role: 'editor', createdAt: new Date() });
  await spaces.createSpace({ name: 'billing', description: null, userId: 'u-other' });
});

const input = (over: Partial<LinkInput> = {}): LinkInput => ({
  spaceName: 'payments', channelId: 'CPUB0001', actor: OWNER, via: 'slack_command', mode: 'commit', ...over,
});

describe('link: refusals, in order', () => {
  it('space_channels_off when the flag is off for the actor', async () => {
    flagOn.delete('u-own');
    expect(await link(deps, input())).toMatchObject({ kind: 'refused', code: 'space_channels_off' });
  });

  it('space_not_found for a missing space and for one the actor is not in, so names do not leak', async () => {
    expect(await link(deps, input({ spaceName: 'nope' }))).toMatchObject({ code: 'space_not_found' });
    expect(await link(deps, input({ spaceName: 'billing' }))).toMatchObject({ code: 'space_not_found' });
  });

  it('not_owner for an editor', async () => {
    expect(await link(deps, input({ actor: EDITOR }))).toMatchObject({ code: 'not_owner' });
  });

  it('channel_dm for a DM and a group DM', async () => {
    expect(await link(deps, input({ channelId: 'D0123456' }))).toMatchObject({ code: 'channel_dm' });
    ws.add({ id: 'GMPIM001', name: 'mpdm-a--b', is_mpim: true, is_private: true, is_member: true, members: [OWNER.slackId] });
    expect(await link(deps, input({ channelId: 'GMPIM001' }))).toMatchObject({ code: 'channel_dm' });
  });

  it('channel_workstream for a #proj-… channel', async () => {
    ws.add({ id: 'CPROJ001', name: 'proj-alice-termag', members: [OWNER.slackId] });
    expect(await link(deps, input({ channelId: 'CPROJ001' }))).toMatchObject({ code: 'channel_workstream' });
  });

  it('channel_ext_shared for a Slack Connect channel, without joining it', async () => {
    ws.add({ id: 'CEXT0001', name: 'with-vendor', is_ext_shared: true, members: [OWNER.slackId] });
    const join = vi.spyOn(ws.client.conversations, 'join');
    expect(await link(deps, input({ channelId: 'CEXT0001' }))).toMatchObject({ code: 'channel_ext_shared' });
    expect(join).not.toHaveBeenCalled();
  });

  it('not_in_channel from Slack when the owner is not a member', async () => {
    ws.add({ id: 'CELSE001', name: 'elsewhere', members: ['UBYST001'] });
    expect(await link(deps, input({ channelId: 'CELSE001' }))).toMatchObject({ code: 'not_in_channel' });
  });

  it('channel_linked when another space has the channel', async () => {
    store.slackIds.set('u-other', 'UOTH0001');
    ws.channels.get('CPUB0001')!.members.push('UOTH0001');
    expect(await link(deps, input({ spaceName: 'billing', actor: { userId: 'u-other', slackId: 'UOTH0001' } }))).toMatchObject({ kind: 'linked' });
    expect(await link(deps, input())).toMatchObject({ code: 'channel_linked' });
  });

  it('too_many_channels at channelsPerSpace', async () => {
    limits.channelsPerSpace = 1;
    expect(await link(deps, input())).toMatchObject({ kind: 'linked' });
    ws.add({ id: 'CPUB0002', name: 'pay-two', members: [OWNER.slackId] });
    expect(await link(deps, input({ channelId: 'CPUB0002' }))).toMatchObject({ code: 'too_many_channels' });
  });

  it('private_not_allowed when the limits bar private channels', async () => {
    limits.allowPrivate = false;
    ws.add({ id: 'GPRIV001', name: 'secret', is_private: true, is_member: true, members: [OWNER.slackId] });
    expect(await link(deps, input({ channelId: 'GPRIV001' }))).toMatchObject({ code: 'private_not_allowed' });
  });

  it('needs_invite for a private channel termag is not in: the preview says so, the commit refuses', async () => {
    ws.add({ id: 'GPRIV001', name: 'secret', is_private: true, is_member: false, members: [OWNER.slackId] });
    expect(await link(deps, input({ channelId: 'GPRIV001', mode: 'preview' })))
      .toEqual({ kind: 'preview', needsInvite: true, firstLink: true, bystanders: null, channelName: null, isPrivate: true });
    const refused = await link(deps, input({ channelId: 'GPRIV001' }));
    expect(refused).toMatchObject({ kind: 'refused', code: 'needs_invite' });
    if (refused.kind === 'refused') expect(refused.message).toBe('Invite me with `/invite @termag`, then run `/t link payments` again.');
    expect(store.slack.size).toBe(0);
  });

  it('runner_no_box for a box the actor does not own, on a first link, before termag joins anything', async () => {
    spaces.addBox('i-theirs', 'u-other');
    const join = vi.spyOn(ws.client.conversations, 'join');
    expect(await link(deps, input({ runner: { box: { existing: 'i-theirs' } } }))).toMatchObject({ code: 'runner_no_box' });
    expect(store.channels.size).toBe(0);
    expect(store.slack.size).toBe(0);
    expect(join).not.toHaveBeenCalled();
  });

  it('channel_archived for an archived channel termag is still in, linked by id', async () => {
    ws.add({ id: 'COLD0001', name: 'old-team', is_archived: true, is_member: true, members: [OWNER.slackId] });
    expect(await link(deps, input({ channelId: 'COLD0001', via: 'cli' }))).toMatchObject({ code: 'channel_archived', message: 'That channel is archived; unarchive it in Slack first.' });
    expect(store.slack.size).toBe(0);
  });

  it('tells an owner who isn\'t in a linked private channel only not_in_channel, nothing about the link', async () => {
    ws.add({ id: 'GPRIV009', name: 'board', is_private: true, is_member: true, members: [OWNER.slackId] });
    await link(deps, input({ channelId: 'GPRIV009' }));
    spaces.memberRows.push({ spaceId: payments, userId: 'u-other', role: 'owner', createdAt: new Date() });
    for (const via of ['web', 'slack_command'] as const) {
      expect(await link(deps, input({ channelId: 'GPRIV009', via, actor: { userId: 'u-other', slackId: 'UOTH0001' } }))).toEqual({
        kind: 'refused', code: 'not_in_channel', message: 'You need to be a member of this channel to link it.',
      });
    }
  });

  it('a re-link at channelsPerSpace is still the no-op, not too_many_channels', async () => {
    limits.channelsPerSpace = 1;
    await link(deps, input());
    expect(await link(deps, input())).toMatchObject({ kind: 'linked', already: true });
  });

  it('repeats the freeze on a re-link, so a freeze that failed after the claim is retried', async () => {
    vi.spyOn(frozen.freezer, 'freezeAtLink').mockRejectedValueOnce(new Error('db blip'));
    await expect(link(deps, input())).rejects.toThrow('db blip');
    expect(store.channels.get('CPUB0001')!.unlinkedAt).toBeNull();
    expect(await link(deps, input())).toMatchObject({ kind: 'linked', already: true });
    // The retry is a repeat: it leaves the live link's space threads alone.
    expect(frozen.calls).toEqual([{ at: 'link', channelId: 'CPUB0001', spaceName: 'payments', repeat: true }]);
    // A preview never freezes.
    await link(deps, input({ mode: 'preview' }));
    expect(frozen.calls).toHaveLength(1);
  });

  it('linking the same channel to the same space again is a no-op', async () => {
    await link(deps, input());
    const events = spaces.eventRows.length;
    expect(await link(deps, input())).toMatchObject({ kind: 'linked', already: true });
    expect(spaces.eventRows.length).toBe(events);
  });
});

describe('link: a public channel, preview then commit', () => {
  it('previews the bystanders and the first link, without joining', async () => {
    const join = vi.spyOn(ws.client.conversations, 'join');
    expect(await link(deps, input({ mode: 'preview' })))
      .toEqual({ kind: 'preview', bystanders: 2, needsInvite: false, firstLink: true, channelName: 'pay-team', isPrivate: false });
    expect(join).not.toHaveBeenCalled();
    expect(store.slack.size).toBe(0);
    expect(spaces.eventRows).toEqual([]);
  });

  it('commits: joins, enables with the actor as runner, records the link, posts the message, freezes threads', async () => {
    const post = vi.spyOn(ws.client.chat, 'postMessage');
    const res = await link(deps, input({ teamId: 'T0001' }));
    expect(res).toMatchObject({ kind: 'linked', already: false, channel: { channelId: 'CPUB0001', name: 'pay-team', isPrivate: false, linkedVia: 'slack_command', createdByTermag: false, teamId: 'T0001' } });
    expect(ws.channels.get('CPUB0001')!.is_member).toBe(true);
    expect(await store.spaceSlack(payments)).toMatchObject({ runnerUserId: 'u-own', enabledById: 'u-own', instanceId: null });
    expect(spaces.eventRows.map(e => [e.action, e.surface, e.actorUserId])).toEqual([
      ['slack.enable', 'slack', 'u-own'], ['slack.channel_link', 'slack', 'u-own'],
    ]);
    expect(spaces.eventRows[0].note).toBe('linkedVia=slack_command; runner=u-own; box=new:small');
    expect(spaces.eventRows[1].note).toBe('linkedVia=slack_command; channel=CPUB0001; name=#pay-team');
    const msg = post.mock.calls[0][0];
    expect(msg.channel).toBe('CPUB0001');
    expect(msg.text).toContain('*payments*');
    expect(JSON.stringify(msg.blocks)).toContain('space_channel_files');
    expect(store.channels.get('CPUB0001')!.confirmTs).toBeTruthy();
    expect(frozen.calls).toEqual([{ at: 'link', channelId: 'CPUB0001', spaceName: 'payments' }]);
  });

  it('a second link does not enable again, and records the entry point it came from', async () => {
    await link(deps, input());
    ws.add({ id: 'CPUB0002', name: 'pay-two', members: [OWNER.slackId] });
    await link(deps, input({ channelId: 'CPUB0002', via: 'app_home' }));
    expect(spaces.eventRows.filter(e => e.action === 'slack.enable')).toHaveLength(1);
    expect(store.channels.get('CPUB0002')!.linkedVia).toBe('app_home');
  });

  it('from the web, a public channel needs no membership; a private one does', async () => {
    ws.add({ id: 'CELSE001', name: 'elsewhere', members: ['UBYST001'] });
    expect(await link(deps, input({ channelId: 'CELSE001', via: 'web' }))).toMatchObject({ kind: 'linked' });
    ws.add({ id: 'GPRIV002', name: 'others-secret', is_private: true, is_member: true, members: ['UBYST001'] });
    expect(await link(deps, input({ channelId: 'GPRIV002', via: 'web' }))).toMatchObject({ code: 'not_in_channel' });
  });

  it('a private channel links once termag has been invited', async () => {
    ws.add({ id: 'GPRIV001', name: 'secret', is_private: true, is_member: true, members: [OWNER.slackId, 'UBYST001'] });
    expect(await link(deps, input({ channelId: 'GPRIV001', mode: 'preview' }))).toMatchObject({ bystanders: 1, needsInvite: false });
    expect(await link(deps, input({ channelId: 'GPRIV001' }))).toMatchObject({ kind: 'linked', channel: { isPrivate: true } });
  });

  it('leaves termag out of the bystanders without a botUserId, through auth.test (the web and CLI wiring)', async () => {
    ws.channels.get('CPUB0001')!.is_member = true;
    ws.channels.get('CPUB0001')!.members.push('UBOT0001');
    expect(await link({ ...deps, botUserId: undefined }, input({ mode: 'preview', via: 'web' }))).toMatchObject({ bystanders: 2 });
  });

  it('[S2 fallback] never joins a channel it then refuses as linked elsewhere or over the cap', async () => {
    setup({ membersNeedJoin: true });
    payments = (await spaces.createSpace({ name: 'payments', description: null, userId: 'u-own' })).id;
    await spaces.createSpace({ name: 'billing', description: null, userId: 'u-other' });
    const join = vi.spyOn(ws.client.conversations, 'join');
    // Over the cap: one slot, already used by a channel termag is in.
    limits.channelsPerSpace = 1;
    ws.add({ id: 'CIN00001', name: 'in-already', is_member: true, members: [OWNER.slackId] });
    expect(await link(deps, input({ channelId: 'CIN00001' }))).toMatchObject({ kind: 'linked' });
    join.mockClear();
    expect(await link(deps, input({ mode: 'preview' }))).toMatchObject({ code: 'too_many_channels' });
    expect(await link(deps, input())).toMatchObject({ code: 'too_many_channels' });
    // Linked to another space.
    limits.channelsPerSpace = 5;
    store.channels.set('CPUB0001', { channelId: 'CPUB0001', teamId: '', spaceSlackId: 'ss-other', name: 'pay-team', isPrivate: false, createdByTermag: false, linkedById: 'u-other', linkedVia: 'web', linkedAt: new Date(), confirmTs: null, pausedAt: null, unlinkedAt: null, unlinkReason: null });
    store.slack.set('ss-other', { id: 'ss-other', spaceId: 'sp-other', enabledById: 'u-other', runnerUserId: 'u-other', projectId: null, instanceId: null, status: 'active', limits: null, disabledAt: null });
    // From the web there is no membership check: channel_linked. From Slack, termag won't join to read
    // the members of a channel it would refuse, so the answer is that they can't be read.
    expect(await link(deps, input({ mode: 'preview', via: 'web' }))).toMatchObject({ code: 'channel_linked' });
    expect(await link(deps, input({ mode: 'preview' }))).toMatchObject({ code: 'slack_error', error: 'members_unreadable' });
    expect(join).not.toHaveBeenCalled();
    expect(ws.channels.get('CPUB0001')!.is_member).toBe(false);
  });

  it('[S2 fallback] joins first when the members of an unjoined public channel cannot be read', async () => {
    setup({ membersNeedJoin: true });
    payments = (await spaces.createSpace({ name: 'payments', description: null, userId: 'u-own' })).id;
    const res = await link(deps, input({ mode: 'preview' }));
    expect(res).toMatchObject({ kind: 'preview', bystanders: 3 });
    expect(ws.channels.get('CPUB0001')!.is_member).toBe(true);
  });
});

describe('link: races', () => {
  it('two spaces linking one channel at once: one wins, the other is refused', async () => {
    ws.channels.get('CPUB0001')!.members.push('UOTH0001');
    const [a, b] = await Promise.all([
      link(deps, input()),
      link(deps, input({ spaceName: 'billing', actor: { userId: 'u-other', slackId: 'UOTH0001' } })),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['linked', 'refused']);
    expect([a, b].find(r => r.kind === 'refused')).toMatchObject({ code: 'channel_linked' });
    expect(spaces.eventRows.filter(e => e.action === 'slack.channel_link')).toHaveLength(1);
    // The loser's first-link activation is undone, with no slack.enable for it.
    expect(store.slack.size).toBe(1);
    expect(spaces.eventRows.filter(e => e.action === 'slack.enable')).toHaveLength(1);
  });

  it('the same link twice at once: one links, the other is the no-op', async () => {
    const [a, b] = await Promise.all([link(deps, input()), link(deps, input())]);
    expect([a, b].map(r => r.kind === 'linked' && r.already).sort()).toEqual([false, true]);
    expect(spaces.eventRows.filter(e => e.action === 'slack.channel_link')).toHaveLength(1);
    // The request that created the row completes the enable, whichever claim won.
    expect(spaces.eventRows.filter(e => e.action === 'slack.enable')).toHaveLength(1);
  });
});

describe('link: create', () => {
  const create = (over: Partial<NonNullable<LinkInput['create']>> = {}) =>
    input({ channelId: undefined, via: 'web', create: { name: 'space-payments', private: false, inviteMembers: true, ...over } });

  it('previews with no bystanders, then creates, invites the members and links it as created', async () => {
    expect(await link(deps, { ...create(), mode: 'preview' })).toMatchObject({ kind: 'preview', bystanders: 0, needsInvite: false, firstLink: true });
    const res = await link(deps, create({ private: true }));
    expect(res).toMatchObject({ kind: 'linked', failedInvites: [], channel: { createdByTermag: true, linkedVia: 'create', isPrivate: true, name: 'space-payments' } });
    const id = res.kind === 'linked' ? res.channel.channelId : '';
    expect(ws.channels.get(id)!.members.sort()).toEqual([EDITOR.slackId, OWNER.slackId, 'UBOT0001'].sort());
    // The enable is recorded once the channel exists and is claimed.
    expect(spaces.eventRows.map(e => e.action)).toEqual(['slack.channel_create', 'slack.enable', 'slack.channel_link']);
    expect(spaces.eventRows[2].note).toBe(`linkedVia=create; from=web; channel=${id}; name=#space-payments`);
    expect(frozen.calls).toEqual([]);
  });

  it('refuses a taken name with a suggestion, and never joins', async () => {
    ws.add({ id: 'CTAKEN01', name: 'space-payments', members: [] });
    const join = vi.spyOn(ws.client.conversations, 'join');
    expect(await link(deps, create())).toMatchObject({ kind: 'refused', code: 'name_taken', suggestion: 'space-payments-2' });
    expect(join).not.toHaveBeenCalled();
    // A refused create turns nothing on: no SpaceSlack, no runner, no slack.enable.
    expect(store.slack.size).toBe(0);
    expect(spaces.eventRows).toEqual([]);
  });

  it('a refused create leaves the next link free to make its own actor the runner', async () => {
    vi.spyOn(ws.client.conversations, 'create').mockRejectedValueOnce(Object.assign(new Error('restricted_action'), { data: { error: 'restricted_action' } }));
    expect(await link(deps, create())).toMatchObject({ code: 'restricted_action' });
    spaces.memberRows.push({ spaceId: payments, userId: 'u-other', role: 'owner', createdAt: new Date() });
    ws.channels.get('CPUB0001')!.members.push('UOTH0001');
    expect(await link(deps, input({ actor: { userId: 'u-other', slackId: 'UOTH0001' } }))).toMatchObject({ kind: 'linked' });
    expect(await store.spaceSlack(payments)).toMatchObject({ runnerUserId: 'u-other' });
  });

  it('refuses a proj- name in the preview', async () => {
    expect(await link(deps, { ...create({ name: 'proj-x' }), mode: 'preview' })).toMatchObject({ code: 'name_invalid' });
  });
});

describe('unlink', () => {
  beforeEach(async () => { await link(deps, input()); frozen.calls.length = 0; });

  it('previews the threads that stop answering', async () => {
    expect(await unlink(deps, { channelId: 'CPUB0001', actor: OWNER, via: 'slack_command', reason: 'owner', mode: 'preview' }))
      .toEqual({ kind: 'preview', spaceName: 'payments', channelName: 'pay-team', threads: 3, canArchive: false });
  });

  it('commits: marks it unlinked, records it, says so in the channel, freezes the space threads', async () => {
    const post = vi.spyOn(ws.client.chat, 'postMessage');
    const archive = vi.spyOn(ws.client.conversations, 'archive');
    const res = await unlink(deps, { channelId: 'CPUB0001', actor: OWNER, via: 'slack_command', reason: 'owner', archive: true, mode: 'commit' });
    expect(res).toMatchObject({ kind: 'unlinked', archived: false, channel: { unlinkReason: 'owner' } });
    expect(spaces.eventRows.at(-1)).toMatchObject({ action: 'slack.channel_unlink', surface: 'slack', actorUserId: 'u-own', note: 'linkedVia=slack_command; reason=owner; channel=CPUB0001; name=#pay-team' });
    expect(post.mock.calls[0][0].text).toBe('This channel is no longer linked to the termag space *payments*.');
    expect(frozen.calls).toEqual([{ at: 'unlink', channelId: 'CPUB0001', spaceName: 'payments' }]);
    // Not created by termag: archive is not honoured.
    expect(archive).not.toHaveBeenCalled();
    expect(await unlink(deps, { channelId: 'CPUB0001', actor: OWNER, via: 'web', reason: 'owner', mode: 'commit' })).toMatchObject({ code: 'not_linked' });
  });

  it('archives a channel termag created, when asked', async () => {
    const made = await link(deps, input({ channelId: undefined, via: 'cli', create: { name: 'space-made', private: false, inviteMembers: false } }));
    const id = made.kind === 'linked' ? made.channel.channelId : '';
    expect(await unlink(deps, { channelId: id, actor: OWNER, via: 'cli', reason: 'owner', archive: true, mode: 'commit' })).toMatchObject({ kind: 'unlinked', archived: true });
    expect(ws.channels.get(id)!.is_archived).toBe(true);
  });

  it('refuses a non-owner, and an owner who is not in the channel from Slack', async () => {
    expect(await unlink(deps, { channelId: 'CPUB0001', actor: EDITOR, via: 'slack_command', reason: 'owner', mode: 'commit' })).toMatchObject({ code: 'not_owner' });
    ws.channels.get('CPUB0001')!.members = ['UBOT0001'];
    expect(await unlink(deps, { channelId: 'CPUB0001', actor: OWNER, via: 'slack_command', reason: 'owner', mode: 'commit' })).toMatchObject({ code: 'not_in_channel' });
  });

  it('a members lookup Slack fails is slack_error, not not_in_channel, and unlinks nothing', async () => {
    vi.spyOn(ws.client.conversations, 'members').mockRejectedValueOnce(Object.assign(new Error('ratelimited'), { data: { error: 'ratelimited' } }));
    expect(await unlink(deps, { channelId: 'CPUB0001', actor: OWNER, via: 'slack_command', reason: 'owner', mode: 'commit' }))
      .toMatchObject({ kind: 'refused', code: 'slack_error', error: 'members_unreadable' });
    expect(store.channels.get('CPUB0001')!.unlinkedAt).toBeNull();
  });

  it('an unlink retried after its freeze failed freezes again, and answers not_linked', async () => {
    vi.spyOn(frozen.freezer, 'freezeAtUnlink').mockRejectedValueOnce(new Error('db blip'));
    await expect(unlink(deps, { channelId: 'CPUB0001', actor: OWNER, via: 'web', reason: 'owner', mode: 'commit' })).rejects.toThrow('db blip');
    expect(await unlink(deps, { channelId: 'CPUB0001', actor: OWNER, via: 'web', reason: 'owner', mode: 'commit' })).toMatchObject({ code: 'not_linked' });
    expect(frozen.calls).toEqual([{ at: 'unlink', channelId: 'CPUB0001', spaceName: 'pay-team' }]);
  });

  it('termag removed: unlinks as the system with no message', async () => {
    const post = vi.spyOn(ws.client.chat, 'postMessage');
    expect(await unlink(deps, { channelId: 'CPUB0001', actor: null, via: 'slack_event', reason: 'removed', mode: 'commit' })).toMatchObject({ kind: 'unlinked' });
    expect(post).not.toHaveBeenCalled();
    expect(spaces.eventRows.at(-1)).toMatchObject({ actorUserId: 'system', note: 'linkedVia=slack_event; reason=removed; channel=CPUB0001; name=#pay-team' });
  });

  it('a channel can be linked again after an unlink, even to another space', async () => {
    await unlink(deps, { channelId: 'CPUB0001', actor: OWNER, via: 'web', reason: 'owner', mode: 'commit' });
    ws.channels.get('CPUB0001')!.members.push('UOTH0001');
    expect(await link(deps, input({ spaceName: 'billing', actor: { userId: 'u-other', slackId: 'UOTH0001' } }))).toMatchObject({ kind: 'linked', already: false });
  });
});
