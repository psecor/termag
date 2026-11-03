// What must hold before the user approves a PR they reviewed,
// read by termag from GitHub rather
// than taken from the reviewer: every thread the user opened is resolved, the
// checks passed, Bugbot and the Security agent finished clean, all on the head
// being approved; and, said out loud, whether auto-merge is on, since then an
// approval merges at once. Pure, for the tests.
import type { PrOverview, PrThread } from '../services/api';
import { prGates } from './prGates';

export type ApprovalTone = 'pass' | 'fail' | 'running' | 'warn';
export interface ApprovalGate { key: 'threads' | 'checks' | 'bugbot' | 'security' | 'head' | 'automerge'; name: string; tone: ApprovalTone; detail: string }

export function approvalGates(
  pr: Pick<PrOverview, 'checks' | 'reviewDecision' | 'reviews' | 'mergeable' | 'mergeStateStatus' | 'requestedReviewers' | 'autoMerge' | 'headSha'>,
  /** The PR's review threads; null while they're read, 'unreadable' when they couldn't be: never a pass. */
  threads: readonly PrThread[] | null | 'unreadable',
  viewer: string | null,
  /** The head the follow-up round read. */
  readHead: string | null,
): { gates: ApprovalGate[]; ready: boolean } {
  const gates: ApprovalGate[] = [];
  const mine = (Array.isArray(threads) ? threads : []).filter(t => viewer && t.comments[0]?.author?.toLowerCase() === viewer.toLowerCase());
  const open = mine.filter(t => !t.resolved).length;
  // Not knowing who you are, no thread can be told as yours: never a pass.
  gates.push(threads === null || !viewer
    ? { key: 'threads', name: 'Your threads', tone: 'running', detail: 'Reading them' }
    : threads === 'unreadable'
      ? { key: 'threads', name: 'Your threads', tone: 'fail', detail: "Couldn't read them" }
      : { key: 'threads', name: 'Your threads', tone: open ? 'fail' : 'pass', detail: mine.length === 0 ? 'None' : open ? `${open} of ${mine.length} still open` : `${mine.length} of ${mine.length} resolved` });
  const base = prGates(pr);
  const head = pr.headSha?.slice(0, 7) ?? '';
  const gate = (key: string) => base.find(g => g.key === key);
  const checks = gate('checks');
  if (checks) gates.push({ key: 'checks', name: 'Checks', tone: checks.status === 'pass' ? 'pass' : checks.status === 'fail' ? 'fail' : 'running', detail: checks.detail });
  for (const [key, name] of [['bugbot', 'Bugbot'], ['security', 'Security agent']] as const) {
    const g = gate(key);
    if (g) gates.push({ key, name, tone: g.status === 'pass' ? 'pass' : g.status === 'fail' ? 'fail' : 'running', detail: g.status === 'pass' ? `Clean on ${head}` : g.status === 'fail' ? `Findings on ${head}` : `Still running on ${head}` });
  }
  // The round must say which head it read, and it must be the PR's now: a check of no head approves nothing.
  const unread = !readHead || !pr.headSha;
  // Without case: GitHub gives lower case, a follow-up fence may name the head in capitals.
  const moved = !unread && !pr.headSha!.toLowerCase().startsWith(readHead!.slice(0, 7).toLowerCase());
  gates.push(unread
    ? { key: 'head', name: 'The head', tone: 'fail', detail: "The check didn't say which head it read" }
    : { key: 'head', name: 'The head', tone: moved ? 'fail' : 'pass', detail: moved ? `Moved to ${head} after this check` : `${head}, the one checked` });
  gates.push(pr.autoMerge
    ? { key: 'automerge', name: 'Auto-merge', tone: 'warn', detail: 'On: approving merges it right away' }
    : { key: 'automerge', name: 'Auto-merge', tone: 'pass', detail: 'Off' });
  const ready = gates.every(g => g.tone === 'pass' || g.key === 'automerge');
  return { gates, ready };
}
