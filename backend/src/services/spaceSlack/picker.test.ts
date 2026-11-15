import { describe, expect, it } from 'vitest';
import { ABSENCE_RECHECK_MS, newPickerCache, pickChannels, PUBLIC_MEMBER_LOOKUPS_PER_PICK, type PickerDeps, type PickerSlackClient } from './picker';

/**
 * The picker's membership paths, against a scripted Slack and a clock: a
 * complete list (cached, then trusted, then rechecked), an unreadable one
 * (cold and over a good list), paginated lists and the call budget, private
 * channels, and a caller with no Slack id.
 */
const ME = 'UME00001';

interface Chan { id: string; name: string; private?: boolean; members: string[]; pageSize?: number; failing?: boolean }

function setup(chans: Chan[], opts: { slackId?: string | null } = {}) {
  let who: string | null | undefined;
  let clock = 1_000_000;
  const calls: string[] = [];
  const byId = new Map(chans.map(c => [c.id, c]));
  const slack: PickerSlackClient = {
    conversations: {
      async list() {
        return { channels: chans.map(c => ({ id: c.id, name: c.name, is_private: !!c.private, is_member: true, num_members: c.members.length })), response_metadata: { next_cursor: '' } };
      },
      async members({ channel, cursor }) {
        calls.push(channel);
        const c = byId.get(channel)!;
        if (c.failing) throw Object.assign(new Error('ratelimited'), { data: { error: 'ratelimited' } });
        const size = c.pageSize ?? 1000;
        const start = cursor ? Number(cursor) : 0;
        const next = start + size < c.members.length ? String(start + size) : '';
        return { members: c.members.slice(start, start + size), response_metadata: { next_cursor: next } };
      },
    },
  };
  const slackIdNow = () => (who !== undefined ? who : opts.slackId === undefined ? ME : opts.slackId);
  const deps: PickerDeps = {
    slack,
    store: {
      async slackIdsOf(ids) { const id0 = slackIdNow(); return new Map(id0 ? ids.map(id => [id, id0] as const) : []); },
      async spaceSlackById() { return null; },
    },
    admin: { async channelsByIds() { return []; } },
    async visibleSpaceName() { return null; },
    now: () => clock,
  };
  const cache = newPickerCache();
  const pick = async () => Object.fromEntries((await pickChannels(deps, cache, { userId: 'u1' })).channels.map(c => [c.name, c]));
  return { pick, calls, byId, tick: (ms: number) => { clock += ms; }, as: (slackId: string) => { who = slackId; } };
}

