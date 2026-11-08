/**
 * The admin store (manage.ts) over spaceSlackTestkit's MemorySpaceSlackStore,
 * for the route and manage tests. Compiled with the app; no vitest here.
 */
import type { SpaceSlackAdminStore } from './manage';
import type { MemorySpaceSlackStore } from './spaceSlackTestkit';
import type { SpaceStore } from '../spaces/spaceStore';

export function memoryAdminStore(store: MemorySpaceSlackStore, spaces: Pick<SpaceStore, 'events'>): SpaceSlackAdminStore {
  return {
    async linkedChannels(spaceSlackId) {
      return [...store.channels.values()].filter(c => c.spaceSlackId === spaceSlackId && !c.unlinkedAt)
        .sort((a, b) => a.linkedAt.getTime() - b.linkedAt.getTime());
    },
    async channelsByIds(ids) { return ids.map(id => store.channels.get(id)).filter(c => !!c); },
    async setStatus(id, from, to) {
      const row = store.slack.get(id);
      if (!row || row.disabledAt || !from.includes(row.status)) return null;
      row.status = to;
      return row;
    },
    async setRunner(id, expectRunner, runnerUserId, instanceId) {
      const row = store.slack.get(id);
      if (!row || row.disabledAt || row.runnerUserId !== expectRunner) return null;
      Object.assign(row, { runnerUserId, instanceId });
      return row;
    },
    async unlinkedChannels(spaceSlackId, reason) {
      return [...store.channels.values()].filter(c => c.spaceSlackId === spaceSlackId && c.unlinkedAt && c.unlinkReason === reason);
    },
    async latestEvent(spaceId, actions) {
      // All of them, newest first, so the limit can't hide one (as the Postgres query can't).
      return (await spaces.events(spaceId, { limit: Number.MAX_SAFE_INTEGER })).find(e => actions.includes(e.action)) ?? null;
    },
    async markDisabled(id, at) {
      const row = store.slack.get(id);
      if (!row || row.disabledAt) return null;
      row.disabledAt = at;
      return row;
    },
  };
}
