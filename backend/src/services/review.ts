// "Review": a Devin PR review in its own tmux session next to a project's
// agent/ctrl pair. The UI's Review button guesses which PR the agent is
// working on, lets the user confirm or retype it, and the route
// (routes/review.ts) starts `devin` with a review prompt in the
// `<user>-<project>[-<ws>]-review` session. The pure parts live here so they
// are unit-tested without tmux, gh or a server; probeReviewPane (the shared
// pane classifier used by the GET route AND the review sweep) takes its send
// function as a parameter for the same reason.
import type { ProjectHost } from './agentRegistry';

export type PrGuessSource = 'gh' | 'milestone' | 'pane';

export interface PrGuess {
  number: number;
  url: string | null;
  title: string | null;
  /** The branch the PR was found for (gh only). */
  branch: string | null;
  /** gh's PR state (OPEN / MERGED / CLOSED), gh only. */
  state: string | null;
  source: PrGuessSource;
}

/** The only PR URL shape we ever echo back or type into a shell. */
export const GITHUB_PR_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)$/;

const PR_URL_IN_TEXT = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g;
const PR_MENTION_IN_TEXT = /\b(?:PR|pull request)\s*#?(\d{1,7})\b/gi;

export const MAX_PR_NUMBER = 9_999_999;

export function isPrNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_PR_NUMBER;
}

/** A user-typed PR: "123", "#123", "PR 123" or a GitHub PR URL. */
export function parsePrInput(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const url = GITHUB_PR_URL.exec(s);
  if (url) return Number(url[1]);
  const m = /^(?:PR\s*)?#?(\d{1,7})$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  return isPrNumber(n) ? n : null;
}

/** `gh pr view --json number,url,title,state,headRefName` output, or null when it is not a PR. */
export function parseGhPrView(stdout: string): { number: number; url: string | null; title: string | null; state: string | null; headRefName: string | null } | null {
  let j: unknown;
  try { j = JSON.parse(stdout); } catch { return null; }
  if (typeof j !== 'object' || j === null) return null;
  const o = j as Record<string, unknown>;
  if (!isPrNumber(o.number)) return null;
  const url = typeof o.url === 'string' && GITHUB_PR_URL.test(o.url) ? o.url : null;
  return {
    number: o.number,
    url,
    title: typeof o.title === 'string' ? o.title : null,
    state: typeof o.state === 'string' ? o.state : null,
    headRefName: typeof o.headRefName === 'string' ? o.headRefName : null,
  };
}

/**
 * The PR most recently mentioned in a pane capture: the LAST GitHub PR URL
 * wins (the agent prints one right after `gh pr create`), then the last
 * "PR #123" / "pull request 123" phrase. Bare "#123" is ignored — issue refs,
 * colour codes and tmux chrome make it noise.
 */
export function prFromText(text: string): { number: number; url: string | null } | null {
  let last: { number: number; url: string | null } | null = null;
  for (const m of text.matchAll(PR_URL_IN_TEXT)) {
    const n = Number(m[1]);
    if (isPrNumber(n)) last = { number: n, url: m[0] };
  }
  if (last) return last;
  for (const m of text.matchAll(PR_MENTION_IN_TEXT)) {
    const n = Number(m[1]);
    if (isPrNumber(n)) last = { number: n, url: null };
  }
  return last;
}

export function prNumberFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = GITHUB_PR_URL.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * Rank the signals: the current branch's OPEN PR (gh) is what is being worked
 * on; a pending "PR opened/merged" milestone is the agent's own recent event;
 * a PR mentioned in the pane is the weakest. `gh pr view` also returns the
 * branch's merged or closed PR, which only wins when nothing else is there
 * (the dialog then says so). Null when nothing was found.
 */
export function chooseGuess(input: {
  gh: ReturnType<typeof parseGhPrView>;
  branch: string | null;
  milestoneUrl: string | null | undefined;
  pane: ReturnType<typeof prFromText>;
}): PrGuess | null {
  const fromGh = (): PrGuess | null => input.gh
    ? { number: input.gh.number, url: input.gh.url, title: input.gh.title, branch: input.gh.headRefName ?? input.branch, state: input.gh.state, source: 'gh' }
    : null;
  if (input.gh && input.gh.state === 'OPEN') return fromGh();
  const fromMilestone = prNumberFromUrl(input.milestoneUrl);
  if (fromMilestone) {
    return { number: fromMilestone, url: input.milestoneUrl ?? null, title: null, branch: null, state: null, source: 'milestone' };
  }
  if (input.pane) {
    return { number: input.pane.number, url: input.pane.url, title: null, branch: null, state: null, source: 'pane' };
  }
  return fromGh();
}

