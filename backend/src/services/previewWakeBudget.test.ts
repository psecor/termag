// The owner's guest wake budget is one for preview shares and links (PRD U4; SR20, "shared with preview
// shares, not added to it"): claimGuestWake counts the last day's wakes of both, under one lock.
import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ shareWakes: [] as Date[], linkWakes: [] as Date[], locks: [] as string[], recorded: 0 }));
vi.mock('../db', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $executeRaw: async (strings: TemplateStringsArray, ...v: unknown[]) => { db.locks.push(String(v[0])); return 1; },
      previewShareEvent: { findMany: async () => db.shareWakes.map(at => ({ at })) },
      previewAudienceEvent: { findMany: async () => db.linkWakes.map(at => ({ at })) },
    }),
  },
}));
const { claimGuestWake } = await import('./previewShares');

const NOW = Date.parse('2026-11-09T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000);
const claim = () => claimGuestWake('owner', NOW, async () => { db.recorded++; return `w${db.recorded}`; });

describe('the guest wake budget, shared by shares and links', () => {
  it('a link\'s wake ten minutes ago makes a share\'s wait (30 minutes apart), and the reverse', async () => {
    db.shareWakes = []; db.linkWakes = [ago(10)]; db.recorded = 0;
    expect(await claim()).toMatchObject({ ok: false, reason: 'too-soon' });
    db.shareWakes = [ago(10)]; db.linkWakes = [];
    expect(await claim()).toMatchObject({ ok: false, reason: 'too-soon' });
    expect(db.recorded).toBe(0);
  });

  it('six wakes a day across both, not six each', async () => {
    db.shareWakes = [ago(600), ago(500), ago(400)]; db.linkWakes = [ago(300), ago(200), ago(100)]; db.recorded = 0;
    expect(await claim()).toMatchObject({ ok: false, reason: 'daily' });
    db.linkWakes = [ago(300), ago(200)];
    expect(await claim()).toEqual({ ok: true, wakeId: 'w1' });
  });

  it('takes the owner\'s one lock, whichever kind is claiming', async () => {
    db.locks = []; db.shareWakes = []; db.linkWakes = [];
    await claim();
    expect(db.locks).toEqual(['preview-wake:owner']);
  });
});
