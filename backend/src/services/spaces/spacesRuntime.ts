/**
 * The live wiring of spaces: the derived AWS resources (spaceConfig.ts), an
 * S3 client per acting identity over its own presigner session, the Prisma
 * store. Nothing touches AWS until the first spaces request (or
 * a sweep that finds a space).
 *
 * With SPACES_STORAGE=local the bytes are on this host's disk instead
 * (localSpaceObjects.ts), served by routes/spaceStorage.ts, which index.ts
 * mounts when localSpaceStorage() answers one; AWS is never touched.
 */
import { prisma } from '../../db';
import { listen } from '../pgListener';
import { fileChangePayload, parseFileChange, SPACE_FILE_CHANNEL, type FileChange } from './spaceFileBus';
import { spaceFileFeed, type FeedClient } from './spaceFileFeed';
import { spaceResourcesResolver, spacesStorageFromEnv, SpacesUnavailableError } from './spaceConfig';
import { LocalSpaceObjects } from './localSpaceObjects';
import { presignerObjects, SWEEP_IDENTITY, type PresignerIdentity, type SpaceObjects } from './spaceObjects';
import { prismaSpaceStore } from './spaceStorePrisma';
import { spacesSweep } from './spaceSweeper';
import { spaceChannelsEnabled } from '../spaceSlack/flags';

const resources = spaceResourcesResolver();
let objectsFor: ((identity: PresignerIdentity) => SpaceObjects) | null = null;
const storage = spacesStorageFromEnv(process.env);
let local: LocalSpaceObjects | null = null;
let logged = false;

/**
 * Local storage, when SPACES_STORAGE=local; null on S3. Its URLs are under
 * `${FRONTEND_URL}${BASE_PATH}/api/space-storage`, with index.ts's defaults,
 * and signed with a key derived from SESSION_SECRET (spaceFileOps.ts's default
 * for its upload proofs too).
 */
export function localSpaceStorage(): LocalSpaceObjects | null {
  if (storage.kind !== 'local') return null;
  local ??= new LocalSpaceObjects({
    root: storage.root,
    baseUrl: `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}${process.env.BASE_PATH ?? ''}/api/space-storage`,
    secret: process.env.SESSION_SECRET ?? 'dev-secret',
  });
  return local;
}

export async function spaceObjects(identity: PresignerIdentity): Promise<SpaceObjects> {
  if (storage.kind === 'invalid') {
    if (!logged) { logged = true; console.warn(`[SPACES] unavailable: ${storage.reason}`); }
    throw new SpacesUnavailableError(storage.reason);
  }
  if (storage.kind === 'local') {
    if (!logged) { logged = true; console.log(`[SPACES] storage on local disk at ${storage.root}`); }
    return localSpaceStorage()!;
  }
  objectsFor ??= presignerObjects(await resources());
  return objectsFor(identity);
}

/** space-channels-enabled: Slack channels linked to a space, for this person. */
export async function spaceChannelsEnabledFor(userId: string): Promise<boolean> {
  const user = await prismaSpaceStore.ldUser(userId);
  return user ? spaceChannelsEnabled(user) : false;
}

/** Sends a file change to every orchestrator process (spaceFileBus.ts); a failure costs only the live update. */
export function notifySpaceFileChange(change: FileChange): void {
  prisma.$executeRaw`SELECT pg_notify(${SPACE_FILE_CHANNEL}, ${fileChangePayload(change)})`
    .catch(err => console.warn(`[SPACES] file change notify failed: ${(err as Error).message}`));
}

/**
 * Hears SPACE_FILE_CHANNEL in this process and pushes each change to the
 * status sockets allowed to see it (spaceFileFeed.ts); after a reconnect of the
 * LISTEN connection, a resync. Returns the stop.
 */
export function startSpaceFileFeed(clients: () => Iterable<FeedClient>): () => void {
  const feed = spaceFileFeed({ store: prismaSpaceStore, clients });
  let first = true;
  return listen(SPACE_FILE_CHANNEL, {
    onPayload: payload => {
      const change = parseFileChange(payload);
      if (change) feed.deliver(change).catch(err => console.warn(`[SPACES] file change push failed: ${(err as Error).message}`));
    },
    onListening: () => {
      if (first) { first = false; return; }
      feed.resync().catch(() => {});
    },
    missed: 'space file changes meanwhile reach open views only at the resync',
  });
}

export const spaceStore = prismaSpaceStore;
export const spacesSweeper = spacesSweep(prismaSpaceStore, () => spaceObjects(SWEEP_IDENTITY));
