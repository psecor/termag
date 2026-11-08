/**
 * The channel picker behind the space dialog's ComboBox and `termag space
 * slack link` (`GET /slack/channels`).
 *
 * It lists with the bot token only (never a person's MCP connector token):
 * `conversations.list` returns the public channels and the private channels
 * termag is in. The private ones are kept only where the caller is a member
 * (`conversations.members`, cached briefly), so the picker never shows a
 * private channel's name to someone outside it. Each entry says whether termag
 * is in it and whether it is linked already; a channel linked to a space the
 * caller can't see says so without naming the space.
 */
import { isWorkstreamChannelName } from '../../slack/channels';
import type { SlackChannelInfo } from './link';
import type { SpaceSlackAdminStore } from './manage';
import type { SpaceSlackStore } from './linkStore';

export interface PickerSlackClient {
  conversations: {
    list(args: { types: string; limit: number; exclude_archived: boolean; cursor?: string }):
      Promise<{ channels?: Array<SlackChannelInfo & { num_members?: number }>; response_metadata?: { next_cursor?: string } }>;
    members(args: { channel: string; limit: number; cursor?: string }): Promise<{ members?: string[]; response_metadata?: { next_cursor?: string } }>;
  };
}

export type PickerDisabled = 'channel_linked' | 'channel_workstream' | 'channel_ext_shared';

export interface PickerEntry {
  id: string;
  name: string;
  private: boolean;
  termagIn: boolean;
  members: number | null;
  /** The space it is linked to: its name when the caller is a member of it, else null; absent when not linked. */
  linkedTo?: string | null;
  /** Why it can't be picked; absent when it can. `linkedTo` naming the asked-for space is "already linked here". */
  disabled?: PickerDisabled;
}

export interface PickerDeps {
  slack: PickerSlackClient;
  store: Pick<SpaceSlackStore, 'spaceSlackById' | 'slackIdsOf'>;
  admin: Pick<SpaceSlackAdminStore, 'channelsByIds'>;
  /** The space's name when `userId` is a member of it, else null. */
  visibleSpaceName(spaceId: string, userId: string): Promise<string | null>;
  now?: () => number;
}

const PAGE = 200;
const MAX_SLACK_PAGES = 5;
const MAX_RESULTS = 100;
const MEMBERS_TTL_MS = 60_000;

export interface PickerCache { members: Map<string, { at: number; ids: Set<string> | null }> }

export function newPickerCache(): PickerCache { return { members: new Map() }; }

async function membersOf(deps: PickerDeps, cache: PickerCache, channel: string): Promise<Set<string> | null> {
  const now = (deps.now ?? Date.now)();
  const hit = cache.members.get(channel);
  if (hit && now - hit.at < MEMBERS_TTL_MS) return hit.ids;
  let ids: Set<string> | null = new Set();
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await deps.slack.conversations.members({ channel, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const m of res.members ?? []) ids.add(m);
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch {
    ids = null;
  }
  cache.members.set(channel, { at: now, ids });
  if (cache.members.size > 5000) cache.members.delete(cache.members.keys().next().value!);
  return ids;
}

/**
 * One page of the picker: channels whose name contains `query` (all of them
 * without one), from `cursor` (Slack's). `nextCursor` is null at the end.
 */
export async function pickChannels(deps: PickerDeps, cache: PickerCache, input: { userId: string; query?: string; cursor?: string }):
  Promise<{ channels: PickerEntry[]; nextCursor: string | null }> {
  const query = (input.query ?? '').trim().replace(/^#/, '').toLowerCase();
  const callerSlackId = (await deps.store.slackIdsOf([input.userId])).get(input.userId) ?? null;
  const found: Array<SlackChannelInfo & { num_members?: number }> = [];
  let cursor = input.cursor || undefined;
  for (let page = 0; page < MAX_SLACK_PAGES && found.length < MAX_RESULTS; page++) {
    const res = await deps.slack.conversations.list({ types: 'public_channel,private_channel', limit: PAGE, exclude_archived: true, ...(cursor ? { cursor } : {}) });
    for (const c of res.channels ?? []) {
      if (!c.id || !c.name || c.is_archived || c.is_im || c.is_mpim) continue;
      if (query && !c.name.toLowerCase().includes(query)) continue;
      found.push(c);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }

  // Private: only those the caller is in. Without a Slack id, none.
  const kept: typeof found = [];
  for (const c of found) {
    if (!c.is_private) { kept.push(c); continue; }
    if (!callerSlackId) continue;
    const members = await membersOf(deps, cache, c.id!);
    if (members?.has(callerSlackId)) kept.push(c);
  }

  const rows = new Map((await deps.admin.channelsByIds(kept.map(c => c.id!))).filter(r => !r.unlinkedAt).map(r => [r.channelId, r] as const));
  const spaceNames = new Map<string, string | null>();
  const channels: PickerEntry[] = [];
  for (const c of kept) {
    const entry: PickerEntry = { id: c.id!, name: c.name!, private: !!c.is_private, termagIn: !!c.is_member, members: c.num_members ?? null };
    const row = rows.get(c.id!);
    if (row) {
      if (!spaceNames.has(row.spaceSlackId)) {
        const ss = await deps.store.spaceSlackById(row.spaceSlackId);
        spaceNames.set(row.spaceSlackId, ss ? await deps.visibleSpaceName(ss.spaceId, input.userId) : null);
      }
      entry.linkedTo = spaceNames.get(row.spaceSlackId) ?? null;
      entry.disabled = 'channel_linked';
    } else if (isWorkstreamChannelName(c.name!)) {
      entry.disabled = 'channel_workstream';
    } else if (c.is_ext_shared) {
      entry.disabled = 'channel_ext_shared';
    }
    channels.push(entry);
  }
  channels.sort((a, b) => a.name.localeCompare(b.name));
  return { channels, nextCursor: cursor ?? null };
}
