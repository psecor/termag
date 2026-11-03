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
  /** A file.put's S3 version. */
  versionId?: string | null;
  /** The writer's reason (spaceMemory.ts noteOf). */
  note?: string | null;
}

export interface SpaceEventRecord extends SpaceEventInput { id: string; at: Date }

/** A file shared read-only with anyone signed in to termag; `sharedBy` is null once that user is gone. */
export interface FileShareRecord { spaceId: string; path: string; sharedById: string; createdAt: Date; sharedBy: SpaceUser | null }

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

  /** The user's spaces, each with its member count (invites not included). */
  spacesOfUser(userId: string): Promise<Array<{ space: SpaceRecord; role: SpaceRole; memberCount: number }>>;
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
   * grants in the space and their projects' listings in it. Throws
   * LastOwnerError, changing nothing, when no owner would remain.
   */
  removeMember(spaceId: string, userId: string): Promise<{ removedBoxes: number }>;
  removeInvite(spaceId: string, inviteId: string): Promise<boolean>;

  grants(spaceId: string): Promise<SpaceGrantRecord[]>;
  /** Also lists the box's projects, and its descendants', in the space. */
  addGrant(spaceId: string, instanceId: string, addedById: string): Promise<void>;
  /**
   * Also unlists the box's projects and its live descendants' from the
   * space, keeping those another grant still reaches it through. A terminated
   * descendant keeps its listing: nothing re-records it once its own grants
   * are pruned.
   */
  removeGrant(spaceId: string, instanceId: string): Promise<boolean>;

  /**
   * Lists every project in each live space its box reaches, by a grant on the
   * box or one inherited from an ancestor (spaceInheritance.ts), terminated
   * boxes included while their grants last. Only adds; returns how many it
   * added. `spaceId` limits it to one space.
   */
  recordListings(spaceId?: string): Promise<number>;
  /** Boxes, in any state, with a project listed in the space. */
  listedBoxes(spaceId: string): Promise<string[]>;

  /**
   * Adds `bytes` to usedBytes in one conditional write, only if the total stays
   * within quotaBytes; false (nothing changed) when it would not. Concurrent
   * charges can't both pass a check made before either wrote. The charge is
   * also recorded until `liveUntil` (when the URLs it paid for expire), so a
   * recount in between keeps it.
   */
  chargeBytes(spaceId: string, bytes: bigint, liveUntil: Date, ref: ChargeRef | null): Promise<boolean>;

  // Shared files (routes/spaces.ts files/share, routes/spaceFiles.ts).
  fileShare(spaceId: string, path: string): Promise<FileShareRecord | null>;
  /** The paths of the space's shared files. */
  sharedPaths(spaceId: string): Promise<Set<string>>;
  /** Shares `path`, or leaves an existing share (and who made it) as it is. */
  addFileShare(spaceId: string, path: string, sharedById: string): Promise<FileShareRecord>;
  /** Unshares `path`, or with `prefix` every file under that folder; returns how many. */
  removeFileShares(spaceId: string, target: { path: string } | { prefix: string }): Promise<number>;

  recordEvent(event: SpaceEventInput): Promise<void>;
  events(spaceId: string, opts: { limit: number; before?: Date | null }): Promise<SpaceEventRecord[]>;
  /**
   * File events touching `.termag/` (spaceMemory.ts MEMORY_ACTIONS whose path
   * names it), newest first, at or after `since`.
   */
  memoryEvents(spaceId: string, opts: { since: Date; limit: number }): Promise<SpaceEventRecord[]>;
  /** When the newest `file.put` event for this path was recorded, if any. */
  lastPutAt(spaceId: string, path: string): Promise<Date | null>;
  /** The newest write of this path (file.put or file.put.signed), for a conflict's "by <who> at <when>". */
  lastWrite(spaceId: string, path: string): Promise<SpaceEventRecord | null>;

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
  /** Events before `before`, except `.termag/` ones (spaceMemory.ts memoryPathWhere), which are kept indefinitely. */
  pruneEvents(before: Date): Promise<number>;
  /** Run after recordListings, so a terminated box's projects stay listed. */
  pruneTerminatedGrants(): Promise<number>;
}
