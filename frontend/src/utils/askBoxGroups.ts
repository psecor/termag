import type { Instance } from '../types';

/**
 * What the full UI's Projects list leaves out under Settings → Appearance,
 * "Hide ask boxes" (the `sidebarHideAskBoxes` theme key, off by default), so
 * the list holds only what the person started:
 *
 * - **ask boxes**, whose group goes: boxes the orchestrator marked
 *   `createdFor: 'ask'` (`termag ask --new-box`, or the deprecated
 *   `--for-ask`; backend services/boxLifecycle.applyAskBoxPolicy), unless
 *   one holds a project without the mark: the person made that one there,
 *   so the box stays listed, with only the unmarked projects' rows;
 * - **ask projects** on the person's own boxes, whose row goes: projects
 *   marked `createdFor: 'ask'`, which `termag ask --new-box` also makes on a
 *   box that was already there. A box left with no rows and no cloud session
 *   has no group, like any empty one.
 *
 * A box or project made for an ask before the mark existed, or by hand, has
 * no mark and stays listed. "Shared with me" and "this host" are left alone:
 * neither is on one of the person's boxes.
 *
 * Hiding is the list's only: nothing happens to the box or the project, and
 * the Boxes section, the box pickers, Recents and search still list them.
 * Never hidden: the open project (the URL's `?project=`, so opening an ask's
 * project from a link or search shows it, and its box, until you move on),
 * and a box with a live cloud session listed under it (those sessions are
 * the person's own, and the header counts them). The caller passes
 * `enabled: false` in select mode, which lists everything like it does
 * stopped boxes, so "Select all" never selects a row nobody can see.
 */
export interface AskGroupsInput {
  enabled: boolean;
  /** The person's own boxes. */
  boxes: Pick<Instance, 'id' | 'createdFor'>[];
  /** The projects in the list: their box (null for "this host") and what they were made for. */
  projects: { id: string; instanceId?: string | null; createdFor?: string | null }[];
  activeProjectId: string | null;
  /** Box ids with a Claude Code cloud session listed under them. */
  boxesWithCloud?: ReadonlySet<string>;
}

export interface AskHidden {
  /** Ask boxes whose whole group is left out. */
  boxIds: Set<string>;
  /** Ask projects on the person's own boxes whose row is left out. */
  projectIds: Set<string>;
}

export function hiddenAsks(input: AskGroupsInput): AskHidden {
  const hidden: AskHidden = { boxIds: new Set(), projectIds: new Set() };
  if (!input.enabled) return hidden;
  const activeBox = input.activeProjectId
    ? input.projects.find(p => p.id === input.activeProjectId)?.instanceId ?? null
    : null;
  // Boxes holding a project with no ask mark: the person made it there (New
  // project on an ask box, say), so it is theirs and keeps its box listed.
  const holdsOwn = new Set(input.projects.filter(p => p.instanceId && p.createdFor !== 'ask').map(p => p.instanceId));
  for (const b of input.boxes) {
    if (b.createdFor !== 'ask') continue;
    if (b.id === activeBox || holdsOwn.has(b.id)) continue;
    if (input.boxesWithCloud?.has(b.id)) continue;
    hidden.boxIds.add(b.id);
  }
  const own = new Set(input.boxes.map(b => b.id));
  for (const p of input.projects) {
    if (p.createdFor !== 'ask' || !p.instanceId || !own.has(p.instanceId)) continue;
    if (p.id === input.activeProjectId) continue;
    hidden.projectIds.add(p.id);
  }
  return hidden;
}

/** The projects left to list: without the hidden ask boxes' projects and the hidden ask projects. */
export function withoutAsks<P extends { id: string; instanceId?: string | null }>(projects: P[], hidden: AskHidden): P[] {
  if (!hidden.boxIds.size && !hidden.projectIds.size) return projects;
  return projects.filter(p => !hidden.projectIds.has(p.id) && !(p.instanceId && hidden.boxIds.has(p.instanceId)));
}
