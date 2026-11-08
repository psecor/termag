// Review a PR whose repository none of your projects has:
// termag clones the repository
// into a new project on one of your boxes, waits for the clone, and hands the
// project back for the review to start in. Behind simple-ui-review-clone-enabled.
//
// The box: the one your most recently active project is on, when it's up, else
// any of yours that is up or coming up, else one starting, else the most recent
// asleep one, woken first. A project is only made on a box that answers (the
// create route refuses a stopped or starting one, 409). The project is a chat
// project, named for the repository and kept: the next review of that
// repository runs in it (ReviewMenu's cloneOf), as it would in a project you
// had made by hand.
//
// A project on the repository whose clone hasn't finished (still cloning, or a
// page reloaded mid-clone) or failed is not a review target (cloneOf skips it,
// unreadyCloneOf finds it): Review waits for its clone, or runs a failed one
// again, rather than starting in an empty checkout or making a second project.
//
// One clone per repository at a time: a second Review on the same repository,
// from another row or tab of this page, waits on the first (cloneFor). Its
// progress is a small store the Review buttons read (useReviewClone).
import { useSyncExternalStore } from 'react';
import type { Instance, Project } from '../types';
import { canStartBox } from '../utils/boxPower';
import { archivedNameClash } from '../utils/projectStart';
import { uniqueName } from './newChat';

export interface CloneBoxPick { box: Pick<Instance, 'id' | 'name' | 'status'>; wake: boolean }

/** Up enough to take a project: the create route holds a project on a box still coming up as `pending`. */
const TAKES_PROJECTS = new Set(['ready', 'provisioning', 'awaiting-agent']);
/** Asleep: the owner-only start route wakes it. */
const ASLEEP = new Set(['stopped', 'hibernated']);
/** A project whose checkout isn't there yet, or never will be without a retry. */
const UNREADY = new Set(['pending', 'cloning', 'failed']);

/** `owner/name`, lowercased, of a GitHub clone URL; null for anything else. */
export function repoOfCloneUrl(url: string): string | null {
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

type ProjectLike = Pick<Project, 'id' | 'name' | 'repoUrl' | 'role' | 'setupStatus' | 'setupError' | 'instanceId' | 'lastActiveAt'>;

/** Your projects cloned from `repo`, most recently active first. */
function projectsOn<T extends Pick<Project, 'repoUrl' | 'role' | 'lastActiveAt'>>(repo: string, projects: readonly T[]): T[] {
  const want = repo.toLowerCase();
  return projects
    .filter(p => p.role !== 'collaborator' && p.repoUrl && repoOfCloneUrl(p.repoUrl) === want)
    .sort((a, b) => (Date.parse(b.lastActiveAt ?? '') || 0) - (Date.parse(a.lastActiveAt ?? '') || 0));
}

/** Whether a project's checkout can take a review: not pending, cloning or failed. */
export function cloneReady(p: Pick<Project, 'setupStatus'>): boolean {
  return !UNREADY.has(p.setupStatus ?? '');
}

/** The project on `repo` whose clone is still running or failed, when you have none that is ready. */
export function unreadyCloneOf<T extends Pick<Project, 'repoUrl' | 'role' | 'lastActiveAt' | 'setupStatus'>>(repo: string, projects: readonly T[]): T | null {
  const on = projectsOn(repo, projects);
  return on.some(cloneReady) ? null : on[0] ?? null;
}

/** Where a review's clone goes (above), or null when you have no box that can take one. */
export function reviewCloneBox(
  boxes: readonly Pick<Instance, 'id' | 'name' | 'status' | 'kind' | 'ec2InstanceId'>[],
  projects: readonly Pick<Project, 'instanceId' | 'lastActiveAt' | 'role'>[],
): CloneBoxPick | null {
  // Boxes by their most recent project's activity, then the rest in the list's order.
  const last = new Map<string, number>();
  for (const p of projects) {
    if (p.role === 'collaborator' || !p.instanceId) continue;
    const at = Date.parse(p.lastActiveAt ?? '') || 0;
    if (at >= (last.get(p.instanceId) ?? -1)) last.set(p.instanceId, at);
  }
  const ranked = boxes
    .map((b, i) => ({ b, i, at: last.get(b.id) ?? -1 }))
    .sort((x, y) => y.at - x.at || x.i - y.i)
    .map(x => x.b);
  const up = ranked.find(b => b.status === 'ready') ?? ranked.find(b => TAKES_PROJECTS.has(b.status));
  if (up) return { box: up, wake: false };
  // Waking already, or asleep and wakeable: waited for (and woken) first.
  const coming = ranked.find(b => b.status === 'starting') ?? ranked.find(b => canStartBox(b));
  return coming ? { box: coming, wake: true } : null;
}

/** The project's name: the repository's, as the create route allows (letters, digits, - and _), free among `taken`. */
export function reviewProjectName(repo: string, taken: Iterable<string>): string {
  const name = repo.split('/').pop() ?? repo;
  let base = name.replace(/\.git$/i, '').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'review';
  if (base.toLowerCase() === 'metaterm') base = 'metaterm-review';
  return uniqueName(base, taken);
}

export type ClonePhase = 'waking' | 'creating' | 'cloning' | 'checkout';
export interface CloneProgress { repo: string; box: string; phase: ClonePhase; projectName?: string }

export interface CloneDeps {
  listBoxes: () => Promise<Pick<Instance, 'id' | 'name' | 'status'>[]>;
  startBox: (id: string) => Promise<unknown>;
  listProjects: () => Promise<ProjectLike[]>;
  createProject: (data: { name: string; instanceId: string; repoUrl: string }) => Promise<Pick<Project, 'id' | 'name'>>;
  retryClone: (id: string) => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** The project a review can start in. `pane`: its box types the clone into the agent pane, so `none` came early. */
export interface ClonedProject { projectId: string; projectName: string; pane: boolean }

const BOX_WAIT_MS = 10 * 60_000;
// The box's clone unit allows 30 minutes (deploy/termag-project-clone@.service).
const CLONE_WAIT_MS = 31 * 60_000;
// How long a branch off a pane-route checkout is tried again while the checkout lands.
const CHECKOUT_WAIT_MS = 15 * 60_000;
const POLL_MS = 2_000;

function message(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: unknown } } })?.response?.data;
  if (typeof data?.error === 'string') return data.error;
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Wake a box that's asleep, then wait until it takes projects. */
async function boxUp(box: Pick<Instance, 'id' | 'name' | 'status'>, deps: CloneDeps): Promise<void> {
  if (TAKES_PROJECTS.has(box.status)) return;
  if (ASLEEP.has(box.status)) await deps.startBox(box.id);
  const until = deps.now() + BOX_WAIT_MS;
  for (;;) {
    const now = (await deps.listBoxes()).find(b => b.id === box.id);
    if (!now) throw new Error(`${box.name} is gone`);
    if (TAKES_PROJECTS.has(now.status)) return;
    if (now.status === 'failed') throw new Error(`${box.name} failed to start`);
    if (deps.now() > until) throw new Error(`${box.name} took too long to start`);
    await deps.sleep(POLL_MS);
  }
}

