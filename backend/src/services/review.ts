// "Review": a Devin PR review in its own tmux session next to a project's
// agent/ctrl pair. The UI's Review button guesses which PR the agent is
// working on, lets the user confirm or retype it, and the route
// (routes/review.ts) starts `devin` with a review prompt in the
// `<user>-<project>[-<ws>]-review` session. The pure parts live here so they
// are unit-tested without tmux, gh or a server; probeReviewPane (the shared
// pane classifier used by the GET route AND the review sweep) takes its send
// function as a parameter for the same reason.
import type { ProjectHost } from './agentRegistry';
import {
  classifyReviewerPane, DEFAULT_REVIEWER, isReviewerId, reviewerForForeground, reviewerLaunch, type ReviewerId,
} from './reviewers';

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

// ── The review prompt ────────────────────────────────────────────
//
// The prompt is a fixed header naming the PR, a body the dialog lets the user
// edit, and a fixed footer. The header is not
// editable: it names the PR whatever the body says, and prFromLaunchEcho reads
// it back from Devin's re-print of the prompt. The footer is not editable
// either: the reviewer posts with the user's own gh login, so anything it
// posts must say who wrote it. The body is a template with `{{pr}}` /
// `{{url}}` placeholders; an edited body goes through the same substitution.

/** The built-in body. The dialog shows it (rendered) until the user edits it. */
export const DEFAULT_REVIEW_TEMPLATE = [
  'Read it with gh pr view {{pr}} and gh pr diff {{pr}}, and read the surrounding code where the diff alone is not enough.',
  'Report correctness bugs, risky behaviour changes, security issues and missing tests, ordered by severity, each with a file and line reference and a one-line fix.',
  'Finish with a short verdict: approve, approve with nits, or request changes.',
  'Do not modify files, commit, push or post anything to GitHub.',
].join('\n');

/** Characters, after CRLF → LF; generous for a note, small for a tmux pane. */
export const MAX_REVIEW_BODY = 16_000;

/**
 * With a URL the header names the repository and pins every gh call to it:
 * the review runs in the workstream's directory, which may be another
 * repository or none (services/reviewRepo.ts). Without one (the remote could
 * not be read) it falls back to the directory's repository.
 */
export function reviewPromptHeader(pr: number, url: string | null): string {
  if (!isPrNumber(pr)) throw new Error('invalid PR number');
  if (!url || !GITHUB_PR_URL.test(url)) return `Review GitHub pull request #${pr} for the repository in the current directory.`;
  const [, , , owner, name] = url.split('/');
  const repo = `${owner}/${name}`;
  return `Review GitHub pull request #${pr} (${url}) in the repository ${repo}. Pass --repo ${repo} to every gh command: the current directory may be a different repository, or none.`;
}

/** The line the reviewer ends anything it posts with; callers pass the reviewer's display name (services/reviewers.ts). */
export function reviewAttribution(reviewer = 'Devin'): string {
  return `Reviewed by ${reviewer}`;
}

/**
 * Appended after the body. An instruction, not a guarantee: the reviewer
 * runs gh as the user, and nothing between it and GitHub can stamp the text.
 * It holds for the default prompt's "post nothing" too: a user who later
 * types "post it" in the pane gets the attributed version.
 */
export function reviewPromptFooter(reviewer = 'Devin'): string {
  return `If you post anything to GitHub (a review, a comment or a reply), you post as the user, so end every posted text with this line on its own so readers can tell it came from you: "${reviewAttribution(reviewer)}"`;
}

export function renderReviewTemplate(template: string, pr: number, url: string | null): string {
  const cleanUrl = urlForPr(url, pr);
  return template
    .replace(/\{\{\s*pr\s*\}\}/g, String(pr))
    .replace(/\{\{\s*url\s*\}\}/g, cleanUrl ?? `#${pr}`);
}

/**
 * A body sent by the dialog. Absent / null → the built-in template. Control
 * characters other than tab and newline are refused (the body is shown in a
 * terminal, and NUL would truncate it); so are an empty and an oversized body.
 */
export function parseReviewBody(raw: unknown): { ok: true; body: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, body: null };
  if (typeof raw !== 'string') return { ok: false, error: 'prompt must be a string' };
  const body = raw.replace(/\r\n?/g, '\n').trim();
  if (!body) return { ok: false, error: 'The prompt is empty' };
  if (body.length > MAX_REVIEW_BODY) return { ok: false, error: `The prompt is longer than ${MAX_REVIEW_BODY} characters` };
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(body)) return { ok: false, error: 'The prompt contains control characters' };
  return { ok: true, body };
}

