/**
 * Project-name policy, kept prisma-free so it can be unit-tested.
 *
 * "MetaTerm" is reserved: the per-user control-tower singleton is created by
 * services/metaterm.ts as (userId, instanceId NULL, name "MetaTerm"), and a
 * normal project taking that name on the orchestrator would collide with it on
 * the @@unique([userId, instanceId, name]) index and break ensureMetaTerm.
 * Reserved case-insensitively so "metaterm"/"METATERM" don't confuse users
 * either, even though the DB compares names case-sensitively.
 */
export const RESERVED_PROJECT_NAMES = ['metaterm'] as const;
export const RESERVED_NAME_ERROR = '"MetaTerm" is a reserved project name';

export function isReservedProjectName(name: string): boolean {
  return (RESERVED_PROJECT_NAMES as readonly string[]).includes(name.trim().toLowerCase());
}
