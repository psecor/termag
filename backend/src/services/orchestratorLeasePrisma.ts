import { prisma } from '../db';
import { LEASE_ID, type LeaseStore } from './orchestratorLease';

export const prismaLeaseStore: LeaseStore = {
  async claim(holderId, label, now, startedAt) {
    const data = { holderId, holderLabel: label, claimedAt: startedAt, heartbeatAt: now };
    await prisma.orchestratorLease.upsert({ where: { id: LEASE_ID }, create: { id: LEASE_ID, ...data }, update: data });
  },

  async heartbeat(holderId, now) {
    const { count } = await prisma.orchestratorLease.updateMany({
      where: { id: LEASE_ID, holderId },
      data: { heartbeatAt: now },
    });
    return count > 0;
  },

  async claimIfOlder(holderId, label, now, startedAt) {
    // A few rounds, because another process can create or take the row
    // between any two of these statements; each round re-applies the age rule.
    for (let round = 0; round < 3; round++) {
      const { count } = await prisma.orchestratorLease.updateMany({
        where: { id: LEASE_ID, claimedAt: { lt: startedAt } },
        data: { holderId, holderLabel: label, claimedAt: startedAt, heartbeatAt: now },
      });
      if (count > 0) return true;
      const row = await prisma.orchestratorLease.findUnique({
        where: { id: LEASE_ID }, select: { holderId: true, claimedAt: true },
      });
      if (row) {
        if (row.holderId === holderId) return true;
        // Held by a process that started later: it keeps the lease.
        if (row.claimedAt >= startedAt) return false;
        // An older process created the row after the update above ran: go
        // round again and take it.
        continue;
      }
      const created = await prisma.orchestratorLease.createMany({
        data: [{ id: LEASE_ID, holderId, holderLabel: label, claimedAt: startedAt, heartbeatAt: now }],
        skipDuplicates: true,
      });
      if (created.count > 0) return true;
    }
    return false;
  },

  async reclaimIfStale(holderId, label, now, staleBefore, startedAt) {
    const { count } = await prisma.orchestratorLease.updateMany({
      where: { id: LEASE_ID, heartbeatAt: { lt: staleBefore } },
      data: { holderId, holderLabel: label, claimedAt: startedAt, heartbeatAt: now },
    });
    if (count > 0) return true;
    // Nobody holds it at all (the row was deleted by hand).
    const row = await prisma.orchestratorLease.findUnique({ where: { id: LEASE_ID }, select: { id: true } });
    if (row) return false;
    const created = await prisma.orchestratorLease.createMany({
      data: [{ id: LEASE_ID, holderId, holderLabel: label, claimedAt: startedAt, heartbeatAt: now }],
      skipDuplicates: true,
    });
    return created.count > 0;
  },
};
