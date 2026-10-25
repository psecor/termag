/**
 * What the spaces routes read and write in Postgres, as an interface so the
 * routes can be tested with an in-memory store (spaceStorePrisma.ts is the
 * real one).
 */
import type { FlagUser } from '../featureFlags';
import type { InheritanceBox } from './spaceInheritance';
import type { SpaceRole } from './spaceAccess';

export interface SpaceRecord {
  id: string;
  name: string;
  description: string | null;
  createdById: string;
  createdAt: Date;
  readOnlyAt: Date | null;
  deletedAt: Date | null;
  usedBytes: bigint;
  quotaBytes: bigint;
}

export interface SpaceUser { id: string; email: string; displayName: string; unixUsername: string }

export interface SpaceMemberRecord { userId: string; role: SpaceRole; user: SpaceUser; createdAt: Date }
export interface SpaceInviteRecord { id: string; email: string; role: SpaceRole; createdAt: Date }

export interface SpaceBoxInfo extends InheritanceBox {
  name: string;
  kind: string;
  ownerEmail: string | null;
}

export interface SpaceGrantRecord { instanceId: string; box: SpaceBoxInfo; addedById: string; createdAt: Date }

export interface SpaceEventInput {
  spaceId: string;
  actorUserId: string;
  actorInstanceId?: string | null;
  via?: string | null;
  action: string;
  path?: string | null;
  bytes?: bigint | number | null;
}

export interface SpaceEventRecord extends SpaceEventInput { id: string; at: Date }

export class SpaceNameTakenError extends Error {
  readonly code = 'name_taken';
}

/** A membership change would leave the space with no owner; the store rolled it back. */
export class LastOwnerError extends Error {
  readonly code = 'last_owner';
  constructor() { super('A space needs at least one owner; make someone else an owner first'); }
}

/** What a quota charge paid for: an object, and for a part batch its multipart upload and part numbers. */
export interface ChargeRef { key: string; uploadId?: string; partNumbers?: number[] }
export interface LiveCharge { id: string; bytes: bigint; createdAt: Date; liveUntil: Date; key: string | null; uploadId: string | null; partNumbers: number[] }

export type AddMemberResult =
  | { kind: 'member'; member: SpaceMemberRecord }
  | { kind: 'invite'; invite: SpaceInviteRecord };

export interface SpaceStore {
  ldUser(userId: string): Promise<FlagUser | null>;
  /** Turns pending invites for this user's email into memberships; returns how many. */
  claimInvites(userId: string): Promise<number>;

  spacesOfUser(userId: string): Promise<Array<{ space: SpaceRecord; role: SpaceRole }>>;
  /** Spaces with an explicit grant to any of these boxes. */
  spacesGrantedTo(instanceIds: string[]): Promise<Array<{ space: SpaceRecord; instanceId: string }>>;
  findSpace(idOrName: string): Promise<SpaceRecord | null>;
  memberRoles(spaceId: string): Promise<Map<string, SpaceRole>>;
  grantedBoxIds(spaceId: string): Promise<Set<string>>;
  box(instanceId: string): Promise<SpaceBoxInfo | null>;
  boxesOwnedBy(userId: string): Promise<SpaceBoxInfo[]>;

  createSpace(input: { name: string; description: string | null; userId: string }): Promise<SpaceRecord>;
  updateSpace(spaceId: string, patch: { name?: string; description?: string | null }): Promise<SpaceRecord>;
  /** Sets deletedAt and releases the name (rewritten to `deleted:<id>`). */
  markDeleted(spaceId: string): Promise<void>;

  members(spaceId: string): Promise<SpaceMemberRecord[]>;
  invites(spaceId: string): Promise<SpaceInviteRecord[]>;
  userByEmail(email: string): Promise<SpaceUser | null>;
  /** Adds or updates a member (or a pending invite, for an email with no user). */
  addMember(input: { spaceId: string; email: string; role: SpaceRole; addedById: string }): Promise<AddMemberResult>;
  /** Throws LastOwnerError, changing nothing, when no owner would remain. */
  setMemberRole(spaceId: string, userId: string, role: SpaceRole): Promise<void>;
  /**
   * Deletes the membership and, in the same transaction, that user's box
   * grants in the space. Throws LastOwnerError, changing nothing, when no
   * owner would remain.
   */
  removeMember(spaceId: string, userId: string): Promise<{ removedBoxes: number }>;
  removeInvite(spaceId: string, inviteId: string): Promise<boolean>;

  grants(spaceId: string): Promise<SpaceGrantRecord[]>;
  addGrant(spaceId: string, instanceId: string, addedById: string): Promise<void>;
  removeGrant(spaceId: string, instanceId: string): Promise<boolean>;

  /**
   * Adds `bytes` to usedBytes in one conditional write, only if the total stays
   * within quotaBytes; false (nothing changed) when it would not. Concurrent
   * charges can't both pass a check made before either wrote. The charge is
   * also recorded until `liveUntil` (when the URLs it paid for expire), so a
   * recount in between keeps it.
   */
  chargeBytes(spaceId: string, bytes: bigint, liveUntil: Date, ref: ChargeRef | null): Promise<boolean>;
  recordEvent(event: SpaceEventInput): Promise<void>;
  events(spaceId: string, opts: { limit: number; before?: Date | null }): Promise<SpaceEventRecord[]>;
  /** When the newest `file.put` event for this path was recorded, if any. */
  lastPutAt(spaceId: string, path: string): Promise<Date | null>;

  // The hourly sweep (spaceSweeper.ts).
  deletedSpaces(): Promise<SpaceRecord[]>;
  liveSpaces(): Promise<SpaceRecord[]>;
  /** Charges whose URLs work past `after`. */
  chargesLiveAfter(spaceId: string, after: Date): Promise<LiveCharge[]>;
  /**
   * Sets usedBytes to `stored` (what S3 holds) plus every charge still live at
   * `now`, except `settled` (charges whose bytes `stored` already includes).
   */
  recountUsedBytes(spaceId: string, stored: bigint, now: Date, settled: string[]): Promise<void>;
  pruneCharges(before: Date): Promise<number>;
  deleteSpaceRow(spaceId: string): Promise<void>;
  pruneEvents(before: Date): Promise<number>;
  pruneTerminatedGrants(): Promise<number>;
}
