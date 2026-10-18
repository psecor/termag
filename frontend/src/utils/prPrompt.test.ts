import { describe, it, expect } from 'vitest';
import {
  fmtContextTokens, PR_PROMPT_MIN_CONTEXT_TOKENS, PR_PROMPT_TTL_MS, promptContextTokens, prPromptTitle, shouldShowPrPrompt,
} from './prPrompt';

const NOW = 1_700_000_000_000;
const m = (ageMs = 60_000, kind: 'pr_created' | 'pr_merged' = 'pr_created', contextTokens: number | null = 180_000) =>
  ({ kind, url: null, at: new Date(NOW - ageMs).toISOString(), contextTokens });

describe('shouldShowPrPrompt', () => {
  it('shows for an idle session with a fresh milestone and enough context', () => {
    expect(shouldShowPrPrompt({ status: 'idle', milestone: m(), contextTokens: 180_000, now: NOW })).toBe(true);
  });

  it('shows only at the prompt: not mid-turn, not in a permission dialog, not with no agent', () => {
    expect(shouldShowPrPrompt({ status: 'working', milestone: m(), contextTokens: 180_000, now: NOW })).toBe(false);
    // waiting = Claude's approval/input dialog; "/compact" + Enter would hit the dialog.
    expect(shouldShowPrPrompt({ status: 'waiting', milestone: m(), contextTokens: 180_000, now: NOW })).toBe(false);
    expect(shouldShowPrPrompt({ status: 'not_running', milestone: m(), contextTokens: 180_000, now: NOW })).toBe(false);
    expect(shouldShowPrPrompt({ status: undefined, milestone: m(), contextTokens: 180_000, now: NOW })).toBe(false);
  });

  it('uses the size recorded with the milestone, so a stale (null) live reading does not hide it', () => {
    expect(shouldShowPrPrompt({ status: 'idle', milestone: m(), contextTokens: null, now: NOW })).toBe(true);
    expect(shouldShowPrPrompt({ status: 'idle', milestone: m(), contextTokens: undefined, now: NOW })).toBe(true);
  });

  it('falls back to the live reading when the milestone recorded none', () => {
    expect(shouldShowPrPrompt({ status: 'idle', milestone: m(60_000, 'pr_created', null), contextTokens: 180_000, now: NOW })).toBe(true);
    expect(shouldShowPrPrompt({ status: 'idle', milestone: m(60_000, 'pr_created', null), contextTokens: null, now: NOW })).toBe(false);
  });

  it('is silent when the context is small', () => {
    expect(shouldShowPrPrompt({ status: 'idle', milestone: m(60_000, 'pr_created', PR_PROMPT_MIN_CONTEXT_TOKENS - 1), contextTokens: null, now: NOW })).toBe(false);
  });

  it('expires with the TTL and honours a local dismiss', () => {
    expect(shouldShowPrPrompt({ status: 'idle', milestone: m(PR_PROMPT_TTL_MS - 1), contextTokens: null, now: NOW })).toBe(true);
    expect(shouldShowPrPrompt({ status: 'idle', milestone: m(PR_PROMPT_TTL_MS), contextTokens: null, now: NOW })).toBe(false);
    expect(shouldShowPrPrompt({ status: 'idle', milestone: m(), contextTokens: null, now: NOW, dismissed: true })).toBe(false);
  });

  it('needs a milestone at all', () => {
    expect(shouldShowPrPrompt({ status: 'idle', milestone: null, contextTokens: 180_000, now: NOW })).toBe(false);
  });
});

describe('promptContextTokens', () => {
  it('prefers the recorded size, then the live reading, then null', () => {
    expect(promptContextTokens({ contextTokens: 150_000 }, 20_000)).toBe(150_000);
    expect(promptContextTokens({ contextTokens: null }, 20_000)).toBe(20_000);
    expect(promptContextTokens(null, null)).toBeNull();
  });
});

describe('labels', () => {
  it('names the milestone and formats tokens compactly', () => {
    expect(prPromptTitle({ kind: 'pr_created' })).toBe('PR opened');
    expect(prPromptTitle({ kind: 'pr_merged' })).toBe('PR merged');
    expect(fmtContextTokens(180_400)).toBe('180K');
    expect(fmtContextTokens(1_250_000)).toBe('1.3M');
    expect(fmtContextTokens(999_999)).toBe('1.0M');
    expect(fmtContextTokens(999_400)).toBe('999K');
  });
});