/** A URL is only attached to a PR when it is a GitHub PR URL for that very number. */
export function urlForPr(url: unknown, pr: number): string | null {
  return typeof url === 'string' && GITHUB_PR_URL.test(url) && url.endsWith(`/pull/${pr}`) ? url : null;
}

/**
 * The shell line typed into the review session. The prompt is one
 * single-quoted argument, so it must not contain `'`; the only
 * caller-controlled parts are the PR number (validated integer) and the URL
 * (validated against GITHUB_PR_URL, or omitted). The PR title is deliberately
 * not included — it is free text from GitHub.
 */
export function reviewLaunchCommand(pr: number, url: string | null): string {
  if (!isPrNumber(pr)) throw new Error('invalid PR number');
  const where = url && GITHUB_PR_URL.test(url) ? `#${pr} (${url})` : `#${pr}`;
  const prompt = [
    `Review GitHub pull request ${where} for the repository in the current directory.`,
    `Read it with gh pr view ${pr} and gh pr diff ${pr}, and read the surrounding code where the diff alone is not enough.`,
    'Report correctness bugs, risky behaviour changes, security issues and missing tests, ordered by severity, each with a file and line reference and a one-line fix.',
    'Finish with a short verdict: approve, approve with nits, or request changes.',
    'Do not modify files, commit, push or post anything to GitHub.',
  ].join(' ');
  if (prompt.includes("'")) throw new Error('review prompt must not contain single quotes');
  // `smart`: a fast model lets safe shell commands (gh pr view / diff) run
  // without a prompt, so the review gets going on its own; the default `auto`
  // stops on the very first `gh pr view` for approval. Trade-off (Devin's
  // permissions reference): smart also auto-approves edits inside the
  // workspace, so staying read-only rests on the prompt's instruction, and
  // the pane is there to be watched. Installs, mutating git, rm and sudo
  // always prompt in smart.
  return `devin --permission-mode smart -- '${prompt}'`;
}

/** Is the review pane's foreground command Devin (still reviewing or at its prompt)? */
export function isDevinForeground(cmd: string | null | undefined): boolean {
  return !!cmd && cmd.toLowerCase().includes('devin');
}

/**
 * What the review pane is doing, for the dock's one-line bar. Devin is a
 * poller provider with no status on boxes, so this reads the pane the way
 * the tmux poller would, with Devin-specific chrome: its input box
 * ("❭ Guide Devin while it works") is always drawn, so the prompt alone does
 * not mean done; activity shows as a braille spinner + "Thinking · 39s (esc
 * twice to interrupt)" or "● Running command"; an approval list ends in
 * "↑↓ select · ↵ confirm".
 *
 *   'waiting'   — Devin is asking (approval / choice); the user has to answer
 *   'reviewing' — Devin is thinking or running a tool
 *   'done'      — Devin is at its prompt: the review is there to read
 *   'exited'    — Devin quit; the pane is a shell
 */
export type ReviewPaneState = 'reviewing' | 'waiting' | 'done' | 'exited';

// Only the bottom of the pane is Devin's chrome; everything above it is
// content Devin printed, which can quote anything (a review of a diff that
// contains these very patterns did). The approval footer is the last line
// above the status bar; the Thinking line sits just above the input box.
// The footer is a whole line of its own; a quoted mention mid-sentence is not.
const DEVIN_WAITING = [/^\s*↑↓\s+select\s*·\s*↵\s+confirm(?:\s*·\s*esc cancel)?\s*$/];
const DEVIN_ACTIVITY = [
  /\(esc twice to interrupt\)/,
  /^\s*[⠀-⣿]*\s*Thinking\s*·/,
  /Guide Devin while it works/,
];
const WAITING_WINDOW = 6;
const ACTIVITY_WINDOW = 8;

export function classifyReviewPane(cmd: string | null | undefined, text: string): ReviewPaneState {
  if (!isDevinForeground(cmd)) return 'exited';
  const tail = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
  if (tail.slice(-WAITING_WINDOW).some(l => DEVIN_WAITING.some(p => p.test(l)))) return 'waiting';
  if (tail.slice(-ACTIVITY_WINDOW).some(l => DEVIN_ACTIVITY.some(p => p.test(l)))) return 'reviewing';
  return 'done';
}