// ── Prompt templates ─────────────────────────────────────────────
//
// The body's default comes from the first usable file of: the repo's
// `.termag/review-prompt.md` (team conventions, in the workstream checkout),
// the box owner's `~/.config/termag/review-prompt.md` or
// `~/.termag-review-prompt.md` (dotfiles), else DEFAULT_REVIEW_TEMPLATE. The
// second home path exists because a dotfiles repo without an install script
// is applied by linking its TOP-LEVEL entries only, and a real ~/.config is
// left alone (deploy/termag-hook-run), so `.config/termag/…` in such a repo
// never lands. A file that is empty or fails parseReviewBody is skipped with
// a warning the dialog shows.

export type ReviewPromptSource = 'repo' | 'home' | 'builtin';

export interface ReviewTemplateCandidate {
  source: Exclude<ReviewPromptSource, 'builtin'>;
  /** Absolute path for the read-file RPC. */
  path: string;
  /** How the dialog names it. */
  label: string;
}

export function reviewTemplateCandidates(cwd: string, home: string): ReviewTemplateCandidate[] {
  const c = cwd.replace(/\/+$/, '');
  const h = home.replace(/\/+$/, '');
  return [
    { source: 'repo', path: `${c}/.termag/review-prompt.md`, label: '.termag/review-prompt.md in the repo' },
    { source: 'home', path: `${h}/.config/termag/review-prompt.md`, label: '~/.config/termag/review-prompt.md' },
    { source: 'home', path: `${h}/.termag-review-prompt.md`, label: '~/.termag-review-prompt.md' },
  ];
}

export interface ResolvedReviewTemplate {
  template: string;
  source: ReviewPromptSource;
  /** The file it came from (its label), null for the built-in one. */
  label: string | null;
  /** Files that were there but could not be used, e.g. "~/.termag-review-prompt.md: The prompt is empty". */
  warnings: string[];
}

/** First usable candidate wins. `contents[i]` is candidate i's text, null when the file is absent or unreadable. */
export function chooseReviewTemplate(candidates: ReviewTemplateCandidate[], contents: (string | null)[]): ResolvedReviewTemplate {
  const warnings: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const raw = contents[i];
    if (raw == null) continue;
    const parsed = parseReviewBody(raw);
    if (!parsed.ok) { warnings.push(`${candidates[i].label}: ${parsed.error}`); continue; }
    if (parsed.body == null) continue;
    return { template: parsed.body, source: candidates[i].source, label: candidates[i].label, warnings };
  }
  return { template: DEFAULT_REVIEW_TEMPLATE, source: 'builtin', label: null, warnings };
}

/** Header + rendered body + footer: the whole prompt the reviewer gets; `reviewer` is its display name. */
export function buildReviewPrompt(pr: number, url: string | null, body: string | null, reviewer = 'Devin'): string {
  const cleanUrl = urlForPr(url, pr);
  return `${reviewPromptHeader(pr, cleanUrl)}\n${renderReviewTemplate(body ?? DEFAULT_REVIEW_TEMPLATE, pr, cleanUrl)}\n${reviewPromptFooter(reviewer)}\n`;
}

const REVIEW_PROMPT_DIR = '.termag/review-prompts';
const SAFE_SESSION = /^[\w.-]+$/;

function promptFileName(session: string): string {
  if (!SAFE_SESSION.test(session) || session.startsWith('.')) throw new Error('unsafe review session name');
  return `${session}.md`;
}

/**
 * Where the start route writes the prompt (write-file RPC): one file per
 * review session under the box home, overwritten by the next. The agent
 * applies its path_remap to this path (a self-managed macOS agent maps
 * /home/<u> to /Users/<u>), so it is NOT the path to type into the shell —
 * reviewLaunchCommand names the same file through $HOME instead.
 */
export function reviewPromptPath(home: string, session: string): string {
  return `${home.replace(/\/+$/, '')}/${REVIEW_PROMPT_DIR}/${promptFileName(session)}`;
}

/**
 * The shell line typed into the review session. The prompt itself never
 * reaches the shell: it is written to the session's prompt file and the
 * reviewer reads it (Devin with --prompt-file, the others as `"$(cat F)"`, so
 * quotes and newlines arrive as one argument). The file is named through the
 * pane's own $HOME, which is where the remapped write-file put it; the
 * session name is checked to be plain. Per-reviewer flags and why: see
 * services/reviewers.ts.
 */
export function reviewLaunchCommand(session: string, reviewer: ReviewerId = DEFAULT_REVIEWER): string {
  const file = `"$HOME/${REVIEW_PROMPT_DIR}/${promptFileName(session)}"`;
  return reviewerLaunch(reviewer, file);
}

/** Is the review pane's foreground command Devin (still reviewing or at its prompt)? */
export function isDevinForeground(cmd: string | null | undefined): boolean {
  return reviewerForForeground(cmd) === 'devin';
}

/**
 * What the review pane is doing (services/reviewers.ts classifyReviewerPane
 * has the states and each reviewer's chrome). Devin when the reviewer is not
 * known — every pane started before the picker is Devin's.
 */
