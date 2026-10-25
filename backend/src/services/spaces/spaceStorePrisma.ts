import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db';
import { isSpaceRole, type SpaceRole } from './spaceAccess';
import {
  LastOwnerError,
  SpaceNameTakenError,
  type AddMemberResult,
  type SpaceBoxInfo,
  type SpaceRecord,
  type SpaceStore,
  type SpaceUser,
} from './spaceStore';
import { findUserByEmail } from '../userByEmail';

/**
 * Runs a membership change with the space row locked, then refuses (rolling
 * back) if it took the space's last owner away, so two owners stepping down
 * at once can't both pass a check made before either wrote. A space already
 * ownerless (its owner's account is gone) is left alone, so members can leave.
 */
async function withOwnerGuard<T>(spaceId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM spaces WHERE id = ${spaceId} FOR UPDATE`;
    const owners = () => tx.spaceMember.count({ where: { spaceId, role: 'owner' } });
    const before = await owners();
    const out = await fn(tx);
    if (before > 0 && await owners() === 0) throw new LastOwnerError();
    return out;
  });
}

function role(value: string): SpaceRole {
  return isSpaceRole(value) ? value : 'viewer';
}

const boxSelect = {
  id: true, userId: true, status: true, name: true, kind: true, parentInstanceId: true,
  user: { select: { googleEmail: true } },
} as const;

type BoxRow = Prisma.InstanceGetPayload<{ select: typeof boxSelect }>;

function boxInfo(row: BoxRow): SpaceBoxInfo {
  return { id: row.id, userId: row.userId, status: row.status, parentInstanceId: row.parentInstanceId, name: row.name, kind: row.kind, ownerEmail: row.user?.googleEmail ?? null };
}

const userSelect = { id: true, googleEmail: true, displayName: true, unixUsername: true } as const;

function spaceUser(u: { id: string; googleEmail: string; displayName: string; unixUsername: string }): SpaceUser {
  return { id: u.id, email: u.googleEmail, displayName: u.displayName, unixUsername: u.unixUsername };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

export const prismaSpaceStore: SpaceStore = {
  async ldUser(userId) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true },
    });
  },

  async claimInvites(userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { googleEmail: true } });
    if (!user) return 0;
    const email = user.googleEmail.toLowerCase();
    const pending = await prisma.spaceInvite.findMany({ where: { email } });
    if (pending.length === 0) return 0;
    return prisma.$transaction(async tx => {
      let claimed = 0;
      for (const inv of pending) {
        // Deleting first means an invite revoked (or claimed) since the read above grants nothing.
        if ((await tx.spaceInvite.deleteMany({ where: { id: inv.id } })).count === 0) continue;
        await tx.spaceMember.upsert({
          where: { spaceId_userId: { spaceId: inv.spaceId, userId } },
          create: { spaceId: inv.spaceId, userId, role: inv.role, addedById: inv.addedById },
          update: {},
        });
        await tx.spaceEvent.create({ data: { spaceId: inv.spaceId, actorUserId: userId, action: 'invite.claim' } });
        claimed++;
      }
      return claimed;
    });
  },

  async spacesOfUser(userId) {
    const rows = await prisma.spaceMember.findMany({
      where: { userId, space: { deletedAt: null } },
      include: { space: true },
      orderBy: { space: { name: 'asc' } },
    });
    return rows.map(r => ({ space: r.space, role: role(r.role) }));
  },

  async spacesGrantedTo(instanceIds) {
    if (instanceIds.length === 0) return [];
    const rows = await prisma.spaceBox.findMany({
      where: { instanceId: { in: instanceIds }, space: { deletedAt: null } },
      include: { space: true },
    });
    return rows.map(r => ({ space: r.space, instanceId: r.instanceId }));
  },

  async findSpace(idOrName) {
    return prisma.space.findFirst({ where: { OR: [{ id: idOrName }, { name: idOrName }], deletedAt: null } });
  },

  async memberRoles(spaceId) {
    const rows = await prisma.spaceMember.findMany({ where: { spaceId }, select: { userId: true, role: true } });
    return new Map(rows.map(r => [r.userId, role(r.role)]));
  },

  async grantedBoxIds(spaceId) {
    const rows = await prisma.spaceBox.findMany({ where: { spaceId }, select: { instanceId: true } });
    return new Set(rows.map(r => r.instanceId));
  },

  async box(instanceId) {
    const row = await prisma.instance.findUnique({ where: { id: instanceId }, select: boxSelect });
    return row ? boxInfo(row) : null;
  },

  async boxesOwnedBy(userId) {
    const rows = await prisma.instance.findMany({
      where: { userId, status: { not: 'terminated' } },
      select: boxSelect,
      orderBy: { name: 'asc' },
    });
    return rows.map(boxInfo);
  },

  async createSpace({ name, description, userId }) {
    try {
      return await prisma.$transaction(async tx => {
        const space = await tx.space.create({ data: { name, description, createdById: userId } });
        await tx.spaceMember.create({ data: { spaceId: space.id, userId, role: 'owner', addedById: userId } });
        await tx.spaceEvent.create({ data: { spaceId: space.id, actorUserId: userId, action: 'space.create' } });
        return space;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new SpaceNameTakenError(`A space named ${name} already exists`);
      throw err;
    }
  },

  async updateSpace(spaceId, patch) {
    try {
      return await prisma.space.update({ where: { id: spaceId }, data: patch });
    } catch (err) {
      if (isUniqueViolation(err)) throw new SpaceNameTakenError(`A space named ${patch.name} already exists`);
      throw err;
    }
  },

  async markDeleted(spaceId) {
    await prisma.space.update({ where: { id: spaceId }, data: { deletedAt: new Date(), name: `deleted:${spaceId}` } });
  },

  async members(spaceId) {
    const rows = await prisma.spaceMember.findMany({
      where: { spaceId },
      include: { user: { select: userSelect } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(r => ({ userId: r.userId, role: role(r.role), user: spaceUser(r.user), createdAt: r.createdAt }));
  },

  async invites(spaceId) {
    const rows = await prisma.spaceInvite.findMany({ where: { spaceId }, orderBy: { createdAt: 'asc' } });
    return rows.map(r => ({ id: r.id, email: r.email, role: role(r.role), createdAt: r.createdAt }));
  },

  async userByEmail(email) {
    const u = await findUserByEmail(email.trim());
    return u ? spaceUser(u) : null;
  },

  async addMember({ spaceId, email, role: r, addedById }): Promise<AddMemberResult> {
    const normalized = email.trim().toLowerCase();
    const user = await findUserByEmail(normalized);
    if (user) {
      const row = await withOwnerGuard(spaceId, async tx => {
        const member = await tx.spaceMember.upsert({
          where: { spaceId_userId: { spaceId, userId: user.id } },
          create: { spaceId, userId: user.id, role: r, addedById },
          update: { role: r },
        });
        await tx.spaceInvite.deleteMany({ where: { spaceId, email: normalized } });
        return member;
      });
      return { kind: 'member', member: { userId: user.id, role: role(row.role), user: spaceUser(user), createdAt: row.createdAt } };
    }
    const inv = await prisma.spaceInvite.upsert({
      where: { spaceId_email: { spaceId, email: normalized } },
      create: { spaceId, email: normalized, role: r, addedById },
      update: { role: r },
    });
    return { kind: 'invite', invite: { id: inv.id, email: inv.email, role: role(inv.role), createdAt: inv.createdAt } };
  },

  async setMemberRole(spaceId, userId, r) {
    await withOwnerGuard(spaceId, tx => tx.spaceMember.update({ where: { spaceId_userId: { spaceId, userId } }, data: { role: r } }));
  },

  async removeMember(spaceId, userId) {
    return withOwnerGuard(spaceId, async tx => {
      const boxes = await tx.spaceBox.deleteMany({ where: { spaceId, instance: { userId } } });
      await tx.spaceMember.delete({ where: { spaceId_userId: { spaceId, userId } } });
      return { removedBoxes: boxes.count };
    });
  },

  async removeInvite(spaceId, inviteId) {
    return (await prisma.spaceInvite.deleteMany({ where: { id: inviteId, spaceId } })).count > 0;
  },

  async grants(spaceId) {
    const rows = await prisma.spaceBox.findMany({
      where: { spaceId },
      include: { instance: { select: boxSelect } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(r => ({ instanceId: r.instanceId, box: boxInfo(r.instance), addedById: r.addedById, createdAt: r.createdAt }));
  },

  async addGrant(spaceId, instanceId, addedById) {
    await prisma.spaceBox.upsert({
      where: { spaceId_instanceId: { spaceId, instanceId } },
      create: { spaceId, instanceId, addedById },
      update: {},
    });
  },

  async removeGrant(spaceId, instanceId) {
    return (await prisma.spaceBox.deleteMany({ where: { spaceId, instanceId } })).count > 0;
  },

  async chargeBytes(spaceId, bytes, liveUntil, ref) {
    const n = await prisma.$executeRaw`
      WITH charged AS (
        UPDATE spaces SET "usedBytes" = "usedBytes" + ${bytes}
        WHERE id = ${spaceId} AND "usedBytes" + ${bytes} <= "quotaBytes"
        RETURNING id
      )
      INSERT INTO space_charges (id, "spaceId", bytes, "liveUntil", key, "uploadId", "partNumbers")
      SELECT ${randomUUID()}, id, ${bytes}, ${liveUntil}, ${ref?.key ?? null}, ${ref?.uploadId ?? null}, ${ref?.partNumbers ?? []}::integer[] FROM charged`;
    return n > 0;
  },

  async recordEvent(e) {
    await prisma.spaceEvent.create({
      data: {
        spaceId: e.spaceId, actorUserId: e.actorUserId, actorInstanceId: e.actorInstanceId ?? null,
        via: e.via ?? null, action: e.action, path: e.path ?? null,
        bytes: e.bytes === null || e.bytes === undefined ? null : BigInt(e.bytes),
      },
    });
  },

  async lastPutAt(spaceId, path) {
    const row = await prisma.spaceEvent.findFirst({ where: { spaceId, action: 'file.put', path }, orderBy: { at: 'desc' }, select: { at: true } });
    return row?.at ?? null;
  },

  async events(spaceId, { limit, before }) {
    return prisma.spaceEvent.findMany({
      where: { spaceId, ...(before ? { at: { lt: before } } : {}) },
      orderBy: { at: 'desc' },
      take: limit,
    });
  },

  async deletedSpaces() {
    return prisma.space.findMany({ where: { deletedAt: { not: null } } });
  },

  async liveSpaces() {
    return prisma.space.findMany({ where: { deletedAt: null } });
  },

  async chargesLiveAfter(spaceId, after) {
    return prisma.spaceCharge.findMany({
      where: { spaceId, liveUntil: { gt: after } },
      select: { id: true, bytes: true, createdAt: true, liveUntil: true, key: true, uploadId: true, partNumbers: true },
    });
  },

  async recountUsedBytes(spaceId, stored, now, settled) {
    await prisma.$executeRaw`
      UPDATE spaces SET "usedBytes" = ${stored} + COALESCE(
        (SELECT SUM(bytes) FROM space_charges
         WHERE "spaceId" = ${spaceId} AND "liveUntil" > ${now} AND NOT (id = ANY(${settled}::text[]))), 0)
      WHERE id = ${spaceId}`;
  },

  async pruneCharges(before) {
    return (await prisma.spaceCharge.deleteMany({ where: { liveUntil: { lt: before } } })).count;
  },

  async deleteSpaceRow(spaceId) {
    await prisma.space.delete({ where: { id: spaceId } });
  },

  async pruneEvents(before) {
    return (await prisma.spaceEvent.deleteMany({ where: { at: { lt: before } } })).count;
  },

  async pruneTerminatedGrants() {
    return (await prisma.spaceBox.deleteMany({ where: { instance: { status: 'terminated' } } })).count;
  },
};
