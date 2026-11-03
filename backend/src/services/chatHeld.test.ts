/**
 * Held messages (chatHeld.ts): a message sent while the chat comes up on its
 * new box goes in after the restore, oldest first, once; a refusal keeps it
 * with its error and the next one goes on; a claim another process holds is
 * left alone, and a stale one is taken over.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  type Row = { id: string; projectId: string; workstreamId: string; senderId: string; text: string; model: string | null; backend: string | null; effort: string | null; claimedAt: Date | null; error: string | null; createdAt: Date };
  const state = { rows: [] as Row[], n: 0 };
  const match = (r: Row, w: Record<string, unknown>) => (w.id === undefined || r.id === w.id)
    && (w.workstreamId === undefined || r.workstreamId === w.workstreamId)
    && (w.error === undefined || r.error === w.error)
    && (w.OR === undefined || (w.OR as Array<{ claimedAt: null | { lt: Date } }>).some(o => (o.claimedAt === null ? r.claimedAt === null : r.claimedAt != null && r.claimedAt < o.claimedAt.lt)));
  const prisma = {
    chatHeldMessage: {
      count: async ({ where }: { where: Record<string, unknown> }) => state.rows.filter(r => match(r, where)).length,
      create: async ({ data }: { data: Partial<Row> }) => {
        const row = { id: `m${++state.n}`, model: null, backend: null, effort: null, claimedAt: null, error: null, createdAt: new Date(Date.UTC(2026, 9, 27, 12, 0, state.n)), ...data } as Row;
        state.rows.push(row);
        return { id: row.id };
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => state.rows.filter(r => match(r, where)).sort((a, b) => +a.createdAt - +b.createdAt)[0] ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => state.rows.filter(r => match(r, where)).sort((a, b) => +a.createdAt - +b.createdAt),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = state.rows.filter(r => match(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const before = state.rows.length;
        state.rows = state.rows.filter(r => !match(r, where));
        return { count: before - state.rows.length };
      },
    },
  };
  return { prisma, state };
});
vi.mock('../db', () => ({ prisma: db.prisma }));

import { deliverHeld, HELD_CLAIM_STALE_MS, HELD_MAX, heldFor, holdMessage, type DeliverOutcome, type HeldMessage } from './chatHeld';

const k = { projectId: 'p1', workstreamId: 'ws1', senderId: 'owner' };

beforeEach(() => { db.state.rows = []; db.state.n = 0; });

describe('held messages', () => {
  it('go in after the restore, oldest first, each once', async () => {
    await holdMessage(k, { text: 'first' });
    await holdMessage(k, { text: 'second' });
    let restored = false;
    const got: string[] = [];
    const send = async (m: HeldMessage): Promise<DeliverOutcome> => {
      if (!restored) return { kind: 'not-ready' };
      got.push(m.text);
      return { kind: 'sent' };
    };
    expect(await deliverHeld('ws1', send)).toBe(0);
    expect((await heldFor('ws1')).map(m => m.text)).toEqual(['first', 'second']);
    expect(db.state.rows.every(r => r.claimedAt === null)).toBe(true);
    restored = true;
    expect(await deliverHeld('ws1', send)).toBe(2);
    expect(got).toEqual(['first', 'second']);
    expect(await heldFor('ws1')).toEqual([]);
    expect(await deliverHeld('ws1', send)).toBe(0);
    expect(got).toEqual(['first', 'second']);
  });

  it('a message the chat refuses for good stays with its error, and the next goes on', async () => {
    await holdMessage(k, { text: 'bad model' });
    await holdMessage(k, { text: 'fine' });
    const send = async (m: HeldMessage): Promise<DeliverOutcome> => (m.text === 'bad model' ? { kind: 'refused', error: 'unknown model' } : { kind: 'sent' });
    expect(await deliverHeld('ws1', send)).toBe(1);
    expect(await heldFor('ws1')).toMatchObject([{ id: 'm1', text: 'bad model', error: 'unknown model' }]);
  });

  it('a live claim (another process) is left alone; a stale one is taken over', async () => {
    await holdMessage(k, { text: 'one' });
    db.state.rows[0].claimedAt = new Date();
    const send = vi.fn(async (): Promise<DeliverOutcome> => ({ kind: 'sent' }));
    expect(await deliverHeld('ws1', send)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    db.state.rows[0].claimedAt = new Date(Date.now() - HELD_CLAIM_STALE_MS - 1000);
    expect(await deliverHeld('ws1', send)).toBe(1);
  });

  it('a chat holds at most HELD_MAX', async () => {
    for (let i = 0; i < HELD_MAX; i++) expect(await holdMessage(k, { text: `m${i}` })).not.toBeNull();
    expect(await holdMessage(k, { text: 'one too many' })).toBeNull();
  });
});