describe('the picker\'s membership checks', () => {
  it('a complete list: disables a channel without the caller, then answers repeat searches from the cache', async () => {
    const t = setup([{ id: 'C1', name: 'outsiders', members: ['UOTHER01'] }, { id: 'C2', name: 'mine', members: [ME] }]);
    let r = await t.pick();
    expect(r.outsiders.disabled).toBe('not_in_channel');
    expect(r.mine.disabled).toBeUndefined();
    // Checked in name order, what the person sees first.
    expect(t.calls).toEqual(['C2', 'C1']);
    // Typing again within the recheck window: no Slack call, same answer.
    t.tick(ABSENCE_RECHECK_MS - 1);
    r = await t.pick();
    expect(t.calls).toHaveLength(2);
    expect(r.outsiders.disabled).toBe('not_in_channel');
  });

  it('a cached absence is read once more after the recheck window, so someone who just joined can pick it', async () => {
    const t = setup([{ id: 'C1', name: 'outsiders', members: ['UOTHER01'] }]);
    await t.pick();
    t.byId.get('C1')!.members.push(ME);
    t.tick(ABSENCE_RECHECK_MS);
    const r = await t.pick();
    expect(t.calls).toEqual(['C1', 'C1']);
    expect(r.outsiders.disabled).toBeUndefined();
    // A cached presence is trusted for the whole TTL.
    t.tick(30_000);
    await t.pick();
    expect(t.calls).toHaveLength(2);
  });

  it('an unreadable channel, cold: pickable, and not asked again on every search', async () => {
    const t = setup([{ id: 'C1', name: 'busy', members: ['UOTHER01'], failing: true }]);
    expect((await t.pick()).busy.disabled).toBeUndefined();
    await t.pick();
    expect(t.calls).toEqual(['C1']);
  });

  it('a failed recheck keeps the good list it had: a correctly disabled channel stays disabled', async () => {
    const t = setup([{ id: 'C1', name: 'outsiders', members: ['UOTHER01'] }]);
    expect((await t.pick()).outsiders.disabled).toBe('not_in_channel');
    t.byId.get('C1')!.failing = true;
    t.tick(ABSENCE_RECHECK_MS);
    expect((await t.pick()).outsiders.disabled).toBe('not_in_channel');
  });

  it('a recheck that fails waits a full window before the next one, keeping the list', async () => {
    const t = setup([{ id: 'C1', name: 'outsiders', members: ['UOTHER01'] }]);
    await t.pick();
    t.byId.get('C1')!.failing = true;
    t.tick(ABSENCE_RECHECK_MS);
    expect((await t.pick()).outsiders.disabled).toBe('not_in_channel');
    // Searches right after the failed recheck make no Slack call…
    t.tick(1_000);
    await t.pick();
    t.tick(1_000);
    await t.pick();
    expect(t.calls).toEqual(['C1', 'C1']);
    // …until a window has passed since that attempt.
    t.tick(ABSENCE_RECHECK_MS);
    await t.pick();
    expect(t.calls).toEqual(['C1', 'C1', 'C1']);
  });

  it('a recheck that comes back partial also waits a full window', async () => {
    // Complete at first (one page), then grown past what the budget reads in one answer.
    const t = setup([{ id: 'C1', name: 'grown', pageSize: 1, members: ['UOTHER01'] }]);
    await t.pick();
    t.byId.get('C1')!.members.push(...Array.from({ length: 40 }, (_, i) => `UX${i}`));
    t.tick(ABSENCE_RECHECK_MS);
    expect((await t.pick()).grown.disabled).toBe('not_in_channel');
    const after = t.calls.length;
    t.tick(1_000);
    await t.pick();
    expect(t.calls.length).toBe(after);
  });

  it('a partial read never replaces a complete list: what it finds is added, and the list stays complete for everyone', async () => {
    // Complete at first (one page) with UOTHER01 only; then the caller joins and the channel grows past the budget.
    const t = setup([{ id: 'C1', name: 'grown', pageSize: 1, members: ['UOTHER01'] }]);
    expect((await t.pick()).grown.disabled).toBe('not_in_channel');
    t.byId.get('C1')!.members.unshift(ME);
    t.byId.get('C1')!.members.push(...Array.from({ length: 40 }, (_, i) => `UX${i}`));
    t.tick(ABSENCE_RECHECK_MS);
    // The partial recheck finds the caller: pickable for them…
    expect((await t.pick()).grown.disabled).toBeUndefined();
    // …and for someone else the complete list still answers (absent: still disabled), with no new call.
    const after = t.calls.length;
    t.as('USOMEONE');
    expect((await t.pick()).grown.disabled).toBe('not_in_channel');
    expect(t.calls.length).toBe(after);
  });

  it('a large private channel: a partial list that has the caller is reused; another caller is read afresh', async () => {
    const t = setup([{ id: 'G1', name: 'vast', private: true, pageSize: 1, members: [ME, ...Array.from({ length: 30 }, (_, i) => `UX${i}`)] }]);
    expect(Object.keys(await t.pick())).toEqual(['vast']);
    const first = t.calls.length;
    expect(first).toBe(20);
    t.tick(1_000);
    expect(Object.keys(await t.pick())).toEqual(['vast']);
    expect(t.calls.length).toBe(first);
    // Someone the partial list doesn't show: it proves nothing for them, so the channel stays hidden (fail
    // closed). Like an absence it answers for a window, then is read again.
    t.as('UNOTIN01');
    expect(Object.keys(await t.pick())).toEqual([]);
    expect(t.calls.length).toBe(first);
    t.tick(ABSENCE_RECHECK_MS);
    expect(Object.keys(await t.pick())).toEqual([]);
    expect(t.calls.length).toBe(first + 20);
  });

  it('the budget counts every Slack call, pages included, and a partial list proves nothing', async () => {
    // Seven channels of three pages each: 21 calls to read them all, one more than the budget.
    const chans = Array.from({ length: 7 }, (_, i) => ({
      id: `C${i}`, name: `big-${i}`, pageSize: 2, members: ['UA', 'UB', 'UC', 'UD', 'UE', 'UF'],
    }));
    const t = setup(chans);
    const r = await t.pick();
    expect(t.calls).toHaveLength(PUBLIC_MEMBER_LOOKUPS_PER_PICK);
    expect(['big-0', 'big-1', 'big-2', 'big-3', 'big-4', 'big-5'].every(n => r[n].disabled === 'not_in_channel')).toBe(true);
    // big-6 was read only in part (two of three pages): not disabled, and not cached.
    expect(r['big-6'].disabled).toBeUndefined();
    // The partial list is kept, proving nothing: read again only once its window has passed.
    const before = t.calls.length;
    await t.pick();
    expect(t.calls.length).toBe(before);
    // Once the window has passed, the absences and the partial list are rechecked, still within the budget.
    t.tick(ABSENCE_RECHECK_MS);
    await t.pick();
    expect(t.calls.length - before).toBe(PUBLIC_MEMBER_LOOKUPS_PER_PICK);
  });

  it('a partial list that has the caller is enough to keep the channel pickable', async () => {
    const t = setup([{ id: 'C1', name: 'huge', pageSize: 1, members: [ME, ...Array.from({ length: 40 }, (_, i) => `UX${i}`)] }]);
    expect((await t.pick()).huge.disabled).toBeUndefined();
  });

  it('private channels: shown only when the caller is found in them; partial or unreadable hides them', async () => {
    const t = setup([
      { id: 'G1', name: 'leads', private: true, members: [ME] },
      { id: 'G2', name: 'hr', private: true, members: ['UOTHER01'] },
      { id: 'G3', name: 'locked', private: true, members: [ME], failing: true },
      { id: 'G4', name: 'vast', private: true, pageSize: 1, members: [...Array.from({ length: 25 }, (_, i) => `UX${i}`), ME] },
    ]);
    expect(Object.keys(await t.pick()).sort()).toEqual(['leads']);
  });

  it('a caller with no Slack id: no member calls, no private channels, every public one disabled', async () => {
    const t = setup([{ id: 'C1', name: 'general', members: [ME] }, { id: 'G1', name: 'leads', private: true, members: [ME] }], { slackId: null });
    const r = await t.pick();
    expect(Object.keys(r)).toEqual(['general']);
    expect(r.general.disabled).toBe('actor_not_in_slack');
    expect(t.calls).toEqual([]);
  });
});
