/**
 * Messages held for a chat that can't take them yet:
 * a send to a chat whose box was terminated starts the new box, and a send
 * to one whose box is stopped starts that box. The message waits here, in
 * Postgres, and goes in once the chat can take it: oldest first, after the
 * session is restored, so it never starts an empty session and a closed tab
 * doesn't lose it. A send while others are held waits behind them.
 *
 * Delivery runs when a restore finishes (kickHeldDelivery), on a box's hello,
 * and on a short sweep. One process delivers a message: it claims the row
 * first (claimedAt, stale after HELD_CLAIM_STALE_MS, for a process that died
 * holding it). A chat still coming up gives the claim back for the next try;
 * one that refuses for good keeps the message with its error, for the person
 * to see, and the ones behind it go on.
 */

import { prisma } from '../db';

export const HELD_CLAIM_STALE_MS = 3 * 60_000;
const HELD_SWEEP_MS = 5000;
/** Held messages a chat keeps at most: a person typing into a box that won't come up. */
export const HELD_MAX = 20;

export interface HeldBody {
  text: string;
  model?: string | null;
  backend?: string | null;
  effort?: string | null;
}

export interface HeldMessage extends HeldBody {
  id: string;
  projectId: string;
  workstreamId: string;
  senderId: string;
  error: string | null;
}

/** What a delivery attempt did: sent, not yet (the chat is still coming up), or refused with why. */
export type DeliverOutcome = { kind: 'sent' } | { kind: 'not-ready' } | { kind: 'refused'; error: string };
export type HeldSender = (m: HeldMessage) => Promise<DeliverOutcome>;

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

/** Hold a message; null when the chat already holds HELD_MAX. */
export async function holdMessage(k: { projectId: string; workstreamId: string; senderId: string }, b: HeldBody): Promise<{ id: string; position: number } | null> {
  const waiting = await prisma.chatHeldMessage.count({ where: { workstreamId: k.workstreamId, error: null } });
  if (waiting >= HELD_MAX) return null;
  const row = await prisma.chatHeldMessage.create({
    data: { ...k, text: b.text, model: str(b.model), backend: str(b.backend), effort: str(b.effort) },
    select: { id: true },
  });
  return { id: row.id, position: waiting + 1 };
}

/** The chat's held messages, oldest first, for its view. */
export async function heldFor(workstreamId: string): Promise<Array<{ id: string; text: string; error: string | null }>> {
  return prisma.chatHeldMessage.findMany({
    where: { workstreamId }, orderBy: { createdAt: 'asc' }, select: { id: true, text: true, error: true },
  });
}

/** Whether a send to this chat must wait behind held messages. */
export async function hasHeld(workstreamId: string): Promise<boolean> {
  return (await prisma.chatHeldMessage.count({ where: { workstreamId, error: null } })) > 0;
}

/** Claim one message for this process; false when another holds a live claim, or it is gone. */
async function claim(id: string, now: Date): Promise<boolean> {
  const r = await prisma.chatHeldMessage.updateMany({
    where: { id, error: null, OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - HELD_CLAIM_STALE_MS) } }] },
    data: { claimedAt: now },
  });
  return r.count === 1;
}

// One delivery per chat at a time in this process; another process loses at claim().
const delivering = new Map<string, Promise<number>>();

/** Send the chat's held messages in order until one can't go yet. Resolves with how many went in. */
export function deliverHeld(workstreamId: string, send: HeldSender, now: () => Date = () => new Date()): Promise<number> {
  const running = delivering.get(workstreamId);
  if (running) return running;
  const run = (async () => {
    let sent = 0;
    for (;;) {
      const next = await prisma.chatHeldMessage.findFirst({ where: { workstreamId, error: null }, orderBy: { createdAt: 'asc' } });
      if (!next || !await claim(next.id, now())) return sent;
      let outcome: DeliverOutcome;
      try {
        outcome = await send(next);
      } catch (err) {
        outcome = { kind: 'not-ready' };
        console.error('[RESUME] held message %s: send failed, retried later: %s', next.id, err instanceof Error ? err.message : String(err));
      }
      if (outcome.kind === 'sent') {
        await prisma.chatHeldMessage.deleteMany({ where: { id: next.id } });
        sent += 1;
        continue;
      }
      if (outcome.kind === 'refused') {
        await prisma.chatHeldMessage.updateMany({ where: { id: next.id }, data: { claimedAt: null, error: outcome.error.slice(0, 500) } });
        continue;
      }
      await prisma.chatHeldMessage.updateMany({ where: { id: next.id }, data: { claimedAt: null } });
      return sent;
    }
  })().finally(() => delivering.delete(workstreamId));
  delivering.set(workstreamId, run);
  return run;
}

let sender: HeldSender | null = null;

/** Deliver this chat's held messages now (a restore finished, a box said hello). A no-op before startHeldDelivery. */
export function kickHeldDelivery(workstreamId: string): void {
  if (!sender) return;
  void deliverHeld(workstreamId, sender).catch(err => {
    console.error('[RESUME] held delivery for %s failed: %s', workstreamId, err instanceof Error ? err.message : String(err));
  });
}

/** Every chat on a box that holds messages; for the box's hello. */
export async function kickHeldDeliveryOnBox(instanceId: string): Promise<void> {
  const rows = await prisma.chatHeldMessage.findMany({
    where: { error: null, project: { instanceId } }, distinct: ['workstreamId'], select: { workstreamId: true },
  });
  for (const r of rows) kickHeldDelivery(r.workstreamId);
}

/** Deliver held messages with this sender: on a short sweep from now on. Returns the stop. */
export function startHeldDelivery(send: HeldSender, everyMs = HELD_SWEEP_MS): () => void {
  sender = send;
  const t = setInterval(() => {
    void prisma.chatHeldMessage.findMany({ where: { error: null }, distinct: ['workstreamId'], select: { workstreamId: true } })
      .then(rows => { for (const r of rows) kickHeldDelivery(r.workstreamId); })
      .catch(err => console.error('[RESUME] held sweep failed: %s', err instanceof Error ? err.message : String(err)));
  }, everyMs);
  t.unref?.();
  return () => { clearInterval(t); sender = null; };
}
