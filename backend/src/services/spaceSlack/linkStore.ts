/**
 * What the link service (link.ts) and the first-link enable (enable.ts) read
 * and write in Postgres: the `space_slack` and `space_channels` rows,
 * as an interface so the services can be
 * tested with an in-memory store (spaceSlackTestkit.ts).
 *
 * `SpaceChannel.channelId` is the primary key and an unlinked row stays (its
 * `unlinkedAt` set), so a channel is linked at most once at a time: `claimChannel`
 * is the only write that links, and two concurrent claims can't both win.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';

export interface SpaceSlackRow {
  id: string;
  spaceId: string;
  enabledById: string;
  runnerUserId: string;
  projectId: string | null;
  instanceId: string | null;
  status: string;
  limits: unknown;
  disabledAt: Date | null;
}

export interface SpaceChannelRow {
  channelId: string;
  teamId: string;
  spaceSlackId: string;
  name: string;
  isPrivate: boolean;
  createdByTermag: boolean;
  linkedById: string;
  linkedVia: string;
  linkedAt: Date;
  confirmTs: string | null;
  pausedAt: Date | null;
  unlinkedAt: Date | null;
  unlinkReason: string | null;
}

export interface NewChannelLink {
  channelId: string;
  teamId: string;
  spaceSlackId: string;
  name: string;
  isPrivate: boolean;
  createdByTermag: boolean;
  linkedById: string;
  linkedVia: string;
}

export interface SpaceSlackStore {
  spaceSlack(spaceId: string): Promise<SpaceSlackRow | null>;
  spaceSlackById(id: string): Promise<SpaceSlackRow | null>;
  /**
   * Creates the space's SpaceSlack, or re-enables a disabled one with this
   * runner. `created` is false when another enable got there first (the
   * existing row is returned, unchanged).
   */
  enableSpaceSlack(input: { spaceId: string; enabledById: string; runnerUserId: string; instanceId: string | null }):
    Promise<{ row: SpaceSlackRow; created: boolean }>;
  /**
   * Undoes an activation that linked nothing: deletes the SpaceSlack only if it
   * has never had a channel. False (and nothing changes) otherwise.
   */
  releaseSpaceSlack(id: string): Promise<boolean>;
  /** The channel's row, linked or not. */
  channel(channelId: string): Promise<SpaceChannelRow | null>;
  /** Linked (not unlinked) channels of a SpaceSlack. */
  activeChannelCount(spaceSlackId: string): Promise<number>;
  /**
   * Links the channel: inserts its row, or reclaims an unlinked one. Returns
   * null when the channel is already linked (to any space), whoever won.
   */
  claimChannel(link: NewChannelLink): Promise<SpaceChannelRow | null>;
  /** Sets unlinkedAt and the reason on a linked channel; null when it wasn't linked. */
  markUnlinked(channelId: string, reason: string, at: Date): Promise<SpaceChannelRow | null>;
  setConfirmTs(channelId: string, ts: string): Promise<void>;
  /** userId → Slack user id, for those with one (users.slackUserId, set by slack/userMapping.ts). */
  slackIdsOf(userIds: string[]): Promise<Map<string, string>>;
}

const SPACE_SLACK_SELECT = {
  id: true, spaceId: true, enabledById: true, runnerUserId: true, projectId: true, instanceId: true,
  status: true, limits: true, disabledAt: true,
} as const;

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export const prismaSpaceSlackStore: SpaceSlackStore = {
  async spaceSlack(spaceId) {
    return prisma.spaceSlack.findUnique({ where: { spaceId }, select: SPACE_SLACK_SELECT });
  },

  async spaceSlackById(id) {
    return prisma.spaceSlack.findUnique({ where: { id }, select: SPACE_SLACK_SELECT });
  },

  async enableSpaceSlack({ spaceId, enabledById, runnerUserId, instanceId }) {
    try {
      const row = await prisma.spaceSlack.create({
        data: { spaceId, enabledById, runnerUserId, instanceId },
        select: SPACE_SLACK_SELECT,
      });
      return { row, created: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    // Re-enable a disabled one; a live one (another enable won) stays as it is.
    const revived = await prisma.spaceSlack.updateMany({
      where: { spaceId, disabledAt: { not: null } },
      data: { disabledAt: null, enabledById, runnerUserId, instanceId, status: 'active', suspendReason: null },
    });
    const row = await prisma.spaceSlack.findUniqueOrThrow({ where: { spaceId }, select: SPACE_SLACK_SELECT });
    return { row, created: revived.count === 1 };
  },

  async releaseSpaceSlack(id) {
    const done = await prisma.spaceSlack.deleteMany({ where: { id, channels: { none: {} } } });
    return done.count === 1;
  },

  async channel(channelId) {
    return prisma.spaceChannel.findUnique({ where: { channelId } });
  },

  async activeChannelCount(spaceSlackId) {
    return prisma.spaceChannel.count({ where: { spaceSlackId, unlinkedAt: null } });
  },

  async claimChannel(link) {
    try {
      return await prisma.spaceChannel.create({ data: link });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    // The row exists: reclaim it only if it is unlinked. Postgres re-checks the
    // WHERE after a concurrent update commits, so only one reclaim matches.
    const reclaimed = await prisma.spaceChannel.updateMany({
      where: { channelId: link.channelId, unlinkedAt: { not: null } },
      data: {
        ...link, linkedAt: new Date(), confirmTs: null, pausedAt: null, pauseReason: null,
        unlinkedAt: null, unlinkReason: null, lastCheckedAt: null,
      },
    });
    return reclaimed.count === 1 ? prisma.spaceChannel.findUnique({ where: { channelId: link.channelId } }) : null;
  },

  async markUnlinked(channelId, reason, at) {
    const done = await prisma.spaceChannel.updateMany({
      where: { channelId, unlinkedAt: null },
      data: { unlinkedAt: at, unlinkReason: reason },
    });
    return done.count === 1 ? prisma.spaceChannel.findUnique({ where: { channelId } }) : null;
  },

  async setConfirmTs(channelId, ts) {
    await prisma.spaceChannel.update({ where: { channelId }, data: { confirmTs: ts } });
  },

  async slackIdsOf(userIds) {
    if (!userIds.length) return new Map();
    const rows = await prisma.user.findMany({ where: { id: { in: userIds }, slackUserId: { not: null } }, select: { id: true, slackUserId: true } });
    return new Map(rows.map(r => [r.id, r.slackUserId!] as const));
  },
};