/**
 * Clone `repo` for a review, and resolve with the project once its checkout is there: `ready`, or `none` from a
 * box whose agent types the clone into the agent pane (projectSetup's pane route; the review's own pane reads the
 * PR through `gh --repo`, so it can start while that finishes, and a branch off it waits: untilCheckedOut).
 * A project already on the repository, read afresh, is used rather than a second made: waited for while it
 * clones, cloned again when its clone failed. Otherwise a new one on `pick`'s box, woken first if need be.
 */
export async function cloneForReview(repo: string, pick: CloneBoxPick | null, deps: CloneDeps, onProgress: (p: CloneProgress) => void = () => {}): Promise<ClonedProject> {
  const projects = await deps.listProjects();
  const existing = projectsOn(repo, projects).find(cloneReady) ?? projectsOn(repo, projects)[0] ?? null;
  let project: Pick<Project, 'id' | 'name'>;
  let boxName: string;
  if (existing) {
    project = existing;
    const boxes = await deps.listBoxes();
    const box = boxes.find(b => b.id === existing.instanceId);
    boxName = box?.name ?? pick?.box.name ?? 'its box';
    if (cloneReady(existing)) return { projectId: existing.id, projectName: existing.name, pane: existing.setupStatus === 'none' };
    // Its clone waits on its box: woken first, as a new project's would be.
    if (box && !TAKES_PROJECTS.has(box.status)) {
      onProgress({ repo, box: boxName, phase: 'waking' });
      await boxUp(box, deps);
    }
    if (existing.setupStatus === 'failed') await deps.retryClone(existing.id);
  } else {
    if (!pick) throw new Error(`No box to clone ${repo} on`);
    boxName = pick.box.name;
    if (pick.wake) {
      onProgress({ repo, box: boxName, phase: 'waking' });
      await boxUp(pick.box, deps);
    }
    onProgress({ repo, box: boxName, phase: 'creating' });
    const taken = new Set(projects.map(p => p.name));
    let created: Pick<Project, 'id' | 'name'> | null = null;
    // A name can be held by an archived project on that box (409 archived-name-taken) or by one this list hadn't
    // caught up with (409): the next free name, a few times.
    for (let attempt = 0; attempt < 4 && !created; attempt++) {
      const name = reviewProjectName(repo, taken);
      try {
        created = await deps.createProject({ name, instanceId: pick.box.id, repoUrl: `https://github.com/${repo}.git` });
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status !== 409 || (!archivedNameClash(err) && !/already exists/i.test(message(err, '')))) {
          throw new Error(message(err, `Could not make a project for ${repo}`));
        }
        taken.add(name);
      }
    }
    if (!created) throw new Error(`Could not find a free project name for ${repo}`);
    project = created;
  }

  onProgress({ repo, box: boxName, phase: 'cloning', projectName: project.name });
  const until = deps.now() + CLONE_WAIT_MS;
  for (;;) {
    const p = (await deps.listProjects()).find(x => x.id === project.id);
    const status = p?.setupStatus ?? null;
    if (p && cloneReady(p)) return { projectId: project.id, projectName: project.name, pane: status === 'none' };
    if (status === 'failed') throw new Error(`The clone of ${repo} failed${p?.setupError ? `: ${p.setupError}` : ''}`);
    if (deps.now() > until) throw new Error(`The clone of ${repo} took too long`);
    await deps.sleep(POLL_MS);
  }
}

