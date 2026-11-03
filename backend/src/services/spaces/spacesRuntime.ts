/**
 * The live wiring of spaces: the derived AWS resources (spaceConfig.ts), an
 * S3 client per acting identity over its own presigner session, the Prisma
 * store and the flag. Nothing touches AWS until the first spaces request (or a
 * sweep that finds a space), so a deployment with the flag off never reads its
 * identity.
 */
import { prisma } from '../../db';
import { boolVariation } from '../featureFlags';
import { listen } from '../pgListener';
import { fileChangePayload, parseFileChange, SPACE_FILE_CHANNEL, type FileChange } from './spaceFileBus';
import { spaceFileFeed, type FeedClient } from './spaceFileFeed';
import { spaceResourcesResolver } from './spaceConfig';
import { presignerObjects, SWEEP_IDENTITY, type PresignerIdentity, type SpaceObjects } from './spaceObjects';
import { prismaSpaceStore } from './spaceStorePrisma';
import { spacesSweep } from './spaceSweeper';

export const SPACES_FLAG = 'spaces-enabled';
export const SPACES_SHARING_FLAG = 'spaces-sharing-enabled';
export const SPACES_HTML_LINKS_FLAG = 'spaces-html-links-enabled';
export const SPACE_MEMORY_FLAG = 'space-memory-enabled';
export const SIMPLE_UI_FLAG = 'simple-ui-enabled';
export const SIMPLE_UI_SIDE_PANEL_FLAG = 'simple-ui-side-panel-enabled';

const resources = spaceResourcesResolver();
let objectsFor: ((identity: PresignerIdentity) => SpaceObjects) | null = null;

export async function spaceObjects(identity: PresignerIdentity): Promise<SpaceObjects> {
  objectsFor ??= presignerObjects(await resources());
  return objectsFor(identity);
}

export async function spacesEnabledFor(userId: string): Promise<boolean> {
  const user = await prismaSpaceStore.ldUser(userId);
  return user ? boolVariation(SPACES_FLAG, user, false) : false;
}

export async function spacesSharingEnabledFor(userId: string): Promise<boolean> {
  const user = await prismaSpaceStore.ldUser(userId);
  return user ? boolVariation(SPACES_SHARING_FLAG, user, false) : false;
}

export async function spacesHtmlLinksEnabledFor(userId: string): Promise<boolean> {
  const user = await prismaSpaceStore.ldUser(userId);
  return user ? boolVariation(SPACES_HTML_LINKS_FLAG, user, false) : false;
}

/**
 * Whether the simple UI's space page with Files (/chat/files/<space>) is
 * mounted for this user, as ChatApp mounts it: simple-ui-enabled and
 * simple-ui-side-panel-enabled (spaces-enabled is checked by the caller).
 * Where a folder's link may send them (routes/spaceFiles.ts).
 */
export async function simpleUiFilesEnabledFor(userId: string): Promise<boolean> {
  const user = await prismaSpaceStore.ldUser(userId);
  if (!user) return false;
  const [simple, panel] = await Promise.all([boolVariation(SIMPLE_UI_FLAG, user, false), boolVariation(SIMPLE_UI_SIDE_PANEL_FLAG, user, false)]);
  return simple && panel;
}

/** space-memory-enabled: a box's agents load and write the space's `.termag/`. */
export async function spaceMemoryEnabledFor(userId: string): Promise<boolean> {
  const user = await prismaSpaceStore.ldUser(userId);
  return user ? boolVariation(SPACE_MEMORY_FLAG, user, false) : false;
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
  const feed = spaceFileFeed({ store: prismaSpaceStore, enabled: spacesEnabledFor, clients });
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