export type ReviewPaneState = 'reviewing' | 'waiting' | 'done' | 'exited';

export function classifyReviewPane(cmd: string | null | undefined, text: string, reviewer: ReviewerId = DEFAULT_REVIEWER): ReviewPaneState {
  return classifyReviewerPane(reviewer, cmd, text);
}

/**
 * The PR a live review pane was started on, read back from the echo of the
 * launch line in its scrollback — so a dock can show "PR #n" again after a
 * backend restart lost the in-memory record. The header is in Devin's re-print
 * of the prompt (and, for panes started before --prompt-file, also in the
 * shell's echo of the typed command, which wraps at the pane width and can
 * split the URL), so the first match that carries a URL wins, else the first
 * number.
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

/**
 * `<pr> <url|-> <reviewer>` on the tmux session; every part re-validated on
 * the way back. Values written before the picker are `<pr>` or `<pr> <url>`
 * and decode with reviewer null (the caller then reads it off the pane).
 * An older backend reading a new value gets the PR and drops the rest.
 */
export const PR_OPTION = '@termag-review-pr';

export function encodePrOption(pr: number, url: string | null, reviewer?: ReviewerId): string {
  if (!reviewer) return url ? `${pr} ${url}` : String(pr);
  return `${pr} ${url ?? '-'} ${reviewer}`;
}

export function decodePrOption(value: unknown): { pr: number; url: string | null; reviewer: ReviewerId | null } | null {
  if (typeof value !== 'string') return null;
  const [n, u, r] = value.trim().split(/\s+/, 3);
  const pr = Number(n);
  if (!isPrNumber(pr)) return null;
  return { pr, url: urlForPr(u, pr), reviewer: isReviewerId(r) ? r : null };
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
  /** Which tool the pane runs: the record's, else the tmux option's, else read off the foreground command, else Devin. */
  reviewer: ReviewerId;
  /** A PR recovered THIS probe (option value or launch echo) — the caller stores it. */
  recovered: { pr: number; url: string | null; reviewer: ReviewerId } | null;
  /** True when a deep capture had to run and still found nothing: try no more. */
  unrecoverable: boolean;
}

/**
 * Probe one review pane: alive?, the reviewer's state, and — when the caller
 * has no record — read the PR (and the reviewer) back from the
 * `@termag-review-pr` session option (newer agents), else from the launch
 * echo in the pane's scrollback, once. Shared by the GET /review route and
 * services/reviewSweep.ts so the dock and the ring can never disagree. Send
 * errors propagate; callers decide whether a failed RPC is "offline" (keep
 * everything) or definitive.
 */
export async function probeReviewPane(
  send: SendForHost,
  host: ProjectHost,
  session: string,
  rec: { pr: number; url: string | null; reviewer?: ReviewerId | null } | null,
): Promise<ReviewProbe> {
  const r = await send(host, 'tmux-has-session', { sessionName: session }, 5000);
  if (r?.exists !== true) {
    return { exists: false, state: null, pr: null, url: null, reviewer: rec?.reviewer ?? DEFAULT_REVIEWER, recovered: null, unrecoverable: false };
  }
  const [fg, cap] = await Promise.all([
    send(host, 'tmux-foreground-cmd', { sessionName: session }, 5000).catch(() => null),
    send(host, 'tmux-capture', { sessionName: session, lines: 40 }, 5000).catch(() => null),
  ]);
  let found: { pr: number; url: string | null; reviewer: ReviewerId | null } | null = null;
  let unrecoverable = false;
  if (!rec) {
    const opt = await send(host, 'tmux-get-user-option', { sessionName: session, name: PR_OPTION }, 5000).catch(() => null);
    found = decodePrOption(opt?.value);
    if (!found) {
      // Scrollback rotated, or a hand-made session: the deep capture runs
      // once, and the caller remembers it found nothing (unrecoverable).
      const deep = await send(host, 'tmux-capture', { sessionName: session, lines: 1000 }, 5000).catch(() => null);
      const echo = deep ? prFromLaunchEcho(typeof deep?.content === 'string' ? deep.content : '') : null;
      if (echo) found = { pr: echo.number, url: echo.url, reviewer: null };
      else if (deep) unrecoverable = true;
    }
  }
  // A pane that has exited no longer says who it was; Devin then, as every
  // pane started before the picker was.
  const reviewer = rec?.reviewer ?? found?.reviewer ?? reviewerForForeground(fg?.cmd) ?? DEFAULT_REVIEWER;
  const state = fg ? classifyReviewPane(fg.cmd, typeof cap?.content === 'string' ? cap.content : '', reviewer) : null;
  const recovered = found ? { pr: found.pr, url: found.url, reviewer } : null;
  const withUrl = recovered ?? rec ?? null;
  return { exists: true, state, pr: withUrl?.pr ?? null, url: withUrl?.url ?? null, reviewer, recovered, unrecoverable };
}
