/**
 * PR live updates, behind
 * pr-live-updates-enabled: a user's browsers re-read their PRs as soon as one
 * of their sessions is seen changing one, rather than on the next minute's
 * poll. Two things are seen:
 *
 * - A session opened a PR (onPrCreated: a chat's `gh pr create`, or the
 *   Claude hook's pr_created milestone in tmux). The user's list is read again
 *   until it has the PR, and only then are the browsers told: told at once,
 *   they would read a list without it, and the memo would keep serving that
 *   list for a minute. GitHub's search lags a new PR, so a load reads the PRs
 *   sessions just opened by number (routes/prs.ts withJustOpened) and the
 *   first read has it; the later tries cover a failed lookup.
 * - A chat's `git push`, or a `gh pr` command that changes a PR (merge, ready,
 *   close, reopen, edit, review), succeeded. The browsers read a PR's files,
 *   checks and reviews from the PR itself, which is never memoized, so they
 *   are told after a short wait for GitHub to take the change in.
 *
 * Telling is notifyWorkspaceChange(userId, 'prs'): `{type: 'workspace', what:
 * 'prs'}` on the user's status sockets, which the browser turns into
 * PRS_CHANGED_EVENT. What changes only on GitHub (checks finishing, Bugbot,
 * someone else's review) is not seen here: termag has no GitHub webhooks, so
 * the browser still re-reads each minute. Like chat frames, this runs on the
 * process that hears the box and tells the sockets on that process.
 */

import { prisma } from '../db';
import { boolVariation } from './featureFlags';
import { onChatEvent, type ChatEventSeen } from './chatRunner';
import { bashResultTracker, chatProjectOwner, stripHeredocs } from './chatPrLinks';
import { onPrCreated } from './workstreamPrs';
import { notifyWorkspaceChange } from './workspaceEvents';
import { prKey } from './prPipeline';

export interface PrRef { repo: string; number: number }

export interface PrLiveDeps {
  /** pr-live-updates-enabled for the user. */
  enabled: (userId: string) => Promise<boolean>;
  /** The user's PR list read from GitHub again now: the PRs in it, or null when it could not be read. */
  reread: (userId: string) => Promise<PrRef[] | null>;
  /** Tell the user's browsers to re-read their PRs. */
  notify: (userId: string) => void;
  wait: (ms: number) => Promise<void>;
}

/** The waits before each read of the list after a PR opens: at once, then while GitHub's search catches up. */
export const OPENED_READS_MS = [0, 5_000, 10_000, 15_000];
/** How long after a push (or a merge) the browsers are told: GitHub takes a moment to move the PR's head. */
export const CHANGED_DELAY_MS = 3_000;

// deploy/termag-status classify_tool's boundary rule, as in chatPrLinks.ts:
// `git push` (also `git -C <dir> push`) or a `gh pr` subcommand that changes a
// PR, at a command boundary, so "cd x && git push" counts and "echo git push"
// does not. `gh pr create` is onPrCreated's, which knows the new PR.
const PR_CHANGE = /(^|[;&|(])[^\S\n]*(git([^\S\n]+-C[^\S\n]+[^\s;&|()]+)?[^\S\n]+push|gh[^\S\n]+pr[^\S\n]+(merge|ready|close|reopen|edit|review))(\s|$)/m;

/** Whether a Bash command pushes a branch or changes a PR. */
export function isPrChangeCommand(cmd: string): boolean {
  return PR_CHANGE.test(stripHeredocs(cmd));
}

const refKey = (pr: PrRef) => prKey(pr.repo.toLowerCase(), pr.number);

export function prLiveUpdates(deps: PrLiveDeps) {
  // Per user, the opened PRs the running read loop is still looking for.
  const looking = new Map<string, Set<string>>();

  const on = (userId: string) => deps.enabled(userId).catch(() => false);

  return {
    /**
     * A session of the user's opened `pr`. One loop per user: a PR opened while
     * one runs joins it. The browsers are told once the list has every PR it
     * looks for, or after its last read regardless.
     */
    async opened(userId: string, pr: PrRef): Promise<void> {
      if (!await on(userId)) return;
      const running = looking.get(userId);
      if (running) { running.add(refKey(pr)); return; }
      const want = new Set([refKey(pr)]);
      looking.set(userId, want);
      try {
        for (const ms of OPENED_READS_MS) {
          if (ms) await deps.wait(ms);
          const listed = await deps.reread(userId).catch(() => null);
          for (const p of listed ?? []) want.delete(refKey(p));
          if (want.size === 0) break;
        }
      } finally {
        looking.delete(userId);
        deps.notify(userId);
      }
    },

    /** A session of the user's pushed a branch or changed a PR. */
    async changed(userId: string): Promise<void> {
      if (!await on(userId)) return;
      await deps.wait(CHANGED_DELAY_MS);
      deps.notify(userId);
    },
  };
}

export type PrLiveUpdates = ReturnType<typeof prLiveUpdates>;

/** The chat-event listener: each successful push or PR change a chat runs, as its project's owner. Exported for tests. */
export function chatPrChangeListener(
  live: Pick<PrLiveUpdates, 'changed'>,
  ownerOf: (projectId: string, instanceId: string) => Promise<string | null> = chatProjectOwner,
): (seen: ChatEventSeen) => void {
  const track = bashResultTracker(isPrChangeCommand);
  return seen => {
    if (track(seen).length === 0) return;
    void (async () => {
      const userId = await ownerOf(seen.projectId, seen.instanceId);
      if (userId) await live.changed(userId);
    })().catch(err => {
      console.warn(`[PR-LIVE] ${seen.projectId}/${seen.workstream}: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
}

async function defaultEnabled(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId }, select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true },
  });
  return user ? boolVariation('pr-live-updates-enabled', user, false) : false;
}

/**
 * Listen for the PRs a user's sessions open and change, in every process (a
 * box's events arrive where its socket is). Returns the unsubscribe.
 * `reread` is routes/prs.ts reloadPipelineForUser's PRs, passed in by
 * index.ts so this service does not import a route.
 */
export function startPrLiveUpdates(reread: PrLiveDeps['reread']): () => void {
  const live = prLiveUpdates({
    enabled: defaultEnabled,
    reread,
    notify: userId => notifyWorkspaceChange(userId, 'prs'),
    wait: ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); }),
  });
  const offCreated = onPrCreated(ev => {
    void live.opened(ev.userId, ev.pr).catch(err => {
      console.warn(`[PR-LIVE] ${ev.pr.repo}#${ev.pr.number}: ${err instanceof Error ? err.message : String(err)}`);
    });
  });
  const offChat = onChatEvent(chatPrChangeListener(live));
  return () => { offCreated(); offChat(); };
}
