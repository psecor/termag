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
 * caller can't see says so without naming the space. A public channel the
 * caller isn't in is listed but disabled (`not_in_channel`): linking one needs
 * the caller in it from termag too, as from Slack (product owner, 2026-11-06).
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

export type PickerDisabled = 'channel_linked' | 'channel_workstream' | 'channel_ext_shared' | 'not_in_channel' | 'actor_not_in_slack';

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

/**
 * Per channel: `ids` as read at `at` (null: the read failed), `complete` false when the read stopped early,
 * and `checkedAt`, the last attempt to read it again (a recheck that failed or came back partial).
 */
export interface PickerCacheEntry { at: number; ids: Set<string> | null; complete?: boolean; checkedAt?: number }
export interface PickerCache { members: Map<string, PickerCacheEntry> }

export function newPickerCache(): PickerCache { return { members: new Map() }; }

/** Slack calls (pages of conversations.members) one picker answer may make for public channels (Tier 4). */
export const PUBLIC_MEMBER_LOOKUPS_PER_PICK = 20;
/** How long a cached list without the caller is trusted before it may be read once more (someone just joined). */
export const ABSENCE_RECHECK_MS = 10_000;
const MAX_MEMBER_PAGES = 20;

/** A channel's members as read: `complete` false when the reading stopped early (budget, page cap), so an absence proves nothing. */
export interface MembersRead { ids: Set<string>; complete: boolean }

/**
 * A channel's members, from the cache when it can answer.
 *
 * - Entries live MEMBERS_TTL_MS. A failed read is remembered as such for as long (a throttled channel isn't
 *   asked again on every keystroke), unless a list is there: a failure never replaces a list.
 * - A list that has `needs` answers at once, complete or not (a partial list proves presence).
 * - A list without `needs` (an absence, or a partial list that proves nothing) answers until
 *   ABSENCE_RECHECK_MS after its last read or recheck attempt (`checkedAt`); then it is read once more.
 *   A recheck that fails or comes back partial keeps the list and moves `checkedAt`, so the next one waits too.
 * - `budget`: every Slack call (each page) spends one. With none left the reading stops: before the first
 *   page the answer is the cached list if any, else undefined (not checked); after it, a partial list.
 * - null: Slack wouldn't say, and nothing is cached.
 */
async function membersOf(deps: PickerDeps, cache: PickerCache, channel: string, opts: { needs?: string; budget?: { left: number } } = {}):
  Promise<MembersRead | null | undefined> {
  const now = (deps.now ?? Date.now)();
  const hit = cache.members.get(channel);
  const fresh = hit && now - hit.at < MEMBERS_TTL_MS ? hit : null;
  if (fresh && !fresh.ids) return null;
  const cached = fresh?.ids ? { ids: fresh.ids, complete: fresh.complete !== false } : null;
  if (cached) {
    const proves = !!opts.needs && cached.ids.has(opts.needs);
    const trusted = cached.complete && !opts.needs;
    const recheckDue = now - (fresh!.checkedAt ?? fresh!.at) >= ABSENCE_RECHECK_MS;
    if (proves || trusted || !recheckDue) return cached;
  }

  const ids = new Set<string>();
  let pages = 0;
  let complete = false;
  let failed = false;
  try {
    let cursor: string | undefined;
    while (pages < MAX_MEMBER_PAGES) {
      if (opts.budget) {
        if (opts.budget.left <= 0) break;
        opts.budget.left--;
      }
      pages++;
      const res = await deps.slack.conversations.members({ channel, limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const m of res.members ?? []) ids.add(m);
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) { complete = true; break; }
    }
  } catch {
    failed = true;
  }
  if (!pages && !failed) return cached ?? undefined;
  // A partial read never replaces a complete list (the cache is shared: everyone else's answers rest on it).
  // The members it did find are added to it: additions are real, and it stays complete for the rest.
  if (!failed && !complete && cached?.complete) {
    for (const id of ids) cached.ids.add(id);
    fresh!.checkedAt = now;
    return cached;
  }
  const fresher = !failed && (complete || !cached || cached.complete === false);
  if (fresher) {
    remember(cache, channel, { at: now, ids, complete });
    return { ids, complete };
  }
  // Failed: keep the list, and wait before trying again.
  if (cached) {
    fresh!.checkedAt = now;
    return cached;
  }
  remember(cache, channel, { at: now, ids: null });
  return null;
}

function remember(cache: PickerCache, channel: string, entry: PickerCacheEntry): void {
  cache.members.set(channel, entry);
  if (cache.members.size > 5000) cache.members.delete(cache.members.keys().next().value!);
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

  // Private: only those the caller is in (their names are not shown to anyone else). Without a Slack id, none.
  // Public: all of them, but linking one needs the caller in it too (link.ts, from every entry point), so one
  // they are known not to be in is disabled. That is advice, not the rule: link() reads the members afresh.
  // So a public channel is checked only within PUBLIC_MEMBER_LOOKUPS_PER_PICK Slack calls (the list's first
  // ones by name, what the person sees first; membersOf has the cache's rules), and one unchecked, unreadable
  // (throttled) or only partly read stays pickable.
  found.sort((a, b) => a.name!.localeCompare(b.name!));
  const budget = { left: PUBLIC_MEMBER_LOOKUPS_PER_PICK };
  const kept: typeof found = [];
  const notIn = new Set<string>();
  for (const c of found) {
    if (!c.is_private) {
      kept.push(c);
      if (!callerSlackId) continue;
      const members = await membersOf(deps, cache, c.id!, { needs: callerSlackId, budget });
      // Disabled only on a complete list without them: unchecked, unreadable or partial, link() decides.
      if (members?.complete && !members.ids.has(callerSlackId)) notIn.add(c.id!);
      continue;
    }
    if (!callerSlackId) continue;
    // Private: shown only when the caller is found in it (a partial or unreadable list hides it).
    const members = await membersOf(deps, cache, c.id!, { needs: callerSlackId });
    if (members?.ids.has(callerSlackId)) kept.push(c);
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
    } else if (!callerSlackId) {
      entry.disabled = 'actor_not_in_slack';
    } else if (notIn.has(c.id!)) {
      entry.disabled = 'not_in_channel';
    }
    channels.push(entry);
  }
  channels.sort((a, b) => a.name.localeCompare(b.name));
  return { channels, nextCursor: cursor ?? null };
}
