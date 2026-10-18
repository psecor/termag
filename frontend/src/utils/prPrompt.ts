// "You just pushed a PR — Compact or Clear?" — when to show the prompt for a
// session. Pure so the gating can be unit-tested; the card, the tile/workstream
// dots and the dashboard item all call shouldShowPrPrompt so they agree.
import type { AgentStatus, SessionMilestone } from '../types';

/** Below this the context isn't worth a prompt; there is nothing to save. */
export const PR_PROMPT_MIN_CONTEXT_TOKENS = 100_000;
/** Mirrors the backend TTL: a milestone nobody acted on is dropped. */
export const PR_PROMPT_TTL_MS = 30 * 60 * 1000;

export interface PrPromptInput {
  status: AgentStatus['status'] | undefined;
  milestone: SessionMilestone | null | undefined;
  contextTokens: number | null | undefined;
  now: number;
  /** Set when the user clicked Keep / acted locally before the server confirmed. */
  dismissed?: boolean;
}

/**
 * The context size the prompt reasons about: the reading recorded with the
 * milestone (refreshed server-side while pending), falling back to the live
 * reading. The live reading alone goes null once the transcript is ten
 * minutes stale, which every idle session hits long before the TTL.
 */
export function promptContextTokens(milestone: Pick<SessionMilestone, 'contextTokens'> | null | undefined, live: number | null | undefined): number | null {
  return milestone?.contextTokens ?? live ?? null;
}

export function shouldShowPrPrompt(i: PrPromptInput): boolean {
  if (!i.milestone || i.dismissed) return false;
  // Only at the prompt. `working` is mid-turn; `waiting` includes Claude Code's
  // permission dialogs, where typing "/compact" + Enter would land in the
  // dialog and Enter would accept whatever is highlighted; `not_running` has
  // no agent to compact.
  if (i.status !== 'idle') return false;
  const ctx = promptContextTokens(i.milestone, i.contextTokens);
  if (ctx == null || ctx < PR_PROMPT_MIN_CONTEXT_TOKENS) return false;
  const at = Date.parse(i.milestone.at);
  if (!Number.isFinite(at) || i.now - at >= PR_PROMPT_TTL_MS) return false;
  return true;
}

export function prPromptTitle(m: Pick<SessionMilestone, 'kind'>): string {
  return m.kind === 'pr_merged' ? 'PR merged' : 'PR opened';
}

export function fmtContextTokens(tokens: number): string {
  // Switch to M once K-rounding would read "1000K".
  return tokens >= 999_500 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`;
}
