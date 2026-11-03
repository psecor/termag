import { describe, expect, it, vi } from 'vitest';
import { marksNewBoxForDotfiles, personalizeNewBox, type PersonalizeDeps } from './newBoxDotfiles';

const owner = { displayName: 'Ada Lovelace', googleEmail: 'ada@example.com', dotfilesRepoUrl: 'https://github.com/ada/dotfiles' };

function fakes(row: Record<string, unknown>, opts: { readyAfter?: number; ack?: Record<string, unknown> | Error; statusAfter?: number; owner?: typeof owner | null } = {}) {
  let statusReads = 0;
  let fileReads = 0;
  const updates: Array<{ where: unknown; data: unknown }> = [];
  const sends: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const prisma = {
    instance: {
      findUnique: vi.fn(async ({ select }: { select: Record<string, boolean> }) => {
        if (select.status) { statusReads++; return { status: statusReads > (opts.readyAfter ?? 0) ? 'ready' : 'provisioning' }; }
        return row;
      }),
      updateMany: vi.fn(async (q: { where: unknown; data: unknown }) => { updates.push(q); return { count: 1 }; }),
    },
    user: { findUnique: vi.fn(async () => (opts.owner === undefined ? owner : opts.owner)) },
  };
  const send = vi.fn(async (_id: string, type: string, payload: Record<string, unknown>) => {
    sends.push({ type, payload });
    if (type === 'box-claim') {
      if (opts.ack instanceof Error) throw opts.ack;
      return opts.ack ?? { ok: true, reportsOnClaim: true };
    }
    fileReads++;
    return { ok: true, content: fileReads > (opts.statusAfter ?? 0) ? '{"state":"running"}' : null };
  });
  const deps = { prisma, send, sleep: async () => {}, waitMs: 2_000 } as unknown as PersonalizeDeps;
  return { deps, updates, sends };
}

const marked = { kind: 'ec2', claimedAt: null, onClaimStatus: 'pending', userId: 'u1' };

describe('which new boxes get their owner\'s dotfiles', () => {
  it('only a managed box, with a repository, under the flag', () => {
    expect(marksNewBoxForDotfiles({ kind: 'ec2', dotfilesRepoUrl: owner.dotfilesRepoUrl, flagOn: true })).toBe(true);
    expect(marksNewBoxForDotfiles({ kind: 'ec2', dotfilesRepoUrl: owner.dotfilesRepoUrl, flagOn: false })).toBe(false);
    expect(marksNewBoxForDotfiles({ kind: 'ec2', dotfilesRepoUrl: null, flagOn: true })).toBe(false);
    expect(marksNewBoxForDotfiles({ kind: 'external', dotfilesRepoUrl: owner.dotfilesRepoUrl, flagOn: true })).toBe(false);
  });
});

describe('applying dotfiles on a new box\'s first hello', () => {
  it('waits for the row to be ready, sends the claim\'s payload, marks it running and waits for the run to start', async () => {
    const { deps, updates, sends } = fakes(marked, { readyAfter: 2, statusAfter: 1 });
    await personalizeNewBox('i1', '/home/ada', deps);
    expect(sends[0]).toEqual({ type: 'box-claim', payload: { ownerName: 'Ada Lovelace', ownerEmail: 'ada@example.com', dotfilesRepoUrl: owner.dotfilesRepoUrl } });
    expect(updates).toEqual([{ where: { id: 'i1', onClaimStatus: 'pending', claimedAt: null }, data: { onClaimStatus: 'running' } }]);
    expect(sends.filter(s => s.type === 'read-file').map(s => s.payload.path)).toEqual(['/home/ada/.termag/on-claim.status.json', '/home/ada/.termag/on-claim.status.json']);
  });

  it('does nothing for a box that is not marked, was claimed, or is self-managed', async () => {
    for (const row of [{ ...marked, onClaimStatus: null }, { ...marked, claimedAt: new Date() }, { ...marked, kind: 'external' }]) {
      const { deps, sends, updates } = fakes(row);
      await personalizeNewBox('i1', '/home/ada', deps);
      expect(sends).toEqual([]);
      expect(updates).toEqual([]);
    }
  });

  it('leaves the mark for the next hello when the row never reads ready', async () => {
    const { deps, sends, updates } = fakes(marked, { readyAfter: 1_000 });
    await personalizeNewBox('i1', '/home/ada', deps);
    expect(sends).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('settles it skipped, with why, when the box refuses or cannot be reached', async () => {
    const { deps, updates } = fakes(marked, { ack: new Error('Instance agent not connected') });
    await personalizeNewBox('i1', '/home/ada', deps);
    expect(updates).toEqual([{ where: { id: 'i1', onClaimStatus: 'pending', claimedAt: null }, data: { onClaimStatus: 'skipped', onClaimError: 'Dotfiles could not start: Instance agent not connected' } }]);
  });

  it('settles it skipped when the agent will not report on the run', async () => {
    const { deps, updates } = fakes(marked, { ack: { ok: true } });
    await personalizeNewBox('i1', '/home/ada', deps);
    expect(updates).toEqual([{ where: { id: 'i1', onClaimStatus: 'pending', claimedAt: null }, data: { onClaimStatus: 'skipped', onClaimError: null } }]);
  });

  it('settles it skipped when the owner has since cleared their repository', async () => {
    const { deps, updates, sends } = fakes(marked, { owner: { ...owner, dotfilesRepoUrl: null } as never });
    await personalizeNewBox('i1', '/home/ada', deps);
    expect(sends).toEqual([]);
    expect(updates[0]?.data).toEqual({ onClaimStatus: 'skipped', onClaimError: null });
  });

  it('never throws', async () => {
    const { deps } = fakes(marked);
    (deps.prisma.instance.findUnique as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('db down'));
    await expect(personalizeNewBox('i1', '/home/ada', deps)).resolves.toBeUndefined();
  });
});
