// The review tools the Review button can start.
// Each one is a provider from providers/registry.ts (its display name comes
// from there) plus what the review pane needs that the registry does not
// carry: how to launch it on a prompt file in a read-only-as-possible mode,
// how to tell it is still the pane's foreground process, and the bottom-of-
// pane chrome that says it is asking for an answer or still working.
//
// Verified on a box (2026-10-13) with a prompt file in a tmux pane:
//   devin  --permission-mode smart --prompt-file F   smart auto-runs gh; edits rest on the prompt
//   claude --permission-mode plan "$(cat F)"           plan mode ran `gh pr view` unasked, no plan-approval stop
//   cursor-agent --mode plan --auto-review "$(cat F)"  plan alone stops on every gh; auto-review runs it
// pi is not here yet: its review pane has not been observed, and a
// classifier written blind would misreport.
import { PROVIDERS } from '../providers/registry';
import type { ReviewPaneState } from './review';

export const REVIEWER_IDS = ['devin', 'claude', 'cursor'] as const;
export type ReviewerId = typeof REVIEWER_IDS[number];
export const DEFAULT_REVIEWER: ReviewerId = 'devin';

interface ReviewerSpec {
  /** One line for the dialog: how read-only the review is. */
  note: string;
  /** The shell line, given the prompt file as an already double-quoted shell word. */
  launch(file: string): string;
  /** tmux's pane_current_command while the tool runs. */
  isForeground(cmd: string): boolean;
  /** Lines that mean "the user has to answer", looked for in the last `waitingWindow` non-blank lines. */
  waiting: RegExp[];
  waitingWindow: number;
  /** Lines that mean "still working", looked for in the last `activityWindow` non-blank lines. */
  activity: RegExp[];
  activityWindow: number;
}

const SPECS: Record<ReviewerId, ReviewerSpec> = {
  // Devin's input box ("❭ Guide Devin while it works") is always drawn, so the
  // prompt alone does not mean done; activity shows as a braille spinner +
  // "Thinking · 39s (esc twice to interrupt)"; an approval list ends in
  // "↑↓ select · ↵ confirm". The footer is a whole line of its own; a quoted
  // mention mid-sentence is not.
  devin: {
    // `smart`: a fast model lets safe shell commands (gh pr view / diff) run
    // without a prompt, so the review gets going on its own; the default
    // `auto` stops on the very first `gh pr view` for approval. Trade-off
    // (Devin's permissions reference): smart also auto-approves edits inside
    // the workspace, so staying read-only rests on the prompt's instruction,
    // and the pane is there to be watched. Installs, mutating git, rm and
    // sudo always prompt in smart.
    note: 'smart mode: safe commands run unasked; staying read-only rests on the prompt',
    launch: f => `devin --permission-mode smart --prompt-file ${f}`,
    isForeground: cmd => cmd.toLowerCase().includes('devin'),
    waiting: [/^\s*↑↓\s+select\s*·\s*↵\s+confirm(?:\s*·\s*esc cancel)?\s*$/],
    waitingWindow: 6,
    activity: [/\(esc twice to interrupt\)/, /^\s*[⠀-⣿]*\s*Thinking\s*·/, /Guide Devin while it works/],
    activityWindow: 8,
  },
  // Claude Code: while working the status line ends "· esc to interrupt" and a
  // spinner line reads "✢ Elucidating… (5s · ↓ 191 tokens)"; done leaves
  // "✻ Brewed for 15s · done 4:39 AM" and the bare ❯ box. A permission or
  // trust dialog replaces the input box with a question and a numbered list
  // whose selected row starts with ❯. A box where Claude never ran opens on
  // the first-run theme picker ("❯ ✔ Dark mode" above a diff preview ending
  // "Syntax theme: … (ctrl+t to disable)"): an answer is needed there too.
  claude: {
    // Plan mode refuses anything that writes, posting included (checked:
    // `touch` was declined). To post the review, leave plan mode in the pane.
    note: 'plan mode: read-only; to post the review, leave plan mode in the pane (Shift+Tab)',
    launch: f => `claude --permission-mode plan "$(cat ${f})"`,
    isForeground: cmd => /^claude\b/i.test(cmd),
    waiting: [
      /^\s*(?:Do you want to (?:proceed|make this edit|create)|Would you like to proceed|Do you trust the files in this folder)\b.*\?/,
      /^\s*❯\s*(?:\d+\.|✔)\s/,
      /^\s*Esc to cancel\b/,
      /^\s*Syntax theme: .*\(ctrl\+t to/,
    ],
    waitingWindow: 12,
    activity: [/\besc to interrupt\b/, /^\s*\S\s+[A-Z][\w-]*…\s*\(\d/],
    activityWindow: 6,
  },
  // cursor-agent: while working the input row reads "→ Add a follow-up …
  // ctrl+c to stop" under a braille spinner ("⠘⠣ Working", "⠘⠆ Running");
  // done drops "ctrl+c to stop". A shell approval is a box ("Run this
  // command?" … "Skip & tell the agent what to do instead"); the workspace
  // trust dialog ends "Use arrow keys to navigate, Enter to select".
  cursor: {
    note: 'plan mode with auto-review: no file edits; safe commands run unasked',
    launch: f => `cursor-agent --mode plan --auto-review "$(cat ${f})"`,
    isForeground: cmd => /cursor-agent|^agent$/i.test(cmd),
    waiting: [
      /^\s*Run this command\?/,
      /Skip & tell the agent what to do instead/,
      /Do you trust the contents of this directory\?/,
      /Use arrow keys to navigate, Enter to select/,
    ],
    waitingWindow: 12,
    activity: [/\bctrl\+c to stop\b/, /^\s*[⠀-⣿]+\s+(?:Working|Running|Thinking|Generating|Reading|Searching|Editing)\b/],
    activityWindow: 8,
  },
};

export function isReviewerId(v: unknown): v is ReviewerId {
  return typeof v === 'string' && (REVIEWER_IDS as readonly string[]).includes(v);
}

export function reviewerName(id: ReviewerId): string {
  return PROVIDERS[id]?.displayName ?? id;
}

export function reviewerNote(id: ReviewerId): string {
  return SPECS[id].note;
}

export function reviewerLaunch(id: ReviewerId, file: string): string {
  return SPECS[id].launch(file);
}

/** Which reviewer a pane's foreground command is, for a pane whose record and tmux option are both gone. */
export function reviewerForForeground(cmd: string | null | undefined): ReviewerId | null {
  if (!cmd) return null;
  return REVIEWER_IDS.find(id => SPECS[id].isForeground(cmd)) ?? null;
}

/**
 * What the review pane is doing, for the dock's one-line bar and the ring.
 * Only the bottom of the pane is the tool's chrome; everything above it is
 * content it printed, which can quote anything (a review of a diff that
 * contains these very patterns did), hence the windows.
 *
 *   'waiting'   — the reviewer is asking (approval / choice / trust); the user has to answer
 *   'reviewing' — the reviewer is thinking or running a tool
 *   'done'      — the reviewer is at its prompt: the review is there to read
 *   'exited'    — the reviewer quit; the pane is a shell
 */
export function classifyReviewerPane(id: ReviewerId, cmd: string | null | undefined, text: string): ReviewPaneState {
  const spec = SPECS[id];
  if (!cmd || !spec.isForeground(cmd)) return 'exited';
  const tail = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim());
  if (tail.slice(-spec.waitingWindow).some(l => spec.waiting.some(p => p.test(l)))) return 'waiting';
  if (tail.slice(-spec.activityWindow).some(l => spec.activity.some(p => p.test(l)))) return 'reviewing';
  return 'done';
}
