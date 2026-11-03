/**
 * Space file changes to the browsers that can see them. Every process runs it over its own status sockets: a change heard
 * on SPACE_FILE_CHANNEL (spaceFileBus.ts) goes, as a `space-file` frame, only
 * to people who can read that space right now, checked the way a read is
 * (resolveSpaceAccess: a member, the space not deleted) with spaces-enabled
 * on for them. Anyone else gets nothing, so a
 * path never reaches someone outside the space. The frame names the space as
 * the browser does, by its current name.
 *
 * `resync` is for after this process's LISTEN connection came back: changes
 * may have gone by unheard, so each live socket is told to check what it
 * shows. It names no space or path.
 */
import { resolveSpaceAccess } from './spaceAccess';
import type { FileChange } from './spaceFileBus';
import type { SpaceStore } from './spaceStore';

export interface FeedClient { userId: string; send: (frame: string) => void }

export interface SpaceFileFeedDeps {
  store: Pick<SpaceStore, 'findSpace' | 'memberRoles'>;
  /** spaces-enabled for this user. */
  enabled: (userId: string) => Promise<boolean>;
  /** This process's open status sockets. */
  clients: () => Iterable<FeedClient>;
}

export interface SpaceFileFrame {
  type: 'space-file';
  space?: string;
  kind?: FileChange['kind'];
  path?: string;
  to?: string;
  etag?: string;
  resync?: true;
}

export function spaceFileFeed(deps: SpaceFileFeedDeps) {
  /** Sends `frame` to each client whose user passes `admit`, deciding once per user. */
  async function sendTo(admit: (userId: string) => Promise<boolean>, frame: SpaceFileFrame): Promise<number> {
    const byUser = new Map<string, FeedClient[]>();
    for (const c of deps.clients()) {
      const list = byUser.get(c.userId);
      if (list) list.push(c); else byUser.set(c.userId, [c]);
    }
    const body = JSON.stringify(frame);
    let sent = 0;
    await Promise.all([...byUser].map(async ([userId, list]) => {
      if (!await admit(userId).catch(() => false)) return;
      for (const c of list) { c.send(body); sent++; }
    }));
    return sent;
  }

  return {
    async deliver(change: FileChange): Promise<number> {
      const space = await deps.store.findSpace(change.spaceId);
      // findSpace also matches a name; only the space with this id counts.
      if (!space || space.id !== change.spaceId) return 0;
      const members = await deps.store.memberRoles(space.id);
      const grantedBoxIds = new Set<string>();
      return sendTo(async userId => {
        if (!resolveSpaceAccess({ kind: 'user', userId }, { space, members, grantedBoxIds })) return false;
        return deps.enabled(userId);
      }, {
        type: 'space-file', space: space.name, kind: change.kind,
        ...(change.path !== undefined ? { path: change.path } : {}),
        ...(change.to !== undefined ? { to: change.to } : {}),
        ...(change.etag ? { etag: change.etag } : {}),
      });
    },

    resync(): Promise<number> {
      return sendTo(deps.enabled, { type: 'space-file', resync: true });
    },
  };
}
