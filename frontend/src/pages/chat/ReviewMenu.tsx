// Review on a PR: a split button that starts the
// lab's agent review (Review with Devin) in two
// clicks, with the reviewer the user picked last, in the PR's review target
// (the workstream linked to it, else main of a project on its repository) or
// beside the session that asked (its own PR). The menu picks Devin, Claude or
// Cursor, and Edit the prompt shows the whole prompt first: the fixed line
// naming the PR, the body from the lab's template (the repo's, the box
// owner's dotfiles, else the built-in one, which the dialog names, warning
// when it comes from the PR's own branch), and the fixed sign-off. A group
// reviews all together, in one pane, as the lab's Review all with Devin does.
// Started, it opens that session with the side panel on its Review tab.
// A PR on a repository none of your projects has (simple-ui-review-clone-enabled):
// Review clones it into a new project on one of your boxes first
// (chat/reviewClone.ts), then starts there; off, the button is disabled and
// says why under it, and what to do (a disabled button shows no tooltip).
// An agent review in a project that's there opens its session at once, and the
// session's Review tab shows the review starting, and its box waking when the
// start route holds it for that (runReviewStart), or what to do when it can't.
import React, { startTransition, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button, ButtonGroup, Dialog, Heading, IconButton, Menu, MenuItem, MenuTrigger, Modal, ModalOverlay, Popover, Separator, Text, TextArea,
  TextField, ToggleButton, ToggleButtonGroup, Tooltip, TooltipTrigger,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { instancesApi, projectsApi, prsApi, reviewApi, type PrGroupMember, type PrReviewGroup, type PrRow, type PrWorkstreamLink, type ReviewGuessResponse } from '../../services/api';
import { boxFeed } from '../../services/boxFeed';
import { FLAGS, useFlag } from '../../flags';
import { CHAT_PROVIDER_ID } from '../../providers/registry';
import {
  cloneFor, cloneOutcomeFor, cloneProgressText, cloneReady, cloneStartHref, noteCloneOutcome, useCloneOutcome, noteCloneStep, repoOfCloneUrl, reviewCloneBox, unreadyCloneOf,
  untilCheckedOut, useReviewClone, wakeProjectBox, type ClonedProject, type CloneDeps,
} from '../../chat/reviewClone';
import { suggestPrPrompt, suggestWorkstreamName } from '../../utils/workstreamChoices';
import { queueKey, uniqueName, writeQueued } from '../../chat/newChat';
import { REVIEW_SEND_MAX, reviewDiffBlock, reviewFormatInstruction } from '../../chat/reviewCard';
import { groupReviewBody, groupReviewPlan, toReview } from '../../utils/prReviewGroups';
import { renderReviewTemplate, reviewPromptHeader, templateForRepo } from '../../utils/review';
import { apiErrorText } from '../../utils/prPipeline';
import { chatHref } from '../../chat/simpleChat';
import { prShort } from '../../chat/reviews';
import { useProjects } from '../../contexts/ProjectContext';
import type { Instance, Project } from '../../types';
import { markReviewSession, useReviewsData } from './reviewsData';

export type ReviewerId = 'devin' | 'claude' | 'cursor';
export const REVIEWERS: ReadonlyArray<{ id: ReviewerId; name: string; note: string }> = [
  { id: 'devin', name: 'Devin', note: 'Reads it and can post, signing what it posts' },
  { id: 'claude', name: 'Claude', note: 'Reads in plan mode: it can\'t edit or post' },
  { id: 'cursor', name: 'Cursor', note: 'Plan mode with auto-review' },
];
/** The lab's own key: the last reviewer picked, in either UI. */
const REVIEWER_KEY = 'termag.review.reviewer';
/** termag's: whether Review starts a review session or an agent review. */
const KIND_KEY = 'termag.review.kind';
export type ReviewKind = 'agent' | 'session';
export function readKind(): ReviewKind {
  try { return localStorage.getItem(KIND_KEY) === 'session' ? 'session' : 'agent'; } catch { return 'agent'; }
}
function writeKind(k: ReviewKind) {
  try { localStorage.setItem(KIND_KEY, k); } catch { /* not kept */ }
  notifyPrefs();
}

/** What a review session's agent starts on: the lab's own first prompt for a PR's workstream. */
export function reviewSessionPrompt(repo: string, number: number): string {
  return `${suggestPrPrompt(repo, number)}${reviewFormatInstruction(prShort(repo, number))}`;
}

/**
 * A review chat's first message from Edit the prompt (simple-ui-review-chat-enabled): the lab's fixed line naming
 * the PR, the body as the dialog shows it, then the review card's format, which asks it to post nothing (you post
 * from the card), in place of the pane's sign-off line.
 */
export function reviewChatPrompt(repo: string, number: number, body: string): string {
  const header = reviewPromptHeader(number, `https://github.com/${repo}/pull/${number}`);
  // A body cleared in the dialog is sent as it showed: the fixed line and the card's format alone.
  return `${header}${body.trim() ? `\n\n${body.trim()}` : ''}${reviewFormatInstruction(prShort(repo, number))}`;
}

/** A reviewer's line in the reviewer menus while its review is a chat (simple-ui-review-chat-enabled). */
export const CHAT_REVIEW_NOTE = 'A chat on a checkout of the PR: you talk it through and post';

/**
 * The reviewers whose review is a chat with review chats on (simple-ui-review-chat-enabled), and the chat-runner
 * provider each one's session is made as (backend routes/prs.ts REVIEW_CHAT_PROVIDERS).
 */
export const REVIEW_CHAT_PROVIDERS: Readonly<Partial<Record<ReviewerId, string>>> = { claude: CHAT_PROVIDER_ID, cursor: 'cursor-chat', devin: 'devin-chat' };

/**
 * The reviewers whose chat needs every box it runs on to say its agent can run their engine (the box list's
 * `chatEngines`, backend chatEnginesOf). Devin's engine is new on boxes (agent chat-devin-v1, after a bake and an agent
 * restart), so Devin's review is a chat only there; anywhere else, a box whose agent isn't connected (asleep, waking)
 * included, it keeps its review pane, as with review chats off.
 */
export const REVIEW_CHAT_ENGINES: Readonly<Partial<Record<ReviewerId, string>>> = { devin: 'devin' };

/** A reviewer's line in the page-wide picker while its review is a chat only on a box that can run it (REVIEW_CHAT_ENGINES). */
export const CHAT_REVIEW_NOTE_WHERE_IT_RUNS = 'A chat on a checkout of the PR, on a box that can run it; else its review pane';

/**
 * Whether `who`'s review can be a chat on the boxes it would run on: always for a reviewer whose engine every
 * box's runner has; for one in REVIEW_CHAT_ENGINES, only when there is a box and each one says it runs that engine.
 */
export function reviewChatOnBoxes(
  who: ReviewerId, boxIds: ReadonlyArray<string | null | undefined>, boxes: ReadonlyArray<Pick<Instance, 'id' | 'chatEngines'>>,
): boolean {
  const engine = REVIEW_CHAT_ENGINES[who];
  if (!engine) return true;
  return boxIds.length > 0 && boxIds.every(id => !!id && !!boxes.find(b => b.id === id)?.chatEngines?.includes(engine));
}

const browserStore = () => (typeof localStorage !== 'undefined' ? localStorage : null);

export function readReviewer(): ReviewerId {
  try {
    const v = localStorage.getItem(REVIEWER_KEY);
    return v === 'claude' || v === 'cursor' ? v : 'devin';
  } catch { return 'devin'; }
}
function writeReviewer(id: ReviewerId) {
  try { localStorage.setItem(REVIEWER_KEY, id); } catch { /* not kept */ }
  notifyPrefs();
}
// Every Review button on the page reads the same choice: a pick anywhere (the Reviews page's header, a
// button's menu, another tab) shows in all of them at once.
const prefListeners = new Set<() => void>();
const PREF_KEYS = new Set<string>([REVIEWER_KEY, KIND_KEY]);
function subscribePrefs(fn: () => void): () => void {
  prefListeners.add(fn);
  const onStorage = (e: StorageEvent) => { if (e.key === null || PREF_KEYS.has(e.key)) fn(); };
  window.addEventListener('storage', onStorage);
  return () => { prefListeners.delete(fn); window.removeEventListener('storage', onStorage); };
}
function notifyPrefs() { for (const fn of prefListeners) fn(); }

/**
 * A review just started, by where it runs, until its pane is listed (the status sweep takes a moment):
 * whichever Review button started it (the queue, a PR's page, the PR tab, the Review tab's own), the
 * session's Review tab shows it starting rather than "No review here yet" and another Review.
 */
export interface StartingReview {
  reviewer: string; repo: string | null; number: number; at: number;
  /** When each pane of the PR listed at the start last changed: none of those is the new review (a restart replaces one). */
  before: string[];
  /** What is happening before the review's pane is there: the start, or its box waking (the start route's held start). */
  step?: string;
  /** The start is still running (the box waking, the start call): the wait for its pane hasn't begun. */
  pending?: boolean;
  /** Why it couldn't start, and what to do: shown in the session's Review tab until dismissed. */
  error?: string;
  /** Which start this is: only its own steps change the entry (a later start replaces it). */
  id?: string;
  /** When the start route held it (the server's clock, from GET …/review/held): no pane it makes changed before. */
  heldSince?: number;
}
const starting = new Map<string, StartingReview>();
const startingListeners = new Set<() => void>();
const startingKey = (projectId: string, workstream: string) => `${projectId}|${workstream}`;
export function markStarting(projectId: string, workstream: string, s: StartingReview) {
  starting.set(startingKey(projectId, workstream), s);
  for (const fn of startingListeners) fn();
}
function patchStarting(projectId: string, workstream: string, id: string, patch: Partial<StartingReview>) {
  const key = startingKey(projectId, workstream);
  const now = starting.get(key);
  // Dismissed meanwhile, or replaced by a later start: this one goes on, but its steps aren't shown.
  if (!now || now.id !== id) return;
  starting.set(key, { ...now, ...patch });
  for (const fn of startingListeners) fn();
}
/**
 * A pane of the starting review's PR listed while its start is still pending (its box waking) that last changed
 * before the start was held: an earlier review's, restored as the box came back, not one this start made. Kept with
 * the panes listed at the start.
 */
export function noteStartingBefore(projectId: string, workstream: string, at: string) {
  const now = starting.get(startingKey(projectId, workstream));
  if (!now?.pending || now.before.includes(at)) return;
  starting.set(startingKey(projectId, workstream), { ...now, before: [...now.before, at] });
  for (const fn of startingListeners) fn();
}
/** The review starting in a session, or null (outside React: tests, the start's own steps). */
export function startingFor(projectId: string, workstream: string): StartingReview | null {
  return starting.get(startingKey(projectId, workstream)) ?? null;
}
export function clearStarting(projectId: string, workstream: string) {
  if (starting.delete(startingKey(projectId, workstream))) for (const fn of startingListeners) fn();
}
export function useStartingReview(projectId: string, workstream: string): StartingReview | null {
  return useSyncExternalStore(
    fn => { startingListeners.add(fn); return () => { startingListeners.delete(fn); }; },
    () => starting.get(startingKey(projectId, workstream)) ?? null,
    () => null,
  );
}
const nameOf = (id: ReviewerId) => REVIEWERS.find(r => r.id === id)!.name;

/** The clone's calls (chat/reviewClone.ts): the APIs, a timer, the clock. */
const CLONE_DEPS: CloneDeps = {
  listBoxes: () => instancesApi.list(),
  startBox: id => instancesApi.start(id),
  listProjects: () => projectsApi.list(),
  // A chat project, as New session makes one: the next review of the repository runs in it.
  createProject: d => projectsApi.create({ ...d, initialAgent: { enabled: true, provider: CHAT_PROVIDER_ID } }),
  retryClone: id => projectsApi.retryClone(id),
  sleep: ms => new Promise(resolve => { setTimeout(resolve, ms); }),
  now: () => Date.now(),
};

/** What GET …/review/held says of a start held while its box wakes (backend services/reviewHeld.ts). */
export interface HeldReviewView { state: 'waking' | 'starting' | 'failed'; box: string; error?: string; since?: number }

/** How often a held start's state is read while its box wakes. */
const HELD_POLL_MS = 3_000;

/**
 * A review started in its session: the page is already there, and the session's Review tab shows each step from
 * the starting store, or what went wrong. A start the route holds while it wakes the project's box (202, behind
 * box-wake-on-action-enabled on the server) is followed through GET …/review/held: "Waking <box>…", "Starting the
 * review…", then the wait for its pane, or the reason it failed. Dismissed meanwhile (the store's entry gone), it
 * stops following; the start itself goes on on the server.
 */
export async function runReviewStart(
  at: Pick<PrWorkstreamLink, 'projectId' | 'workstream'>, id: string,
  call: () => Promise<{ held?: boolean; box?: string }>,
  deps: { readHeld: () => Promise<HeldReviewView | null>; sleep: (ms: number) => Promise<void>; now: () => number },
): Promise<void> {
  const step = (patch: Partial<StartingReview>) => patchStarting(at.projectId, at.workstream, id, patch);
  try {
    const answer = await call();
    if (answer.held) {
      step({ step: `Waking ${answer.box ?? 'its box'}…` });
      for (;;) {
        await deps.sleep(HELD_POLL_MS);
        if (startingFor(at.projectId, at.workstream)?.id !== id) return;
        const held = await deps.readHeld().catch(() => undefined);
        // A failed read says nothing: read again. Nothing held: it ran (or a restart forgot it; the wait ends it).
        if (held === undefined) continue;
        if (held === null) break;
        if (held.state === 'failed') throw new Error(held.error ?? 'The review could not start');
        step({ step: held.state === 'starting' ? 'Starting the review…' : `Waking ${held.box}…`, ...(typeof held.since === 'number' ? { heldSince: held.since } : {}) });
      }
    }
    // Its pane is coming: the wait for it starts now.
    step({ pending: false, step: undefined, at: deps.now() });
  } catch (err) {
    step({ pending: false, step: undefined, error: err instanceof Error && !(err as { response?: unknown }).response ? err.message : apiErrorText(err, 'The review could not start') });
  }
}

/**
 * Under a Review button with nowhere to run: why, and what to do next, where its own tooltip can't say (a disabled
 * button shows none). It needs a project on the repository: New session on it makes one, on a new box if need be.
 * With the clone on, the only thing missing is a box to clone onto, and New session can make that too. A list that
 * couldn't be read (`projectsUnread`, `boxesUnread`) says so instead: "no project" or "no box" isn't known then.
 */
export function noRunReason(repo: string | undefined, cloneOn: boolean, boxesUnread = false, projectsUnread = false): string {
  const name = repo ? repo.split('/').pop() : null;
  if (!repo || !name) return 'Nowhere to run it';
  if (projectsUnread) return `Your projects couldn't be read to find one on ${name}. Reload the page to try again.`;
  if (cloneOn && boxesUnread) return `No project on ${name}, and your boxes couldn't be read to clone it onto. Reload the page to try again.`;
  return cloneOn
    ? `No project on ${name}, and no box to clone it on. Start a New session on ${repo} (it can make a box too), and Review runs there.`
    : `No project on ${name} yet. Start a New session on ${repo}, and Review runs there.`;
}

/**
 * Where to review a PR the pipeline has no target for (no box has said which
 * repository its checkouts are): main of the most recently active project
 * cloned from the PR's repository. `readyOnly` (with Review's clone on): not
 * one whose clone is still running or failed, which Review waits for or runs
 * again (chat/reviewClone.ts unreadyCloneOf) rather than starting in.
 */
export function cloneOf(repo: string, projects: readonly Project[], readyOnly = false): PrWorkstreamLink | null {
  const want = repo.toLowerCase();
  const hit = projects
    .filter(p => p.role !== 'collaborator' && p.repoUrl && repoOfCloneUrl(p.repoUrl) === want && (!readyOnly || cloneReady(p)))
    .sort((a, b) => (Date.parse(b.lastActiveAt ?? '') || 0) - (Date.parse(a.lastActiveAt ?? '') || 0))[0];
  return hit ? { projectId: hit.id, projectName: hit.name, workstream: 'main' } : null;
}

export interface ReviewMenuProps {
  repo?: string;
  number?: number;
  row?: PrRow | null;
  group?: PrReviewGroup;
  /** The page-wide default (the Reviews page's header): which reviewer Review starts. */
  defaults?: boolean;
  /** Review beside this session (its own PR), not the PR's review target. */
  here?: { projectId: string; workstream: string };
  /** Only the agent reviews (the Review tab's empty state). */
  agentOnly?: boolean;
  size?: 'small' | 'medium';
  label?: string;
}

/** A group plan cut to its open members, or why there's nothing left once the closed ones are out. */
export function openPlan(plan: ReturnType<typeof groupReviewPlan>): ReturnType<typeof groupReviewPlan> {
  if (!('members' in plan)) return plan;
  const members = plan.members.filter(m => m.state === 'open');
  return members.length ? { ...plan, members } : { reason: 'Nothing left to review in this group' };
}

export function ReviewMenu({ repo, number, row, group, defaults, here, agentOnly, size = 'medium', label }: ReviewMenuProps) {
  const navigate = useNavigate();
  const { projects, projectsLoaded, projectsLoadFailed, reloadProjects } = useProjects();
  const { queue, refresh, agentReviews } = useReviewsData();
  const reviewer = useSyncExternalStore(subscribePrefs, readReviewer, (): ReviewerId => 'devin');
  const kind = useSyncExternalStore(subscribePrefs, readKind, (): ReviewKind => 'agent');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const cloneOn = useFlag(FLAGS.reviewClone, false);
  // Review with Claude opens a chat: its review is the review session, made as the chat runner's Claude.
  const reviewChatOn = useFlag(FLAGS.reviewChat, false);
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  // Read as stores of their own: a failed fetch keeps the same list, so the list alone re-renders nothing.
  const boxesRead = useSyncExternalStore(boxFeed.subscribe, () => boxFeed.hasLoaded() || boxFeed.isFailing());
  const boxesFailing = useSyncExternalStore(boxFeed.subscribe, boxFeed.isFailing);
  const cloning = useReviewClone(repo);
  // This PR's clone-and-review, started from this tab and not yet handed over to its session (chat/reviewClone.ts).
  const cloneOutcome = useCloneOutcome(repo ?? '', number ?? -1);
  const cloneUnderWayHere = !!repo && number != null && !!cloneOutcome && 'pending' in cloneOutcome;
  // A start whose clone outlives this button (a minute or more) still starts the review, but doesn't move the page.
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const pick = (id: ReviewerId) => { writeReviewer(id); writeKind('agent'); };
  const pickSession = () => { writeKind('session'); };

  if (defaults) {
    // With review chats on, a review session is Claude's review: one choice, Claude.
    const chosen = kind === 'session' ? (reviewChatOn ? 'claude' : 'session') : reviewer;
    const chosenName = chosen === 'session' ? 'A session' : nameOf(chosen);
    return (
      <span className="rv-default">
        <span className="rv-default-label" aria-hidden="true">Reviewer</span>
        <MenuTrigger>
          <Button variant="minimal" size="small" aria-label={`Review starts: ${chosen === 'session' ? 'a session' : chosenName}`}>{chosenName}<Icon name="chevron-down" size="small" aria-hidden="true" /></Button>
          <Popover placement="bottom end" className={`${LP_THEME} chat-menu-popover`}>
            <Menu aria-label="Reviewer" selectionMode="single" selectedKeys={new Set([chosen])}
              onSelectionChange={keys => { const k = [...(keys as Set<string>)][0]; if (k === 'session') pickSession(); else if (k) pick(k as ReviewerId); }}>
              {!reviewChatOn && (
                <MenuItem id="session" textValue="A review session">
                  <Text slot="label">A review session</Text>
                  <Text slot="description">Claude on a checkout of the PR, in a chat; you post</Text>
                </MenuItem>
              )}
              {REVIEWERS.map(r => (
                <MenuItem key={r.id} id={r.id} textValue={r.name}>
                  <Text slot="label">{r.name}</Text>
                  <Text slot="description">{reviewChatOn && REVIEW_CHAT_PROVIDERS[r.id] ? (REVIEW_CHAT_ENGINES[r.id] ? CHAT_REVIEW_NOTE_WHERE_IT_RUNS : CHAT_REVIEW_NOTE) : r.note}</Text>
                </MenuItem>
              ))}
            </Menu>
          </Popover>
        </MenuTrigger>
      </span>
    );
  }

  // Where the review runs: beside this session, the PR's review target, or (a group) the plan's pane.
  // The lab's plan over the whole group, so a merged or closed member's checkout can still hold the review; then
  // only its open members, what the card counts as left (chat/reviews.ts leftToReview): a closed PR isn't reviewed.
  const plan = group ? openPlan(groupReviewPlan(group, queue.viewer)) : null;
  const target: PrWorkstreamLink | null = here
    ? { ...here, projectName: projects.find(p => p.id === here.projectId)?.name ?? '' }
    : plan && 'target' in plan ? plan.target : row?.reviewTarget ?? (repo ? cloneOf(repo, projects, cloneOn) : null);
  // A single PR on a repository none of your projects has ready: cloned on a box first (chat/reviewClone.ts), with
  // the flag. A project on it whose clone is still running or failed is waited for, or cloned again, instead.
  // Only once the project list has been read: before then (or when it failed) "no project on it" isn't known.
  const cloneCase = cloneOn && projectsLoaded && !target && !group && !here && !!repo && number != null;
  const unready = cloneCase ? unreadyCloneOf(repo!, projects) : null;
  const boxPick = cloneCase && !unready ? reviewCloneBox(boxes, projects) : null;
  // "No project" is only known once the project list has been read, and "no box" once the box list has (or either
  // failed, which the note says): a PR page opened at its URL says nothing until then.
  const projectsRead = projectsLoaded || !!projectsLoadFailed;
  const listed = projectsRead && (!cloneCase || boxesRead);
  const clonePick = unready != null || boxPick != null;
  const why = !target && !clonePick ? (plan && 'reason' in plan ? plan.reason : `No project on ${repo ?? 'this repository'} to run it in`) : null;
  const cloneWhere = unready ? (unready.setupStatus === 'failed' ? `${unready.name}, its failed clone run again` : `${unready.name}, once its clone finishes`)
    : boxPick ? `a new project on ${boxPick.box.name}${boxPick.wake ? ' (woken first)' : ''}` : null;
  // Where the repo's template is read from: a checkout of the PR (its review target, the session's own, a group's
  // pane) rather than main of a clone that only shares the repository (cloneOf).
  const onPrBranch = !!here || !!plan || !!row?.reviewTarget;
  const where = target ? (target.workstream === 'main' ? target.projectName : `${target.projectName} · ${target.workstream}`) : null;
  const prNumber = group && plan && 'members' in plan ? plan.members[0].number : number;
  const prRepo = group && plan && 'members' in plan ? plan.members[0].repo : repo ?? null;
  // A review session needs a project whose checkout is the PR's repository (the lab's PR workstream route).
  const sessionProject = !group && repo ? (row?.reviewTarget ?? cloneOf(repo, projects, cloneOn)) : null;
  const prUrl = group && plan && 'members' in plan ? plan.members[0].url : repo && number != null ? `https://github.com/${repo}/pull/${number}` : null;
  // Where each review chat goes (chatPlaces): one PR's, or each open member's of a group.
  const places = reviewChatOn ? chatPlaces({ here, group, members: group ? reviewChatMembers(group, queue.viewer) : null, repo, number, row, sessionProject, projects }) : [];
  // Review with Claude or Cursor is a chat (the review session, as that reviewer's chat-runner provider,
  // REVIEW_CHAT_PROVIDERS), wherever Review is: a PR's, beside a session on its own PR (`here`, the Review tab too),
  // and each member of a group, one chat each, since a review card posts to its own session's PR (chatPlaces). Where
  // no chat can go but a pane can (a multi-repo project's session, whose branch-off spans its repositories), the
  // pane, as with review chats off (Bugbot).
  const reviewChats = reviewChatsHere(reviewChatOn, places.length, clonePick, !!target);
  // The boxes the chats would run on: each place's project's, else the clone's (the project still cloning, or the box
  // picked for one). Devin's review is a chat only where each one's agent says it runs Devin (REVIEW_CHAT_ENGINES).
  const chatBoxes = places.length > 0
    ? places.map(p => projects.find(x => x.id === p.at?.projectId)?.instanceId)
    : clonePick ? [unready?.instanceId ?? boxPick?.box.id] : [];
  const chats = (id: ReviewerId) => reviewChats && !!REVIEW_CHAT_PROVIDERS[id] && reviewChatOnBoxes(id, chatBoxes, boxes);
  // A chat with nowhere to check the PR out: its button and menu items are off, never a click that does nothing.
  const chatNowhere = reviewChats && places.length === 0 && !clonePick;
  // The reviewer Review starts: a stored "A review session" is Claude while review chats are on, everywhere (as the
  // page-wide picker shows it): its chat where Claude's review is one, else Claude's pane (beside a session on its PR).
  const chosen: ReviewerId = reviewChatOn && kind === 'session' ? 'claude' : reviewer;

  // The project cloned for this PR's repository, listed before the review starts in it (and after a failure, so
  // the next Review finds the project this one made rather than making another).
  const cloned = async (): Promise<ClonedProject> => {
    try {
      return await cloneFor(repo!, boxPick, CLONE_DEPS);
    } finally {
      await reloadProjects().catch(() => {});
    }
  };
  const linkOf = (c: ClonedProject): PrWorkstreamLink => ({ projectId: c.projectId, projectName: c.projectName, workstream: 'main' });

  // A review in a project that's there opens its session at once: the session's Review tab shows the review starting
  // (and its box waking, when the start route holds it for that), or what went wrong; this button never waits.
  // Marks the review starting in `at` and runs its start there (runReviewStart); the session's Review tab shows it.
  const beginReviewIn = (at: PrWorkstreamLink, id: ReviewerId, pr: number, prompt?: string) => {
    const startId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const before = agentReviews.filter(a => a.projectId === at.projectId && a.workstream === at.workstream && a.number === pr).map(a => a.at ?? '');
    markStarting(at.projectId, at.workstream, { reviewer: nameOf(id), repo: prRepo, number: pr, at: Date.now(), before, pending: true, step: 'Starting the review…', id: startId });
    void runReviewStart(at, startId, () => reviewApi.start(at.projectId, {
      workstream: at.workstream, pr, url: prUrl, reviewer: id, slot: 1,
      ...(prompt ? { prompt } : {}),
      ...(group && plan && 'members' in plan ? { group: groupReviewBody(group, plan.members) } : {}),
    }), { readHeld: () => reviewApi.held(at.projectId, at.workstream), sleep: CLONE_DEPS.sleep, now: CLONE_DEPS.now }).then(refresh);
  };
  const startInSession = (at: PrWorkstreamLink, id: ReviewerId, pr: number, prompt?: string) => {
    const open = () => startTransition(() => navigate(chatHref(at.projectId, at.workstream), { state: { panelTool: 'review' } }));
    // One start at a time per session: a second Review while one is under way shows that one.
    if (startingFor(at.projectId, at.workstream)?.pending) { open(); return; }
    setError(null); pick(id);
    beginReviewIn(at, id, pr, prompt);
    open();
  };
  // The clone path (no project on the repository yet): the page moves at once to the one that waits on the clone
  // (ReviewCloneStart), which shows its steps and hands over to the session through the clone's outcome.
  const waitForClone = (r: string, pr: number) => {
    noteCloneOutcome(r, pr, { pending: true });
    startTransition(() => navigate(cloneStartHref(r, pr)));
  };
  // One clone-and-review per PR at a time in this tab: a second Review (back on this page) while one is under way
  // shows that one's page rather than starting the review, or making the session, twice. Another tab has its own:
  // its clone reads the projects afresh first (cloneForReview), so it finds the project this one made, once listed.
  const cloneUnderWay = (r: string, pr: number) => {
    const outcome = cloneOutcomeFor(r, pr);
    // Done (its session made) while its wait page wasn't open to hand over: forgotten, and this Review goes on as
    // any other does (one into a session whose start is still under way shows that start).
    if (outcome && 'to' in outcome) { noteCloneOutcome(r, pr, null); return false; }
    if (!outcome || !('pending' in outcome)) return false;
    startTransition(() => navigate(cloneStartHref(r, pr)));
    return true;
  };
  const failText = (err: unknown, fallback: string) => (err instanceof Error && !(err as { response?: unknown }).response ? err.message : apiErrorText(err, fallback));

  const start = async (id: ReviewerId, prompt?: string) => {
    // A chat reviewer's review: `prompt` is then Edit the prompt's body as it showed it.
    if (chats(id)) { if (!chatNowhere) await startSession(prompt, id); return; }
    if ((!target && !clonePick) || prNumber == null) return;
    // Before any other path: a clone this tab started for the PR may already list its project (a pane clone says
    // it's done before its checkout lands), and a second Review then belongs to that clone's wait page.
    if (repo && !group && cloneUnderWay(repo, prNumber)) return;
    if (target) { startInSession(target, id, prNumber, prompt); return; }
    if (!repo) return;
    setError(null); pick(id);
    waitForClone(repo, prNumber);
    try {
      const at = linkOf(await cloned());
      beginReviewIn(at, id, prNumber, prompt);
      noteCloneOutcome(repo, prNumber, { to: { projectId: at.projectId, workstream: at.workstream, state: { panelTool: 'review' } } });
    } catch (err) {
      noteCloneOutcome(repo, prNumber, { error: failText(err, 'The review could not start') });
    }
  };

  // `body`: Edit the prompt's, for a review chat (reviewChatPrompt); else the lab's PR prompt. `who`: whose chat it
  // is, with review chats on (Claude, as a stored "A review session" is). With review chats on, each place
  // (chatPlaces) gets its chat: one PR's, or each open member's of a group, opened one after another on the
  // review-start page of the first, which then hands over to the first's chat.
  const startSession = async (body?: string, who: ReviewerId = 'claude') => {
    const provider = reviewChats ? REVIEW_CHAT_PROVIDERS[who] ?? CHAT_PROVIDER_ID : undefined;
    const todo: ChatPlace[] = reviewChats ? places : sessionProject && repo && number != null ? [{ repo, number, row: row ?? null, at: sessionProject, copyOf: null }] : [];
    const first = todo[0] ?? (repo && number != null ? { repo, number, row: row ?? null, at: null, copyOf: null } : null);
    if (!first || (todo.length === 0 && !clonePick)) return;
    const { repo: r, number: n } = first;
    // A clone this tab started for the PR, its project listed or not: its wait page (above).
    if (cloneUnderWay(r, n)) return;
    // A clone first: the wait page shows it; a project that's there: this button, for the branch it makes. A review
    // chat opens the wait page either way, so the button never waits: its box waking and the checkout show there,
    // then the chat.
    const cloning = todo.length === 0;
    const waitPage = cloning || reviewChats;
    if (waitPage) waitForClone(r, n); else setBusy(true);
    setError(null);
    if (reviewChats) pick(REVIEW_CHAT_PROVIDERS[who] ? who : 'claude'); else pickSession();
    let stepShown = false;
    let fresh: ClonedProject | null = null;
    try {
      fresh = cloning ? await cloned() : null;
      const made = fresh;
      const jobs: ChatPlace[] = made ? [{ ...first, at: linkOf(made) }] : todo;
      let opened: { link: PrWorkstreamLink; state: Record<string, unknown> } | null = null;
      const woken = new Set<string>();
      const wakeFailed = new Map<string, unknown>();
      // A group's members one after another: one that fails doesn't stop the rest, and says so after (failed).
      const failed: string[] = [];
      const madeNow: string[] = [];
      for (const [i, job] of jobs.entries()) {
        const at = job.at!;
        const of = jobs.length > 1 ? ` (${i + 1} of ${jobs.length})` : '';
        // Only a group's start keeps what it made for its next Review all (madeReviewChats); a PR's start is one chat.
        const key = group && jobs.length > 1 ? madeKey(group.id, at.projectId, job.repo, job.number) : null;
        const before = key ? madeReviewChats.get(key) : undefined;
        if (key && before) { madeNow.push(key); if (!opened) opened = { link: before, state: { panelTool: 'pr' } }; continue; }
        try {
          if (reviewChats && !fresh) {
            // A project that's there, on a box that may be asleep: woken first (the create route refuses a parked box).
            const boxId = projects.find(p => p.id === at.projectId)?.instanceId;
            if (boxId && !woken.has(boxId)) {
              woken.add(boxId);
              try {
                await wakeProjectBox(boxId, CLONE_DEPS, box => { stepShown = true; noteCloneStep(r, { repo: r, box, phase: 'box', number: n }); });
              } catch (err) { wakeFailed.set(boxId, err); }
            }
            // A box that wouldn't wake: every member on it fails for that reason, not the create route's parked box.
            if (boxId && wakeFailed.has(boxId)) throw wakeFailed.get(boxId);
          }
          if (reviewChats) { stepShown = true; noteCloneStep(r, { repo: job.repo, box: '', phase: 'session', number: job.number, projectName: `${at.projectName}${of}` }); }
          // Read from GitHub when the pipeline hasn't listed it (a pasted or ⌘K PR): its branch, which names the session
          // as the lab does, and its title and author, which the mark keeps so a session on your own PR isn't a review.
          const read = job.row?.headRefName && job.row.author ? null : await prsApi.overview(job.repo, job.number).catch(() => null);
          const branch = job.row?.headRefName || read?.headRefName || '';
          // Where the PR's branch is checked out in the project already, the chat gets a branch of its own (copyOf), since
          // git allows a branch in one worktree only: known only now for a PR the pipeline lists no branch for (pasted,
          // ⌘K), whose place chatPlaces chose before GitHub said.
          const inProject = projects.find(p => p.id === at.projectId)?.workstreams ?? [];
          const copyOf = copyOfAt(job.copyOf, branch, inProject);
          // The next free name in the project: a second session on the PR, or one after an archived one, would hit the
          // create route's conflict (names stay taken while archived). A branch of its own off a session's says so.
          const taken = inProject.map(w => w.name);
          const base = suggestWorkstreamName(job.repo, job.number, branch || `pr${job.number}`);
          const name = uniqueName(copyOf ? `${base}-review` : base, taken);
          // A copy of your own PR's session leaves the PR's link on that session (its PR tab, merge panel and Review tab
          // are the PR's), as a review of your own PR is never a review session. Someone else's moves to this review.
          const author = job.row?.author ?? read?.author ?? null;
          const yours = !!author && !!queue.viewer && author.toLowerCase() === queue.viewer.toLowerCase();
          // A box that types the clone into its pane says it's done before the checkout lands: the branch off it waits.
          const created = await untilCheckedOut(
            () => prsApi.newWorkstream(job.repo, job.number, at.projectId, name, undefined, provider, copyOf ?? undefined, !!copyOf && yours), fresh?.pane ?? false, CLONE_DEPS,
            () => noteCloneStep(r, { repo: r, box: '', phase: 'checkout', projectName: at.projectName }));
          // The chat runner drops a workstream's first prompt (it has no promptLaunch). It waits in the chat's own
          // first-message queue, as New session's does (chat/newChat.ts): the session's view sends it once, when
          // its runner is up, after a reload or from another tab too. Storage refusing it leaves it as the draft.
          // A review chat's reviewer is read-only on the PR's checkout (every engine): it gets the PR's diff with its prompt,
          // since it can't ask git or gh what changed (reviewDiffBlock). Each place its own PR's; without one (GitHub
          // couldn't say), the prompt alone.
          const asked = reviewChats && body !== undefined && jobs.length === 1 ? reviewChatPrompt(job.repo, job.number, body) : reviewSessionPrompt(job.repo, job.number);
          const diff = reviewChats ? await prsApi.files(job.repo, job.number).then(d => reviewDiffBlock(prShort(job.repo, job.number), d), () => null) : null;
          // Never past what a send takes (REVIEW_SEND_MAX): a prompt that long goes without the diff rather than not at all.
          const prompt = diff && asked.length + diff.length <= REVIEW_SEND_MAX ? `${asked}${diff}` : asked;
          const held = writeQueued(browserStore(), queueKey(at.projectId, created.name), prompt);
          markReviewSession(
            { projectId: at.projectId, projectName: at.projectName, workstream: created.name },
            {
              repo: job.repo, number: job.number,
              title: (job.row?.title && job.row.title !== prShort(job.repo, job.number) ? job.row.title : null) ?? read?.title ?? prShort(job.repo, job.number),
              author: job.row?.author ?? read?.author ?? null, url: job.row?.url ?? `https://github.com/${job.repo}/pull/${job.number}`,
            },
          );
          const link = { projectId: at.projectId, projectName: at.projectName, workstream: created.name };
          if (key) { madeReviewChats.set(key, link); madeNow.push(key); }
          if (!opened) opened = { link, state: { panelTool: 'pr', ...(held ? {} : { draft: prompt }) } };
        } catch (err) {
          // One member's chat only: the others go on. Alone, it's the start's own failure.
          if (jobs.length === 1) throw err;
          failed.push(`${prShort(job.repo, job.number)}: ${failText(err, 'its chat could not start')}`);
        }
      }
      if (stepShown || fresh?.pane) noteCloneStep(r, null);
      // Listed before the page moves, and marked review sessions until the pipeline reads their links back, so they
      // open as reviews (useReviewOf) on their first paint; after a failed member too, so the ones made show.
      await reloadProjects().catch(() => {});
      refresh();
      if (failed.length) {
        throw new Error(`${failed.join('; ')}${opened ? '. The other chats are open in the sidebar: Review all again opens them and tries the rest.' : ''}`);
      }
      for (const k of madeNow) madeReviewChats.delete(k);
      if (!opened) throw new Error('Nowhere to check the PR out');
      const { link, state } = opened;
      if (waitPage) noteCloneOutcome(r, n, { to: { projectId: link.projectId, workstream: link.workstream, state } });
      else if (live.current) startTransition(() => navigate(chatHref(link.projectId, link.workstream), { state }));
    } catch (err) {
      if (stepShown || fresh?.pane) noteCloneStep(r, null);
      const text = failText(err, 'The review session could not start');
      if (waitPage) noteCloneOutcome(r, n, { error: text }); else setError(text);
    } finally {
      if (!waitPage) setBusy(false);
    }
  };

  // A review session is a new checkout, so not for a group, nor from the Review tab, which fills its own pane (agentOnly).
  const sessionOk = !group && !agentOnly;
  // With review chats off, a stored "A review session" is the session, as before; on, Claude's and Cursor's reviews
  // are, wherever a place is (chatPlaces), and a stored session is Claude's (chosen).
  const asSession = (kind === 'session' && !reviewChatOn && sessionOk && (sessionProject != null || clonePick))
    || (chats(chosen) && (places.length > 0 || clonePick));
  const primary = label ?? (group ? `Review all with ${nameOf(chosen)}` : asSession ? (reviewChats ? `Review with ${nameOf(chosen)}` : 'Review in a session') : `Review with ${nameOf(chosen)}`);
  // A clone this tab started leaves Review pressable: it opens that clone's wait page again (cloneUnderWay).
  const working = busy || (cloning != null && !cloneUnderWayHere);
  const cloneLead = unready
    ? (unready.setupStatus === 'failed' ? `${unready.name}'s clone of ${repo} failed: termag clones it again` : `${unready.name} is still cloning ${repo}: termag waits for it`)
    : `No project on ${repo} yet: termag clones it into ${cloneWhere}`;
  const mainOff = (asSession ? false : (!target && !clonePick) || (chats(chosen) && chatNowhere)) || working;
  // Where the chat goes, for the tooltip and the menu: off a session's branch, or a project's new checkout.
  const placeWhere = places.length > 1 ? `${places.length} chats, one per PR`
    : places[0]?.at ? (places[0].copyOf ? `a branch off ${places[0].at.workstream === 'main' ? places[0].at.projectName : `${places[0].at.projectName} · ${places[0].at.workstream}`}` : places[0].at.projectName) : null;
  const tip = asSession
    ? (reviewChats && placeWhere ? `A chat with ${nameOf(chosen)}, in ${placeWhere}. ${nameOf(chosen)} reads it; you post.`
      : sessionProject ? `${reviewChats ? `A chat with ${nameOf(chosen)}` : 'A new session'} on the PR's branch, in ${sessionProject.projectName}. ${reviewChats ? nameOf(chosen) : 'Claude'} reads it; you post.`
        : `${cloneLead}, then opens ${reviewChats ? `a chat with ${nameOf(chosen)}` : 'a session'} on the PR's branch there. ${reviewChats ? nameOf(chosen) : 'Claude'} reads it; you post.`)
    : why ?? (target ? `In ${where}. ${REVIEWERS.find(r => r.id === chosen)!.note}.`
      : `${cloneLead}, then ${nameOf(chosen)} reviews it there.`);
  return (
    <span className="rv-menu">
      <ButtonGroup className="rv-split" aria-label={`Review ${repo && number != null ? prShort(repo, number) : group?.name ?? ''}`}>
        <TooltipTrigger delay={400}>
          <Button size={size} variant="default" isDisabled={mainOff} onPress={() => { void (asSession ? startSession(undefined, chosen) : start(chosen)); }} className="rv-split-main">
            <Icon name="preview" size="small" aria-hidden="true" />{cloning ? 'Cloning…' : busy ? 'Starting…' : primary}
          </Button>
          <Tooltip placement="bottom" className={LP_THEME}>{tip}</Tooltip>
        </TooltipTrigger>
        <MenuTrigger>
          <IconButton icon="chevron-down" size={size} variant="default" aria-label="More ways to review" isDisabled={(!target && !sessionProject && !clonePick && places.length === 0) || working} className="rv-split-more" />
          <Popover placement="bottom end" className={`${LP_THEME} chat-menu-popover`}>
            <Menu aria-label="Review" onAction={key => {
              const k = String(key);
              if (k === 'edit') setEditing(true);
              else if (k === 'session') void startSession();
              else if (k === 'devin' || k === 'claude' || k === 'cursor') void start(k);
            }} disabledKeys={[
              ...(!sessionProject && !clonePick ? ['session'] : []),
              // No pane: only the reviewers whose chat has somewhere to go (chatPlaces), a group's without a pane too.
              ...(!target && !clonePick ? REVIEWERS.filter(r => !(chats(r.id) && places.length > 0)).map(r => r.id)
                : chatNowhere ? REVIEWERS.filter(r => chats(r.id)).map(r => r.id) : []),
              ...(!target ? ['edit'] : []),
            ]}>
              {sessionOk && !reviewChats && (
                <MenuItem id="session" textValue="Review in a new session">
                  <Icon name="chat-bubble-outline" size="medium" aria-hidden="true" />
                  <Text slot="label">Review in a new session</Text>
                  <Text slot="description">{sessionProject ? `Claude on the PR's branch, in ${sessionProject.projectName}. You talk it through and post.`
                    : clonePick ? `Claude on the PR's branch, in ${cloneWhere}. You talk it through and post.` : `No project on ${repo} to check it out in`}</Text>
                </MenuItem>
              )}
              {sessionOk && !reviewChats && <Separator />}
              {REVIEWERS.map(r => (
                <MenuItem key={r.id} id={r.id} textValue={`Review with ${r.name}`}>
                  <Icon name={chats(r.id) ? 'chat-bubble-outline' : 'robot'} size="medium" aria-hidden="true" />
                  <Text slot="label">{group ? `Review all with ${r.name}` : `Review with ${r.name}`}</Text>
                  <Text slot="description">{chats(r.id) ? reviewChatWhere(placeWhere, cloneWhere, repo ?? group?.name)
                    : <>{where ? `In ${where}. ` : cloneWhere ? `In ${cloneWhere}. ` : ''}{r.note}</>}</Text>
                </MenuItem>
              ))}
              {!group && <Separator />}
              {!group && (
                <MenuItem id="edit" textValue="Edit the prompt">
                  <Icon name="edit" size="medium" aria-hidden="true" />
                  <Text slot="label">Edit the prompt…</Text>
                  <Text slot="description">See the whole prompt first, and add a note for this one</Text>
                </MenuItem>
              )}
            </Menu>
          </Popover>
        </MenuTrigger>
      </ButtonGroup>
      {cloning && <span className="rv-menu-note" role="status">{cloneProgressText(cloning)}</span>}
      {!working && mainOff && listed && <span className="rv-menu-note">{group && why ? why : noRunReason(repo, cloneOn, boxesFailing && boxes.length === 0, !projectsLoaded && !!projectsLoadFailed)}</span>}
      {error && <span className="rv-menu-error" role="alert">{error}</span>}
      {editing && target && repo && number != null && (
        <PromptDialog target={target} repo={repo} number={number} reviewer={chosen} onPrBranch={onPrBranch} chats={id => places.length > 0 && chats(id)} onClose={() => setEditing(false)}
          onStart={(id, prompt) => { setEditing(false); void start(id, prompt); }} />
      )}
    </span>
  );
}

/**
 * Review chats a group's start made while another of its members failed (startSession), by group, project and PR:
 * that group's Review all again opens those instead of making them twice, and makes only the rest. Dropped once its
 * start makes every one; a single PR's Review never reads or writes them, so it makes a session of its own as before.
 */
const madeReviewChats = new Map<string, PrWorkstreamLink>();
const madeKey = (groupId: string, projectId: string, repo: string, number: number) => `${groupId}|${projectId}|${repo.toLowerCase()}#${number}`;

/**
 * The members of a group a review chat goes to: the open ones left to review (the card's count), whether or not one
 * has a pane, since each chat checks its PR out on its own (chatPlaces), unlike the pane review, which needs one.
 */
export function reviewChatMembers(group: PrReviewGroup, viewer: string | null): PrGroupMember[] {
  return toReview(group, viewer).filter(m => m.state === 'open');
}

/**
 * One review chat to open: the PR, and where it goes. `at` holds a checkout of the PR's branch already (`copyOf`, its
 * workstream: the chat gets a branch of its own off it, with that session's access, since git allows a branch in one
 * worktree only), or is a project on the PR's repository (a new checkout of the PR's branch).
 */
export interface ChatPlace { repo: string; number: number; row: PrRow | null; at: PrWorkstreamLink | null; copyOf: string | null }

/**
 * Where review chats go with review chats on. Beside a session on its own PR (`here`): a branch off that session's.
 * A group: each open member's own chat, so each card posts to its own PR (a card posts to its session's PR, not the
 * one its fence names): off the checkout that member's pane or review target has when it is on the member's branch,
 * else a new checkout in a project on its repository. A PR: off its review target when that is on the PR's branch,
 * else a new checkout there. A member, or a PR, with nowhere is left out. A multi-repo project's branch-off spans its
 * repositories, so it's never a copy's source.
 */
export function chatPlaces(o: {
  here?: { projectId: string; workstream: string }; group?: PrReviewGroup; members?: readonly PrGroupMember[] | null;
  repo?: string; number?: number; row?: PrRow | null; sessionProject: PrWorkstreamLink | null; projects: readonly Project[];
}): ChatPlace[] {
  const projectOf = (id: string) => o.projects.find(p => p.id === id);
  const copyable = (link: PrWorkstreamLink | null | undefined, branch?: string | null): link is PrWorkstreamLink => {
    if (!link || projectOf(link.projectId)?.layout === 'workspace') return false;
    if (branch === undefined) return true;
    return !!branch && projectOf(link.projectId)?.workstreams?.find(w => w.name === link.workstream)?.branch === branch;
  };
  const named = (link: PrWorkstreamLink): PrWorkstreamLink => ({ ...link, projectName: link.projectName || projectOf(link.projectId)?.name || '' });
  if (o.group) {
    return (o.members ?? []).flatMap((m): ChatPlace[] => {
      const own = m.pane ?? m.row?.reviewTarget ?? null;
      // Off the member's pane or review target when that is on its branch; else a checkout in that session's project
      // (startSession copies there too once the branch shows checked out, for a member the pipeline lists no branch for).
      if (copyable(own, m.row?.headRefName ?? null)) return [{ repo: m.repo, number: m.number, row: m.row ?? null, at: named(own), copyOf: own.workstream }];
      if (copyable(own)) return [{ repo: m.repo, number: m.number, row: m.row ?? null, at: named(own), copyOf: null }];
      const project = cloneOf(m.repo, o.projects, true);
      return project ? [{ repo: m.repo, number: m.number, row: m.row ?? null, at: project, copyOf: null }] : [];
    });
  }
  if (!o.repo || o.number == null) return [];
  const row = o.row ?? null;
  if (o.here) {
    const at = named({ ...o.here, projectName: '' });
    return copyable(at) ? [{ repo: o.repo, number: o.number, row, at, copyOf: at.workstream }] : [];
  }
  if (!o.sessionProject) return [];
  const copy = copyable(o.sessionProject, row?.headRefName ?? null);
  return [{ repo: o.repo, number: o.number, row, at: o.sessionProject, copyOf: copy ? o.sessionProject.workstream : null }];
}

/**
 * Whether Review with Claude or Cursor is a chat here (simple-ui-review-chat-enabled): wherever a chat can go
 * (chatPlaces) or a clone can make one, and where there's no pane either. Where no chat can go but a pane can (a
 * multi-repo project's session, whose branch-off spans its repositories), the pane, as with review chats off.
 */
export function reviewChatsHere(on: boolean, places: number, clonePick: boolean, paneTarget: boolean): boolean {
  return on && (places > 0 || clonePick || !paneTarget);
}

/**
 * The workstream a review chat's checkout copies (`copyOf`, a branch of its own) once the PR's branch is known: the
 * one chatPlaces chose, else the project's workstream on that branch already (git allows a branch in one worktree
 * only), else none (a checkout of the PR's branch).
 */
export function copyOfAt(chosen: string | null, branch: string, workstreams: ReadonlyArray<{ name: string; branch?: string | null }>): string | null {
  if (chosen) return chosen;
  return branch ? workstreams.find(w => w.branch === branch)?.name ?? null : null;
}

/** A review chat in the menu: where its checkout goes, and that you post. `where`: a project, or a branch off a session's. */
export function reviewChatWhere(where: string | null, cloneWhere: string | null, repo: string | undefined): string {
  if (where?.startsWith('a branch off ') || where?.endsWith('one per PR')) return `In ${where}. You talk it through and post.`;
  if (where) return `A chat on the PR's branch, in ${where}. You talk it through and post.`;
  if (cloneWhere) return `A chat on the PR's branch, in ${cloneWhere}. You talk it through and post.`;
  return `No project on ${repo ?? 'this repository'} to check it out in`;
}

function PromptDialog({ target, repo, number, reviewer, onPrBranch, chats, onClose, onStart }: {
  target: PrWorkstreamLink; repo: string; number: number; reviewer: ReviewerId;
  /** The review runs in a checkout of the PR's own branch, where a repo template is the author's to change. */
  onPrBranch: boolean;
  /** Whether a reviewer's review is a chat here (simple-ui-review-chat-enabled, and its box runs its engine): a chat
   *  reviewer gets the body as shown, and no sign-off line. */
  chats: (id: ReviewerId) => boolean;
  onClose: () => void; onStart: (id: ReviewerId, prompt: string | undefined) => void;
}) {
  const url = `https://github.com/${repo}/pull/${number}`;
  const [guess, setGuess] = useState<ReviewGuessResponse | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [who, setWho] = useState<ReviewerId>(reviewer);
  useEffect(() => {
    let live = true;
    reviewApi.guess(target.projectId, target.workstream).then(g => { if (live) setGuess(g); }, err => { if (live) setFailed(apiErrorText(err, 'Could not read the prompt template')); });
    return () => { live = false; };
  }, [target.projectId, target.workstream]);
  const repoTemplate = templateForRepo(repo, guess?.promptTemplates);
  const template = repoTemplate?.template ?? guess?.promptTemplate ?? '';
  const source = repoTemplate?.source ?? guess?.promptSource ?? 'builtin';
  const sourceLabel = repoTemplate?.label ?? guess?.promptSourceLabel ?? null;
  const shown = body ?? renderReviewTemplate(template, number, url);
  const footer = guess?.reviewers?.find(r => r.id === who)?.footer ?? guess?.promptFooter ?? '';
  const chat = chats(who);
  return (
    <ModalOverlay isOpen isDismissable onOpenChange={open => { if (!open) onClose(); }} className={LP_THEME}>
      <Modal size="large" className="rv-confirm">
        <Dialog className="rv-confirm-dialog rv-prompt-dialog">
          <Heading slot="title" level={2} size="medium">Review {prShort(repo, number)}</Heading>
          <Text elementType="p" slot="subtitle">The whole prompt the reviewer gets. Only the middle is yours to change, for this review.</Text>
          <ToggleButtonGroup aria-label="Reviewer" appearance="elevated" selectionMode="single" disallowEmptySelection
            selectedKeys={new Set([who])} onSelectionChange={keys => { const k = [...keys][0] as ReviewerId | undefined; if (k) setWho(k); }} className="rv-prompt-who">
            {REVIEWERS.map(r => <ToggleButton key={r.id} id={r.id} size="small">{r.name}</ToggleButton>)}
          </ToggleButtonGroup>
          <pre className="rv-prompt-fixed">{reviewPromptHeader(number, url)}</pre>
          <TextField aria-label="Review prompt" value={guess ? shown : ''} onChange={setBody} isDisabled={!guess} className="rv-prompt-field">
            <TextArea className="rv-prompt-body" rows={7} />
          </TextField>
          {chat
            ? <p className="rv-prompt-source">Then termag asks {nameOf(who)} for its findings as a review card, and to post nothing: you post from the card, in the chat.</p>
            : <pre className="rv-prompt-fixed">{footer}</pre>}
          <p className="rv-prompt-source">
            {failed ?? (!guess ? 'Reading the prompt template…'
              : source === 'repo' && onPrBranch ? <><Icon name="warning" size="small" aria-hidden="true" /> From {sourceLabel ?? '.termag/review-prompt.md'}, on the PR's own branch: its author can change it. Read it before it runs.</>
              : source === 'repo' ? `From ${sourceLabel ?? '.termag/review-prompt.md'}, in ${target.projectName}'s checkout of the repository.`
              : source === 'home' ? `From ${sourceLabel ?? 'your dotfiles'}.`
              : 'The lab\'s built-in prompt.')}
          </p>
          <ButtonGroup className="rv-confirm-buttons">
            {body !== null && <Button variant="minimal" onPress={() => setBody(null)}>Reset</Button>}
            <Button variant="minimal" onPress={onClose}>Cancel</Button>
            <Button variant="primary" isDisabled={!guess} onPress={() => onStart(who, chat ? shown : body !== null && body !== renderReviewTemplate(template, number, url) ? body : undefined)}>
              Review with {nameOf(who)}
            </Button>
          </ButtonGroup>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
