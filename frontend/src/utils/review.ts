// The Review button: pure helpers shared by the dialog and the dock. Mirrors
// the validation in backend/src/services/review.ts (parsePrInput) so the
// dialog can refuse bad input before a round trip.

import { PROVIDERS } from '../providers/registry';

export const GITHUB_PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/;
export const MAX_PR_NUMBER = 9_999_999;

/**
 * A user-typed PR: "123", "#123", "PR 123", "owner/repo#123" or a GitHub PR
 * URL. The last two come back with a URL (so the review names the repository
 * and the dock can link it).
 */
export function parsePrInputFull(raw: string): { number: number; url: string | null } | null {
  const s = raw.trim();
  if (!s) return null;
  const url = GITHUB_PR_URL.exec(s);
  if (url) {
    const n = Number(url[1]);
    return n >= 1 && n <= MAX_PR_NUMBER ? { number: n, url: s } : null;
  }
  const ref = /^([\w.-]+\/[\w.-]+)#(\d{1,7})$/.exec(s);
  if (ref) {
    const n = Number(ref[2]);
    return n >= 1 && n <= MAX_PR_NUMBER ? { number: n, url: prUrlFor(ref[1], n) } : null;
  }
  const m = /^(?:PR\s*)?#?(\d{1,7})$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= MAX_PR_NUMBER ? { number: n, url: null } : null;
}

export function parsePrInput(raw: string): number | null {
  return parsePrInputFull(raw)?.number ?? null;
}

export function prUrlFor(repo: string, pr: number): string {
  return `https://github.com/${repo}/pull/${pr}`;
}

/** `owner/name` from a GitHub PR URL. */
export function repoFromPrUrl(url: string | null | undefined): string | null {
  if (!url || !GITHUB_PR_URL.test(url)) return null;
  const [, , , owner, name] = url.split('/');
  return `${owner}/${name}`;
}

/** Mirrors reviewPromptHeader in backend/src/services/review.ts: the prompt's fixed first line. */
export function reviewPromptHeader(pr: number | null, url: string | null): string {
  const n = pr != null ? `#${pr}` : '#…';
  const repo = pr != null ? repoFromPrUrl(url) : null;
  if (!repo) return `Review GitHub pull request ${n} for the repository in the current directory.`;
  return `Review GitHub pull request ${n} (${url}) in the repository ${repo}. Pass --repo ${repo} to every gh command: the current directory may be a different repository, or none.`;
}

/**
 * Which pull request the dialog would start a review of, and what is wrong
 * with it. Mirrors reviewTarget in backend/src/services/reviewRepo.ts: a typed
 * URL wins, then the guess's URL for the guessed number, then the number in
 * the workstream's repository. With no GitHub remote (`repoKnown` and no
 * `repo`) a bare number is refused: it could be any repository's PR.
 */
export interface ReviewTargetView {
  url: string | null;
  /** owner/name of the PR, null when it cannot be told (older backend, unreadable remote). */
  repo: string | null;
  title: string | null;
  /** Why Start is off. */
  problem: string | null;
  /** The workstream's repository when the PR is in another one. */
  mismatch: string | null;
}

export function reviewTargetView(o: {
  pr: number | null; typedUrl: string | null; guess: PrGuess | null; repo: string | null; repoKnown: boolean;
}): ReviewTargetView {
  if (o.pr == null) return { url: null, repo: null, title: null, problem: null, mismatch: null };
  const guessed = o.guess && o.guess.number === o.pr ? o.guess : null;
  const url = o.typedUrl ?? guessed?.url ?? (o.repo ? prUrlFor(o.repo, o.pr) : null);
  const repo = repoFromPrUrl(url);
  const problem = !url && o.repoKnown
    ? `This workstream's directory has no GitHub remote, so PR #${o.pr} could be in any repository. Paste the PR's URL or type owner/repo#${o.pr}.`
    : null;
  const mismatch = repo && o.repo && repo.toLowerCase() !== o.repo.toLowerCase() ? o.repo : null;
  return { url, repo, title: guessed?.title ?? null, problem, mismatch };
}

/**
 * The review prompt body for a PR: the template with `{{pr}}` / `{{url}}`
 * filled in. Mirrors renderReviewTemplate in backend/src/services/review.ts,
 * which applies the same substitution again to whatever body is sent.
 */
export function renderReviewTemplate(template: string, pr: number | null, url: string | null): string {
  if (pr == null) return template;
  const cleanUrl = url && GITHUB_PR_URL.test(url) && url.endsWith(`/pull/${pr}`) ? url : null;
  return template
    .replace(/\{\{\s*pr\s*\}\}/g, String(pr))
    .replace(/\{\{\s*url\s*\}\}/g, cleanUrl ?? `#${pr}`);
}

/** Mirrors MAX_REVIEW_BODY in the backend. */
export const MAX_REVIEW_BODY = 16_000;

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
  /** The review tool's provider id; null/absent = Devin (every pane before the picker). */
  reviewer?: string | null;
}

/** "Devin" / "Claude" / "Cursor" for a reviewer id; Devin when unknown. */
export function reviewerDisplayName(id: string | null | undefined): string {
  return (id && PROVIDERS[id]?.displayName) || 'Devin';
}

export type ReviewDockState = ReviewPaneState | 'gone';

/** The dock's one-line state. `gone` = no pane; a null state (agent offline) reads as reviewing. */
export function reviewStateLabel(s: Pick<ReviewStatus, 'alive' | 'state'>): ReviewDockState {
  if (!s.alive) return 'gone';
  return s.state ?? 'reviewing';
}

export function reviewStateText(state: ReviewDockState, reviewer?: string | null): string {
  const name = reviewerDisplayName(reviewer);
  switch (state) {
    case 'reviewing': return `${name} reviewing…`;
    case 'waiting': return `${name} needs an answer`;
    case 'done': return 'Review ready';
    case 'exited': return `${name} exited`;
    case 'gone': return '';
  }
}