/** The create route's refusal of a branch off a pane checkout still landing (backend routes/workstreams.ts CHECKOUT_NOT_LANDED). */
export function isCheckoutNotLanded(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 409 && /not checked out yet/i.test(message(err, ''));
}

/**
 * `call`, made again while its project's pane checkout is still landing (only after a clone that came back
 * `pane`; otherwise once). Anything else it throws is thrown at once.
 */
export async function untilCheckedOut<T>(call: () => Promise<T>, pane: boolean, deps: Pick<CloneDeps, 'sleep' | 'now'>, onWait: () => void = () => {}): Promise<T> {
  const until = deps.now() + CHECKOUT_WAIT_MS;
  for (;;) {
    try {
      return await call();
    } catch (err) {
      if (!pane || !isCheckoutNotLanded(err) || deps.now() > until) throw err;
      onWait();
      await deps.sleep(POLL_MS * 2);
    }
  }
}

// ── one clone per repository, its progress for the Review buttons ──────────

const inFlight = new Map<string, Promise<ClonedProject>>();
const progress = new Map<string, CloneProgress>();
const listeners = new Set<() => void>();
const key = (repo: string) => repo.toLowerCase();
function emit() { for (const fn of listeners) fn(); }

/** The clone for `repo`: the one already running, else a new one. Its progress shows until it settles. */
export function cloneFor(repo: string, pick: CloneBoxPick | null, deps: CloneDeps): Promise<ClonedProject> {
  const k = key(repo);
  const running = inFlight.get(k);
  if (running) return running;
  const run = cloneForReview(repo, pick, deps, p => { progress.set(k, p); emit(); })
    .finally(() => { inFlight.delete(k); progress.delete(k); emit(); });
  inFlight.set(k, run);
  return run;
}

/** Shows a step after the clone (a review session waiting for its pane checkout) under `repo`'s Review buttons. */
export function noteCloneStep(repo: string, p: CloneProgress | null) {
  if (p) progress.set(key(repo), p); else progress.delete(key(repo));
  emit();
}

/** The running clone's progress for `repo`, or null. */
export function useReviewClone(repo: string | null | undefined): CloneProgress | null {
  return useSyncExternalStore(
    fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => (repo ? progress.get(key(repo)) ?? null : null),
    () => null,
  );
}

// ── where a clone's review went, for the page that waits on it (pages/chat/ReviewCloneStart.tsx) ──

/**
 * A review on a repository with no project opens at once on a page of its own, which shows the clone's steps
 * (its progress, above) and hands over to the session once the review starts there. `pending`: started, no step
 * reported yet. `to`: the session, and the state its page opens with. `error`: why it couldn't, with what to do.
 */
export type CloneOutcome =
  | { pending: true }
  | { to: { projectId: string; workstream: string; state: Record<string, unknown> } }
  | { error: string };
const outcomes = new Map<string, CloneOutcome>();
const outcomeKey = (repo: string, number: number) => `${key(repo)}#${number}`;

/** The page a review on `repo`'s PR `number` waits on while its project is made. */
export function cloneStartHref(repo: string, number: number): string {
  return `/chat/review-start/${repo}/${number}`;
}

/** Records how the clone's review for a PR is going; null forgets it (the page took it). */
export function noteCloneOutcome(repo: string, number: number, outcome: CloneOutcome | null) {
  if (outcome) outcomes.set(outcomeKey(repo, number), outcome); else outcomes.delete(outcomeKey(repo, number));
  emit();
}

/** How the clone's review for a PR is going, or null (outside React: the Review button's own guard). */
export function cloneOutcomeFor(repo: string, number: number): CloneOutcome | null {
  return outcomes.get(outcomeKey(repo, number)) ?? null;
}

/** How the clone's review for a PR is going, or null: none started from this page load. */
export function useCloneOutcome(repo: string, number: number): CloneOutcome | null {
  return useSyncExternalStore(
    fn => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => outcomes.get(outcomeKey(repo, number)) ?? null,
    () => null,
  );
}

/** What the Review button says while the clone runs. */
export function cloneProgressText(p: CloneProgress): string {
  if (p.phase === 'waking') return `Waking ${p.box} to clone ${p.repo}…`;
  if (p.phase === 'creating') return `Making a project for ${p.repo} on ${p.box}…`;
  if (p.phase === 'checkout') return `Waiting for ${p.projectName ?? p.repo}'s checkout to land…`;
  return `Cloning ${p.repo} into ${p.projectName ?? 'a new project'} on ${p.box}…`;
}
