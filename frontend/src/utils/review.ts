// The Review button: pure helpers shared by the dialog and the dock. Mirrors
// the validation in backend/src/services/review.ts (parsePrInput) so the
// dialog can refuse bad input before a round trip.

export const GITHUB_PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/;
export const MAX_PR_NUMBER = 9_999_999;

/** A user-typed PR: "123", "#123", "PR 123" or a GitHub PR URL (kept, so the dock can link it). */
export function parsePrInputFull(raw: string): { number: number; url: string | null } | null {
  const s = raw.trim();
  if (!s) return null;
  const url = GITHUB_PR_URL.exec(s);
  if (url) {
    const n = Number(url[1]);
    return n >= 1 && n <= MAX_PR_NUMBER ? { number: n, url: s } : null;
  }
  const m = /^(?:PR\s*)?#?(\d{1,7})$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= MAX_PR_NUMBER ? { number: n, url: null } : null;
}

export function parsePrInput(raw: string): number | null {
  return parsePrInputFull(raw)?.number ?? null;
}

export type PrGuessSource = 'gh' | 'milestone' | 'pane';

export interface PrGuess {
  number: number;
  url: string | null;
  title: string | null;
  branch: string | null;
  /** gh's PR state (OPEN / MERGED / CLOSED) when the guess came from gh. */
  state: string | null;
  source: PrGuessSource;
}

/** One line under the input explaining where the prefilled number came from. */
export function guessExplanation(guess: PrGuess | null, branch: string | null): string {
  if (!guess) {
    return branch
      ? `No pull request found for branch ${branch}. Type the PR number.`
      : 'No pull request found. Type the PR number.';
  }
  switch (guess.source) {
    case 'gh': {
      const kind = guess.state && guess.state !== 'OPEN' ? `${guess.state.charAt(0)}${guess.state.slice(1).toLowerCase()} PR` : 'Open PR';
      return guess.branch
        ? `${kind} for branch ${guess.branch}${guess.title ? `: ${guess.title}` : ''}`
        : `${kind} for the current branch${guess.title ? `: ${guess.title}` : ''}`;
    }
    case 'milestone':
      return 'The PR the agent just opened or merged.';
    case 'pane':
      return 'The last PR mentioned in the agent pane. Check it.';
  }
}

/** What the backend read off the review pane (services/review.ts classifyReviewPane). */
export type ReviewPaneState = 'reviewing' | 'waiting' | 'done' | 'exited';

export interface ReviewStatus {
  session: string;
  connected: boolean;
  alive: boolean;
  running: boolean;
  state: ReviewPaneState | null;
  pr: number | null;
  url: string | null;
  startedAt: string | null;
}

export type ReviewDockState = ReviewPaneState | 'gone';

/** The dock's one-line state. `gone` = no pane; a null state (agent offline) reads as reviewing. */
export function reviewStateLabel(s: Pick<ReviewStatus, 'alive' | 'state'>): ReviewDockState {
  if (!s.alive) return 'gone';
  return s.state ?? 'reviewing';
}

export function reviewStateText(state: ReviewDockState): string {
  switch (state) {
    case 'reviewing': return 'Devin reviewing…';
    case 'waiting': return 'Devin needs an answer';
    case 'done': return 'Review ready';
    case 'exited': return 'Devin exited';
    case 'gone': return '';
  }
}
