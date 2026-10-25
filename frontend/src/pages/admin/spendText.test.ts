import { describe, it, expect } from 'vitest';
import { fmtShare, fmtUsd, mixToText, pricesToText, textToMix, textToPrices, windowKeys } from './spendText';

describe('spend formatting', () => {
  it('formats dollars at the scale they are read', () => {
    expect(fmtUsd(5238.4)).toBe('$5,238');
    expect(fmtUsd(0.551)).toBe('$0.55');
    expect(fmtUsd(27.69)).toBe('$27.69');
    expect(fmtUsd(37_948, { compact: true })).toBe('$37.9K');
    expect(fmtUsd(455_000, { compact: true })).toBe('$455K');
    expect(fmtUsd(0)).toBe('$0');
    expect(fmtUsd(null)).toBe('—');
  });
  it('formats shares of the loaded cost', () => {
    expect(fmtShare(0.0152)).toBe('1.5%');
    expect(fmtShare(0.0004)).toBe('0.04%');
    expect(fmtShare(0.25)).toBe('25%');
  });
  it('builds an inclusive window ending today (UTC)', () => {
    expect(windowKeys(30, new Date('2026-10-21T23:00:00Z'))).toEqual({ from: '2026-09-22', to: '2026-10-21' });
  });
});

describe('spend text formats', () => {
  it('round-trips the price table', () => {
    const prices = [{ provider: 'claude', model: 'claude-opus-5-5', effectiveFrom: '2026-01-01', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }];
    expect(pricesToText(prices)).toBe('claude claude-opus-5-5 2026-01-01 4 20 0.2 5');
    expect(textToPrices(`${pricesToText(prices)}\n# a comment\n\n`)).toEqual(prices);
    expect(textToPrices('claude * 2026-01-01 1 2 3')).toHaveProperty('error');
    expect(textToPrices('claude * soon 1 2 3 4')).toHaveProperty('error');
  });
  it('round-trips the model mix', () => {
    const mix = { claude: { 'claude-opus-5-5': 0.8, 'claude-fable-5-1': 0.2 } };
    expect(mixToText(mix)).toBe('claude: claude-opus-5-5=0.8, claude-fable-5-1=0.2');
    expect(textToMix(mixToText(mix))).toEqual({ mix });
    expect(textToMix('claude claude-opus-5-5=1')).toHaveProperty('error');
  });
});
