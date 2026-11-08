/**
 * In-memory stand-ins for the link service's tests: a SpaceSlackStore with the
 * real one's primary-key semantics (a channel is linked at most once at a
 * time), and a fake Slack workspace behind the LinkSlackClient surface. No
 * vitest here (this file is compiled with the app): tests spy with vi.spyOn.
 */
import type { LinkSlackClient, SlackChannelInfo, ThreadFreezer } from './link';
import type { NewChannelLink, SpaceChannelRow, SpaceSlackRow, SpaceSlackStore } from './linkStore';

export class MemorySpaceSlackStore implements SpaceSlackStore {
  slack = new Map<string, SpaceSlackRow>();
  channels = new Map<string, SpaceChannelRow>();
  slackIds = new Map<string, string>();
  private seq = 0;

  async spaceSlack(spaceId: string) { return [...this.slack.values()].find(s => s.spaceId === spaceId) ?? null; }
  async spaceSlackById(id: string) { return this.slack.get(id) ?? null; }

  async enableSpaceSlack(input: { spaceId: string; enabledById: string; runnerUserId: string; instanceId: string | null }) {
    // No await before the write: spaceId is unique, so two enables can't both create.
    const existing = [...this.slack.values()].find(s => s.spaceId === input.spaceId);
    if (existing && !existing.disabledAt) return { row: existing, created: false };
    if (existing) {
      Object.assign(existing, { ...input, disabledAt: null, status: 'active' });
      return { row: existing, created: true };
    }
    const row: SpaceSlackRow = { id: `ss${++this.seq}`, projectId: null, status: 'active', limits: null, disabledAt: null, ...input };
    this.slack.set(row.id, row);
    return { row, created: true };
  }

  async releaseSpaceSlack(id: string) {
    if ([...this.channels.values()].some(c => c.spaceSlackId === id)) return false;
    return this.slack.delete(id);
  }

  async channel(channelId: string) { return this.channels.get(channelId) ?? null; }
  async activeChannelCount(spaceSlackId: string) {
    return [...this.channels.values()].filter(c => c.spaceSlackId === spaceSlackId && !c.unlinkedAt).length;
  }

  async claimChannel(link: NewChannelLink) {
    // Yield first, so two concurrent claims interleave as they would in Postgres.
    await Promise.resolve();
    const existing = this.channels.get(link.channelId);
    if (existing && !existing.unlinkedAt) return null;
    const row: SpaceChannelRow = { ...link, linkedAt: new Date(), confirmTs: null, pausedAt: null, unlinkedAt: null, unlinkReason: null };
    this.channels.set(link.channelId, row);
    return row;
  }

  async markUnlinked(channelId: string, reason: string, at: Date) {
    const row = this.channels.get(channelId);
    if (!row || row.unlinkedAt) return null;
    Object.assign(row, { unlinkedAt: at, unlinkReason: reason });
    return row;
  }

  async setConfirmTs(channelId: string, ts: string) { this.channels.get(channelId)!.confirmTs = ts; }
  async slackIdsOf(userIds: string[]) {
    return new Map(userIds.filter(id => this.slackIds.has(id)).map(id => [id, this.slackIds.get(id)!] as const));
  }
}

const slackError = (error: string) => Object.assign(new Error(`An API error occurred: ${error}`), { data: { ok: false, error } });

export interface FakeChannel extends SlackChannelInfo { members: string[] }

/**
 * A fake Slack workspace. `membersNeedJoin` makes conversations.members fail for
 * a public channel the bot hasn't joined (S2 answering "no").
 */
export function fakeSlackWorkspace(botUserId = 'UBOT0001', opts: { membersNeedJoin?: boolean } = {}) {
  const channels = new Map<string, FakeChannel>();
  const visible = (id: string) => {
    const c = channels.get(id);
    if (!c || (c.is_private && !c.is_member)) throw slackError('channel_not_found');
    return c;
  };
  const client = {
    conversations: {
      info: async ({ channel }: { channel: string }) => {
        const { members: _m, ...info } = visible(channel);
        return { channel: info };
      },
      members: async ({ channel }: { channel: string; limit: number; cursor?: string }) => {
        const c = visible(channel);
        if (opts.membersNeedJoin && !c.is_member) throw slackError('not_in_channel');
        return { members: [...c.members], response_metadata: { next_cursor: '' } };
      },
      join: async ({ channel }: { channel: string }) => {
        const c = visible(channel);
        if (c.is_private) throw slackError('method_not_supported_for_channel_type');
        c.is_member = true;
        if (!c.members.includes(botUserId)) c.members.push(botUserId);
        return { ok: true };
      },
      create: async ({ name, is_private }: { name: string; is_private: boolean }) => {
        if ([...channels.values()].some(c => c.name === name)) throw slackError('name_taken');
        const id = `CNEW${channels.size + 1}`;
        channels.set(id, { id, name, is_private, is_member: true, members: [botUserId] });
        return { channel: { id } };
      },
      invite: async ({ channel, users }: { channel: string; users: string }) => {
        const c = visible(channel);
        for (const u of users.split(',')) if (!c.members.includes(u)) c.members.push(u);
        return { ok: true };
      },
      archive: async ({ channel }: { channel: string }) => { visible(channel).is_archived = true; return { ok: true }; },
      list: async () => ({ channels: [...channels.values()].filter(c => !c.is_private).map(c => ({ name: c.name })), response_metadata: { next_cursor: '' } }),
    },
    auth: { test: async () => ({ user_id: botUserId }) },
    chat: {
      postMessage: async (_: { channel: string; text: string; blocks?: unknown[] }) => ({ ts: `${Date.now()}.000100` }),
    },
  };
  const add = (c: Partial<FakeChannel> & { id: string; name: string }) => {
    const ch: FakeChannel = { is_private: false, is_member: false, members: [], ...c };
    if (ch.is_member && !ch.members.includes(botUserId)) ch.members.push(botUserId);
    channels.set(c.id, ch);
    return ch;
  };
  return { client: client as typeof client & LinkSlackClient, channels, add, botUserId };
}

/** A ThreadFreezer that records what it was asked to freeze. */
export function recordingFreezer(spaceThreads = 0) {
  const calls: Array<{ at: 'link' | 'unlink'; channelId: string; spaceName: string; repeat?: true }> = [];
  const freezer: ThreadFreezer = {
    async freezeAtLink(channelId, spaceName, _at, opts) { calls.push({ at: 'link', channelId, spaceName, ...(opts?.repeat ? { repeat: true } : {}) }); return 0; },
    async freezeAtUnlink(channelId, spaceName) { calls.push({ at: 'unlink', channelId, spaceName }); return spaceThreads; },
    async spaceThreadCount() { return spaceThreads; },
  };
  return { freezer, calls };
}
