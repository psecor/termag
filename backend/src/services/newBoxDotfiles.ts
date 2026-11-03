// Dotfiles on a newly launched box, under onboarding-refresh-enabled.
//
// A box claimed from the warm pool gets its owner's dotfiles from the claim's
// `box-claim` RPC (services/warmPoolClaim.ts), which sets the git identity and
// starts termag-on-claim.service. A box launched for its owner never goes
// through a claim, so it got none. createBox marks such a box
// `onClaimStatus: 'pending'` (claimedAt stays null, which keeps the warm
// pool's re-send away), and its agent's first hello sends the same
// `box-claim`: after credential delivery, so a private repository can clone
// through the GitHub broker, and before the hello settles, so a clone waits for
// the run as it does on a claimed box (agent/project-clone.js waits for the
// on-claim status to settle). The agent handles `box-claim` the same on any
// box; nothing in it is specific to the pool. Only managed (ec2) boxes, never
// a self-managed host, where it would run the owner's installer on their own
// machine.
import type { PrismaClient } from '@prisma/client';
import { boxClaimPayload, claimAwaitsOnClaimReport } from './warmPoolClaim';

export const NEW_BOX_DOTFILES_FLAG = 'onboarding-refresh-enabled';

/** Whether createBox should mark a box for dotfiles on its first hello. */
export function marksNewBoxForDotfiles(i: { kind: string; dotfilesRepoUrl: string | null; flagOn: boolean }): boolean {
  return i.flagOn && i.kind === 'ec2' && Boolean(i.dotfilesRepoUrl);
}

type Send = (instanceId: string, type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown> | null | undefined>;

export interface PersonalizeDeps {
  prisma: Pick<PrismaClient, 'instance' | 'user'>;
  send: Send;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the row to read `ready`, and then for the run to start. */
  waitMs?: number;
}

const POLL_MS = 500;

/**
 * Applies the owner's dotfiles to a box launched for them, once: only while
 * the row is still marked `pending` and was never claimed. Never throws, and
 * returns within about twice `waitMs` plus the RPC's own timeout, since the
 * hello's `settled` (and so clones and asks) waits on it.
 */
export async function personalizeNewBox(instanceId: string, home: string, deps: PersonalizeDeps): Promise<void> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const waitMs = deps.waitMs ?? 15_000;
  try {
    const row = await deps.prisma.instance.findUnique({
      where: { id: instanceId },
      select: { kind: true, claimedAt: true, onClaimStatus: true, userId: true },
    });
    if (!row || row.kind !== 'ec2' || row.claimedAt || row.onClaimStatus !== 'pending' || !row.userId) return;
    const owner = await deps.prisma.user.findUnique({
      where: { id: row.userId },
      select: { displayName: true, googleEmail: true, dotfilesRepoUrl: true },
    });
    if (!owner?.dotfilesRepoUrl) { await settle(deps, instanceId, null); return; }

    // The agent's on-claim status reports only land on a `ready` row
    // (services/onClaimStatus.ts), and a new box flips to ready just after it
    // connects. Start the run once it has, so a quick run's last report is kept.
    for (let waited = 0; ; waited += POLL_MS) {
      const now = await deps.prisma.instance.findUnique({ where: { id: instanceId }, select: { status: true } });
      if (now?.status === 'ready') break;
      if (waited >= waitMs) return; // the next hello tries again; the row stays pending
      await sleep(POLL_MS);
    }

    let ack: Record<string, unknown> | null | undefined;
    try {
      ack = await deps.send(instanceId, 'box-claim', boxClaimPayload(owner));
    } catch (err) {
      await settle(deps, instanceId, `Dotfiles could not start: ${(err as Error).message}`);
      return;
    }
    if (!ack || ack.ok !== true) {
      await settle(deps, instanceId, 'Dotfiles could not start: the box did not acknowledge them');
      return;
    }
    if (!claimAwaitsOnClaimReport(owner, { reportsOnClaim: ack.reportsOnClaim === true })) {
      await settle(deps, instanceId, null);
      return;
    }
    // Started: off `pending`, so a reconnect never sends `box-claim` again,
    // which would set the git identity again, through a ~/.gitconfig the
    // dotfiles may have linked. The run's own reports take it from here (and a
    // new socket re-sends the latest).
    await deps.prisma.instance.updateMany({
      where: { id: instanceId, onClaimStatus: 'pending', claimedAt: null },
      data: { onClaimStatus: 'running' },
    });
    console.log(`[DOTFILES] instance ${instanceId}: applying the owner's dotfiles to a new box`);

    // `box-claim` starts the unit without waiting for it, and a clone that
    // polls before the run writes its first status reads "settled". Wait for
    // that first status, briefly.
    const statusPath = `${home}/.termag/on-claim.status.json`;
    for (let waited = 0; waited < waitMs; waited += POLL_MS) {
      const read = await deps.send(instanceId, 'read-file', { path: statusPath }).catch(() => null);
      if (read && typeof read.content === 'string') return;
      await sleep(POLL_MS);
    }
  } catch (err) {
    console.error(`[DOTFILES] instance ${instanceId}: could not apply dotfiles to the new box:`, (err as Error).message);
  }
}

/** Takes the mark off when there is nothing to wait for: `skipped`, with the reason when there is one. */
async function settle(deps: PersonalizeDeps, instanceId: string, error: string | null): Promise<void> {
  await deps.prisma.instance.updateMany({
    where: { id: instanceId, onClaimStatus: 'pending', claimedAt: null },
    data: { onClaimStatus: 'skipped', onClaimError: error },
  });
}