/**
 * The PR a live review pane was started on, read back from the echo of the
 * launch line in its scrollback — so a dock can show "PR #n" again after a
 * backend restart lost the in-memory record. The line appears twice — the
 * shell's echo of the typed command, which wraps at the pane width and can
 * split the URL, and Devin's own re-print of the prompt — so the first match
 * that carries a URL wins, else the first number.
 */
const LAUNCH_ECHO = /Review GitHub pull request #(\d{1,7})(?: \((https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)\))?/g;
export function prFromLaunchEcho(text: string): { number: number; url: string | null } | null {
  let first: { number: number; url: string | null } | null = null;
  for (const m of text.matchAll(LAUNCH_ECHO)) {
    const n = Number(m[1]);
    if (!isPrNumber(n)) continue;
      const url = urlForPr(m[2], n);
    if (url) return { number: n, url };
    first ??= { number: n, url: null };
  }
  return first;
}

// ── The tmux PR option and the shared pane probe ─────────────────

/** `<pr> <url>` on the tmux session; both halves re-validated on the way back. */
export const PR_OPTION = '@termag-review-pr';

export function encodePrOption(pr: number, url: string | null): string {
  return url ? `${pr} ${url}` : String(pr);
}

export function decodePrOption(value: unknown): { pr: number; url: string | null } | null {
  if (typeof value !== 'string') return null;
  const [n, u] = value.trim().split(/\s+/, 2);
  const pr = Number(n);
  if (!isPrNumber(pr)) return null;
  return { pr, url: urlForPr(u, pr) };
}

/** Send function of the shape sendForProject has, so probes are testable with a fake. */
export type SendForHost = (host: ProjectHost, type: string, payload: Record<string, unknown>, timeoutMs?: number) => Promise<any>;

export interface ReviewProbe {
  /** False: the tmux session is gone — the caller clears its record. */
  exists: boolean;
  /** classifyReviewPane of the pane; null when the foreground-cmd RPC failed. */
  state: ReviewPaneState | null;
  /** pr/url the record should carry after this probe (existing or recovered). */
  pr: number | null;
  url: string | null;
  /** A PR recovered THIS probe (option value or launch echo) — the caller stores it. */
  recovered: { pr: number; url: string | null } | null;
  /** True when a deep capture had to run and still found nothing: try no more. */
  unrecoverable: boolean;
}

/**
 * Probe one review pane: alive?, Devin's state, and — when the caller has no
 * record — read the PR back from the `@termag-review-pr` session option
 * (newer agents), else from the launch echo in the pane's scrollback, once.
 * This is the body of the old GET /review status handler, extracted so the
 * route and services/reviewSweep.ts share one implementation and the dock and
 * the ring can never disagree. Send errors propagate; callers decide whether
 * a failed RPC is "offline" (keep everything) or definitive.
 */
export async function probeReviewPane(
  send: SendForHost,
  host: ProjectHost,
  session: string,
  rec: { pr: number; url: string | null } | null,
): Promise<ReviewProbe> {
  const r = await send(host, 'tmux-has-session', { sessionName: session }, 5000);
  if (r?.exists !== true) {
    return { exists: false, state: null, pr: null, url: null, recovered: null, unrecoverable: false };
  }
  const [fg, cap] = await Promise.all([
    send(host, 'tmux-foreground-cmd', { sessionName: session }, 5000).catch(() => null),
    send(host, 'tmux-capture', { sessionName: session, lines: 40 }, 5000).catch(() => null),
  ]);
  const state = fg ? classifyReviewPane(fg.cmd, typeof cap?.content === 'string' ? cap.content : '') : null;
  let recovered: { pr: number; url: string | null } | null = null;
  let unrecoverable = false;
  if (!rec) {
    const opt = await send(host, 'tmux-get-user-option', { sessionName: session, name: PR_OPTION }, 5000).catch(() => null);
    const fromOpt = decodePrOption(opt?.value);
    if (fromOpt) {
      recovered = { pr: fromOpt.pr, url: fromOpt.url };
    } else {
      // Scrollback rotated, or a hand-made session: the deep capture runs
      // once, and the caller remembers it found nothing (unrecoverable).
      const deep = await send(host, 'tmux-capture', { sessionName: session, lines: 1000 }, 5000).catch(() => null);
      const echo = deep ? prFromLaunchEcho(typeof deep?.content === 'string' ? deep.content : '') : null;
      if (echo) recovered = { pr: echo.number, url: echo.url };
      else if (deep) unrecoverable = true;
    }
  }
  const withUrl = recovered ?? rec ?? null;
  return { exists: true, state, pr: withUrl?.pr ?? null, url: withUrl?.url ?? null, recovered, unrecoverable };
}
