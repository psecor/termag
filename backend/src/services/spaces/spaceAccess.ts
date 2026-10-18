/**
 * Who may do what in a space.
 *
 *   a user (browser session, CLI device login)  their SpaceMember role
 *   a box (its tmag_ token)                      its owner's current role, and
 *       only while the box is not terminated, the owner is a member, and the
 *       box or one of its ancestors (spaceInheritance) has a SpaceBox grant
 *
 * A space with no owner member, or with readOnlyAt set, caps every role at
 * viewer. A deleted space, or no role, is "no access", which every route
 * answers with 404 so names don't leak.
 *
 * Pure: the store loads the facts, nothing here is cached.
 */
import type { InheritanceBox } from './spaceInheritance';

export const SPACE_ROLES = ['viewer', 'editor', 'owner'] as const;
export type SpaceRole = typeof SPACE_ROLES[number];

export function isSpaceRole(value: unknown): value is SpaceRole {
  return typeof value === 'string' && (SPACE_ROLES as readonly string[]).includes(value);
}

export function roleAtLeast(role: SpaceRole, needed: SpaceRole): boolean {
  return SPACE_ROLES.indexOf(role) >= SPACE_ROLES.indexOf(needed);
}

export type SpaceCaller =
  | { kind: 'user'; userId: string }
  | { kind: 'box'; userId: string; instanceId: string };

export interface AccessSpace {
  id: string;
  readOnlyAt: Date | null;
  deletedAt: Date | null;
}

export interface AccessFacts {
  space: AccessSpace;
  /** userId → role, every member of the space. */
  members: ReadonlyMap<string, SpaceRole>;
  /** Instance ids with an explicit SpaceBox grant. */
  grantedBoxIds: ReadonlySet<string>;
  /** Only for a box caller: the box itself, then its ancestors nearest first. */
  box?: InheritanceBox | null;
  ancestors?: readonly InheritanceBox[];
}

export interface SpaceAccess {
  role: SpaceRole;
  /** The caller's role before the read-only cap. */
  memberRole: SpaceRole;
  readOnly: boolean;
  /** For a box caller: how it reached the space. */
  boxAccess?: { kind: 'explicit' } | { kind: 'inherited'; via: string };
}

export function isReadOnly(space: AccessSpace, members: ReadonlyMap<string, SpaceRole>): boolean {
  if (space.readOnlyAt) return true;
  for (const role of members.values()) if (role === 'owner') return false;
  return true;
}

function boxAccessOf(facts: AccessFacts, ownerId: string): SpaceAccess['boxAccess'] | null {
  const box = facts.box;
  if (!box || box.status === 'terminated' || box.userId !== ownerId) return null;
  if (facts.grantedBoxIds.has(box.id)) return { kind: 'explicit' };
  for (const parent of facts.ancestors ?? []) {
    if (parent.status === 'terminated' || parent.userId !== ownerId) return null;
    if (facts.grantedBoxIds.has(parent.id)) return { kind: 'inherited', via: parent.id };
  }
  return null;
}

export function resolveSpaceAccess(caller: SpaceCaller, facts: AccessFacts): SpaceAccess | null {
  if (facts.space.deletedAt) return null;
  const memberRole = facts.members.get(caller.userId);
  if (!memberRole) return null;

  let boxAccess: SpaceAccess['boxAccess'];
  if (caller.kind === 'box') {
    if (facts.box?.id !== caller.instanceId) return null;
    const via = boxAccessOf(facts, caller.userId);
    if (!via) return null;
    boxAccess = via;
  }

  const readOnly = isReadOnly(facts.space, facts.members);
  const role: SpaceRole = readOnly ? 'viewer' : memberRole;
  return { role, memberRole, readOnly, ...(boxAccess ? { boxAccess } : {}) };
}

/** Membership and settings changes: owner, and never on a read-only space. */
export function canManage(access: SpaceAccess): boolean {
  return access.role === 'owner';
}

/**
 * Adding a box: its owner, as an editor or owner of the space, and only a box
 * they own (checked by the caller against the Instance row).
 */
export function canAddBox(access: SpaceAccess): boolean {
  return roleAtLeast(access.role, 'editor');
}

/** Removing a box grant: the box's owner, or any space owner. */
export function canRemoveBox(access: SpaceAccess, callerUserId: string, boxOwnerId: string | null): boolean {
  if (access.readOnly) return false;
  return access.role === 'owner' || (boxOwnerId === callerUserId && roleAtLeast(access.role, 'viewer'));
}

/** Would this change leave the space without an owner? */
export function wouldRemoveLastOwner(members: ReadonlyMap<string, SpaceRole>, userId: string, newRole: SpaceRole | null): boolean {
  if (members.get(userId) !== 'owner' || newRole === 'owner') return false;
  for (const [id, role] of members) if (id !== userId && role === 'owner') return false;
  return true;
}
