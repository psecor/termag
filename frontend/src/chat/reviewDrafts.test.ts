import { afterEach, describe, expect, it, vi } from 'vitest';
import { cardKey, latestCard, updateCard } from './reviewDrafts';
import type { ReviewFindings } from './reviewCard';

const findings = { round: 1, findings: [] } as unknown as ReviewFindings;

describe('the card store, across tabs', () => {
  it("keeps another tab's change when this one writes", () => {
    const kept = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } });
    try {
      updateCard('p|tabs|1', { decision: 'COMMENT' });
      // Another tab ticks a finding on a second card, straight into storage.
      const theirs = JSON.parse(kept.get('termag.reviews.cards')!);
      kept.set('termag.reviews.cards', JSON.stringify({ ...theirs, 'p|tabs|2': { findings: null, ticks: { f1: true }, decision: null, focus: null, posted: null } }));
      updateCard('p|tabs|1', { decision: 'APPROVE' });
      const now = JSON.parse(kept.get('termag.reviews.cards')!);
      expect(now['p|tabs|2'].ticks).toEqual({ f1: true });
      expect(now['p|tabs|1'].decision).toBe('APPROVE');
      // The same card: this tab's tick doesn't undo the other tab's.
      const after = JSON.parse(kept.get('termag.reviews.cards')!);
      kept.set('termag.reviews.cards', JSON.stringify({ ...after, 'p|tabs|2': { ...after['p|tabs|2'], ticks: { f1: true, f2: true } } }));
      updateCard('p|tabs|2', { ticks: { f3: false } });
      expect(JSON.parse(kept.get('termag.reviews.cards')!)['p|tabs|2'].ticks).toEqual({ f1: true, f2: true, f3: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("the card the side panel's Files changed works from", () => {
  afterEach(() => { vi.useRealTimers(); });

  it('keys a block by its text, not the space around it, so one that streams a newline after its JSON is one card', () => {
    expect(cardKey('p', 'w', 1, '{"kind":"findings"}\n')).toBe(cardKey('p', 'w', 1, ' {"kind":"findings"}'));
    expect(cardKey('p', 'w', 1, '{"kind":"findings"}')).not.toBe(cardKey('p', 'w', 1, '{"kind":"followup"}'));
  });

  it('is the later of two blocks drawn in the same moment', () => {
    vi.useFakeTimers({ now: 1_000 });
    const first = cardKey('p', 'tie', 1, 'one');
    const second = cardKey('p', 'tie', 1, 'two');
    updateCard(first, { findings, registeredAt: Date.now() });
    updateCard(second, { findings, registeredAt: Date.now() });
    expect(latestCard('p', 'tie')?.key).toBe(second);
  });

  it('is an older block once a finding in it is clicked or ticked, then the newer one once it is used', () => {
    vi.useFakeTimers({ now: 1_000 });
    const older = cardKey('p', 'used', 1, 'one');
    const newer = cardKey('p', 'used', 2, 'two');
    updateCard(older, { findings, registeredAt: Date.now() });
    vi.advanceTimersByTime(1_000);
    updateCard(newer, { findings, registeredAt: Date.now() });
    expect(latestCard('p', 'used')?.key).toBe(newer);
    vi.advanceTimersByTime(1_000);
    updateCard(older, { focus: 'f1', focusAt: Date.now() });
    expect(latestCard('p', 'used')?.key).toBe(older);
    vi.advanceTimersByTime(1_000);
    updateCard(newer, { ticks: { f2: true } });
    expect(latestCard('p', 'used')?.key).toBe(newer);
  });

  it('is not moved by what only records a card, such as its findings', () => {
    vi.useFakeTimers({ now: 1_000 });
    const older = cardKey('p', 'quiet', 1, 'one');
    const newer = cardKey('p', 'quiet', 1, 'two');
    updateCard(older, { findings, registeredAt: Date.now() });
    vi.advanceTimersByTime(1_000);
    updateCard(newer, { findings, registeredAt: Date.now() });
    vi.advanceTimersByTime(1_000);
    updateCard(older, { findings: { ...findings, summary: 'read again' } as unknown as ReviewFindings });
    expect(latestCard('p', 'quiet')?.key).toBe(newer);
  });
});
