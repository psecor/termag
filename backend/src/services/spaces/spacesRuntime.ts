/**
 * The live wiring of spaces: the derived AWS resources (spaceConfig.ts), one
 * S3 client over the presigner session, the Prisma store and the flag.
 * Nothing touches AWS until the first spaces request (or a sweep that finds a
 * space), so a deployment with the flag off never reads its identity.
 */
import { boolVariation } from '../featureFlags';
import { spaceResourcesResolver } from './spaceConfig';
import { s3SpaceObjects, type SpaceObjects } from './spaceObjects';
import { prismaSpaceStore } from './spaceStorePrisma';
import { spacesSweep } from './spaceSweeper';

export const SPACES_FLAG = 'spaces-enabled';
export const SPACES_SHARING_FLAG = 'spaces-sharing-enabled';

const resources = spaceResourcesResolver();
let objects: SpaceObjects | null = null;

export async function spaceObjects(): Promise<SpaceObjects> {
  objects ??= s3SpaceObjects(await resources());
  return objects;
}

export async function spacesEnabledFor(userId: string): Promise<boolean> {
  const user = await prismaSpaceStore.ldUser(userId);
  return user ? boolVariation(SPACES_FLAG, user, false) : false;
}

export async function spacesSharingEnabledFor(userId: string): Promise<boolean> {
  const user = await prismaSpaceStore.ldUser(userId);
  return user ? boolVariation(SPACES_SHARING_FLAG, user, false) : false;
}

export const spaceStore = prismaSpaceStore;
export const spacesSweeper = spacesSweep(prismaSpaceStore, spaceObjects);
