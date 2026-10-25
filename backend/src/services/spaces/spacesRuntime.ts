/**
 * The live wiring of spaces: the derived AWS resources (spaceConfig.ts), an
 * S3 client per acting identity over its own presigner session, the Prisma
 * store and the flag. Nothing touches AWS until the first spaces request (or a
 * sweep that finds a space), so a deployment with the flag off never reads its
 * identity.
 */
import { boolVariation } from '../featureFlags';
import { spaceResourcesResolver } from './spaceConfig';
import { presignerObjects, SWEEP_IDENTITY, type PresignerIdentity, type SpaceObjects } from './spaceObjects';
import { prismaSpaceStore } from './spaceStorePrisma';
import { spacesSweep } from './spaceSweeper';

export const SPACES_FLAG = 'spaces-enabled';
export const SPACES_SHARING_FLAG = 'spaces-sharing-enabled';
export const SPACES_HTML_LINKS_FLAG = 'spaces-html-links-enabled';

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

export const spaceStore = prismaSpaceStore;
export const spacesSweeper = spacesSweep(prismaSpaceStore, () => spaceObjects(SWEEP_IDENTITY));
