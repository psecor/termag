// The sidebar's groups under the chrome refresh's view options
// (chat/sidebarView.ts): the tabs by the spaces' own groups with the filters
// applied, or every agent by its project or its state (chat/rowState.ts), and
// then the files and new tabs; or, under Show: Projects, every session
// (projectGroups, below).
// Pure, for the tests; OpenItems.tsx draws what it returns.
import type { OpenItem } from './openItems';
import type { RowStateKind } from './rowState';
import type { SidebarView } from './sidebarView';
import type { SpawnLink } from './explorerAgents';
import type { Project } from '../types';
import { stateSince, type InboxRow } from '../mobile/inbox';

export interface StatusGroup { key: string; name: string; kinds: readonly RowStateKind[] }

/**
 * By state, in the order they need you, named by the status words
 * (chat/statusWords.ts statusWordFor). Idle keeps the key it had as Recent, so
 * a group someone folded stays folded.
 */
export const STATUS_GROUPS: readonly StatusGroup[] = [
  { key: 'needs-you', name: 'Needs you', kinds: ['approval', 'unread', 'error'] },
  { key: 'working', name: 'Working', kinds: ['working'] },
  { key: 'recent', name: 'Idle', kinds: ['done'] },
  { key: 'off', name: 'Not running', kinds: ['off'] },
];
export const FILES_GROUP = { key: 'files', name: 'Files' } as const;

export interface ViewGroup {
  /** The space a space group is, null for No space and for a project's or a state's group. */
  space: string | null;
  /** A project's group (key `project:<id>`) or a state's, or null for a space's. */
  status: { key: string; name: string } | null;
  items: OpenItem[];
  /** How many it had before the filters: a space emptied by them is not "Nothing open". */
  total: number;
}

/**
 * `stateOf` is an agent tab's state, or null when its row is unknown (kept, so
 * a filter never hides what it can't judge). `openTab` is the tab on screen,
 * which no filter hides: the sidebar never loses what is open, as a folded
 * space keeps it too. `projectOf` is an agent tab's project name; null (no
 * name known) groups it under its project id rather than dropping it.
 */
export function viewGroups(
  groups: ReadonlyArray<{ space: string | null; items: readonly OpenItem[] }>,
  view: Pick<SidebarView, 'groupBy' | 'showFiles' | 'showIdle'>,
  stateOf: (item: OpenItem) => RowStateKind | null,
  openTab: string | null = null,
  projectOf: (item: OpenItem & { kind: 'chat' }) => string | null = () => null,
  /**
   * Under user-projects-enabled, an agent tab's project (milestone 5's record):
   * Group by Project groups by it, by its name. Null (no project yet, or none
   * read) keeps the tab under its checkout, as without the flag.
   */
  userProjectOf: (item: OpenItem & { kind: 'chat' }) => { id: string; name: string } | null = () => null,
): ViewGroup[] {
  const keep = (item: OpenItem) => {
    if (item.id === openTab) return true;
    if (item.kind !== 'chat') return view.showFiles;
    return view.showIdle || stateOf(item) !== 'off';
  };
  if (view.groupBy === 'space') {
    return groups.map(g => ({ space: g.space, status: null, items: g.items.filter(keep), total: g.items.length }));
  }
  const all = groups.flatMap(g => g.items).filter(keep);
  const files = all.filter(i => i.kind !== 'chat');
  const filesGroup: ViewGroup = { space: null, status: { ...FILES_GROUP }, items: files, total: files.length };
  if (view.groupBy === 'project') {
    // Every agent under its project, by name, then the files and new tabs.
    const byProject = new Map<string, { name: string; items: OpenItem[] }>();
    for (const item of all) {
      if (item.kind !== 'chat') continue;
      const own = userProjectOf(item);
      const key = own ? `${USER_PROJECT_KEY}${own.id}` : `project:${item.projectId}`;
      const group = byProject.get(key);
      if (group) group.items.push(item);
      else byProject.set(key, { name: own?.name ?? projectOf(item) ?? item.projectId, items: [item] });
    }
    const out: ViewGroup[] = [...byProject.entries()]
      .sort(([, a], [, b]) => a.name.localeCompare(b.name))
      .map(([key, g]) => ({ space: null, status: { key, name: g.name }, items: g.items, total: g.items.length }));
    out.push(filesGroup);
    return out.filter(g => g.items.length > 0);
  }
  const out: ViewGroup[] = STATUS_GROUPS.map(sg => {
    const items = all.filter(i => {
      if (i.kind !== 'chat') return false;
      const kind = stateOf(i);
      // An agent whose state is unknown counts as done rather than vanishing.
      return kind == null ? sg.key === 'recent' : sg.kinds.includes(kind);
    });
    return { space: null, status: { key: sg.key, name: sg.name }, items, total: items.length };
  });
  out.push(filesGroup);
  return out.filter(g => g.items.length > 0);
}

// ---------------------------------------------------------------------------
// The Projects view (Show: Projects):
// every session from the project list, not the tabs. Needs you on top, then one
// group per project, then Shared with me, Automations and Files.
// pages/chat/ProjectsList.tsx draws it. A project is the person's own
// (milestone 5's record, under user-projects-enabled)
// once GET /api/user-projects has
// answered, with its open PRs, and shown when it has no session yet; a checkout
// with none (the flag off, the read not back, the backfill not there yet) is
// in its repository set's group, milestone 3's.

/** A group key's prefix for one of the person's projects (`userproject:<id>`), in both views. */
export const USER_PROJECT_KEY = 'userproject:';

/** The state kinds that put a session in Needs you: blocked on you (STATUS_GROUPS' first group). */
export const NEEDS_YOU_KINDS: readonly RowStateKind[] = STATUS_GROUPS[0].kinds;
export const NEEDS_YOU_GROUP = { key: 'needs-you', name: STATUS_GROUPS[0].name } as const;
export const NO_REPO_GROUP = { key: 'no-repo', name: 'No repo' } as const;
export const SHARED_GROUP = { key: 'shared', name: 'Shared with me' } as const;
export const AUTOMATIONS_GROUP = { key: 'automations', name: 'Automations' } as const;

/** A session blocked on you: its mark is one of NEEDS_YOU_KINDS. */
const needsYou = (kind: RowStateKind) => NEEDS_YOU_KINDS.includes(kind);

/**
 * How many sessions need you: the Needs you group's rows, whichever view the
 * sidebar shows (no filter hides one), for the phone's Sessions button
 * (pages/chat/chatChrome.tsx ChatHistoryButton).
 */
export function needsYouCount(rows: readonly InboxRow[], stateOf: (row: InboxRow) => RowStateKind): number {
  return rows.filter(r => needsYou(stateOf(r))).length;
}

/** `pinned`, `status`, `space`, `older` and `archived` are the sidebar redesign's (chat/sidebarLayout.ts, ProjectsList.tsx); projectGroups makes the rest. */
export type ProjectGroupKind = 'needs-you' | 'pinned' | 'project' | 'status' | 'space' | 'older' | 'shared' | 'automations' | 'archived' | 'files';

export interface ProjectGroup {
  key: string;
  kind: ProjectGroupKind;
  name: string;
  /** Its sessions, in the order the list nests them (chat/agentTree.ts nestInOrder): most recent first; Needs you, oldest wait first. */
  rows: InboxRow[];
  /** Files' tabs; empty for the rest. */
  items: OpenItem[];
  /** The head's count: a project's group counts its sessions that are up in Needs you too. */
  count: number;
  /** One of the person's projects (milestone 5's record): its id. Absent for a repository set's group and the rest. */
  userProjectId?: string;
  /** A project with no session listed: "No sessions yet" (under the redesign, none listed under its head). */
  empty?: boolean;
  /** Under the redesign: how many of its sessions are listed elsewhere (Needs you, Pinned, Older). */
  elsewhere?: number;
  /** Under the redesign's Group by Status: its status's colour on the head. */
  tone?: 'working' | 'idle' | 'off';
  /** Under the redesign's Group by Space: the space, by name; null for No space. */
  space?: string | null;
  /** Its open PRs, when it has any: how many, and the most recently active session with one (its row key), which the count opens. */
  prs?: { count: number; openKey: string };
  /** A project the project list pins (Project.pinned): it sorts first, under either Sort (chat/sidebarSort.ts). */
  pinned?: boolean;
}

/** What projectGroups reads about a session's project, from the project list. */
export type GroupedProject = Pick<Project, 'repoKeys' | 'pinned' | 'lastActiveAt' | 'userProjectId'>;

/**
 * One of the person's live projects (GET /api/user-projects), as projectGroups
 * reads it. `liveSessions`: its unarchived checkouts' live sessions, by its own
 * record, so a project the project list hasn't caught up with (read before the
 * flag, or still loading) is never taken for one with no session.
 */
export interface GroupedUserProject { id: string; name: string; lastActiveAt: string; liveSessions?: number }

/** An open PR (GET /api/prs, as chat/prGates.ts sessionPr links one) and the session it is linked to. */
export interface SessionOpenPr { key: string; pr: string }

export interface ProjectGroupsInput {
  /** Every listed session (pages/chat/simpleData.tsx rows). */
  rows: readonly InboxRow[];
  stateOf: (row: InboxRow) => RowStateKind;
  projectOf: (projectId: string) => GroupedProject | undefined;
  /** When the session was last active (its Workstream.lastActiveAt), in ms; null when unknown, which falls back to its project's. */
  activeAt: (row: InboxRow) => number | null;
  /** Who started whom (asks and spawns): a child goes in its parent's group. */
  links: readonly SpawnLink[];
  view: Pick<SidebarView, 'showFiles' | 'showIdle'>;
  /** This browser's file tabs and new tabs, for Files. */
  files: readonly OpenItem[];
  /** The session on screen (its row key) and the tab on screen: no filter hides either. */
  openKey?: string | null;
  openTab?: string | null;
  /**
   * Under user-projects-enabled, once GET /api/user-projects has answered: the
   * person's live projects. A checkout of one (its userProjectId) is in its
   * group, by its name; one with no session at all is an empty group, shown
   * while sessions that aren't running are. Absent: repository sets alone.
   */
  userProjects?: readonly GroupedUserProject[];
  /** Open PRs by session, for a project group's count. */
  openPrs?: readonly SessionOpenPr[];
  /**
   * The sidebar redesign (user-projects-enabled):
   * `elsewhere` are the sessions the caller lists in Pinned or Older, which,
   * like Needs you's, leave their project's group; a person's project whose
   * sessions are all elsewhere keeps its head, empty, with how many are
   * elsewhere; and a head counts what it lists.
   */
  redesign?: { elsewhere: ReadonlySet<string> };
}

const normRepo = (k: string) => k.trim().toLowerCase().replace(/\/+$/, '').replace(/\.git$/, '');

/** A project's group key: its repositories, case and `.git` aside, in any order; No repo's for none. */
export function repoSetKey(project: Pick<Project, 'repoKeys'> | undefined): string {
  const keys = [...new Set((project?.repoKeys ?? []).map(normRepo).filter(Boolean))].sort();
  return keys.length ? `repos:${keys.join(' ')}` : NO_REPO_GROUP.key;
}

/** A group's name from its repositories in checkout order: "termag", "termag + termag-desktop", "dev + 3 more", or No repo. */
export function repoSetName(repoKeys: readonly string[] | undefined): string {
  const names = [...new Set((repoKeys ?? []).map(normRepo).filter(Boolean))].map(k => k.slice(k.lastIndexOf('/') + 1));
  if (names.length === 0) return NO_REPO_GROUP.name;
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} + ${names[1]}`;
  return `${names[0]} + ${names.length - 1} more`;
}

const linkKeyOf = (projectId: string, workstream: string) => `${projectId}|${workstream}`;

export function projectGroups(input: ProjectGroupsInput): ProjectGroup[] {
  const { rows, stateOf, projectOf, activeAt, links, view, files, openKey = null, openTab = null, userProjects, openPrs = [], redesign } = input;
  const elsewhereKeys = redesign?.elsewhere ?? new Set<string>();
  const kept = rows.filter(r => r.key === openKey || view.showIdle || stateOf(r) !== 'off');
  const away = kept.filter(r => elsewhereKeys.has(r.key));
  const needs = kept.filter(r => !elsewhereKeys.has(r.key) && needsYou(stateOf(r)));
  const needsKeys = new Set(needs.map(r => r.key));
  const rest = kept.filter(r => !needsKeys.has(r.key) && !elsewhereKeys.has(r.key));
  const ownProjects = new Map((userProjects ?? []).map(p => [p.id, p]));
  const userProjectAt = (key: string): number => {
    const at = key.startsWith(USER_PROJECT_KEY) ? ownProjects.get(key.slice(USER_PROJECT_KEY.length))?.lastActiveAt : undefined;
    const ms = at ? Date.parse(at) : NaN;
    return Number.isNaN(ms) ? -Infinity : ms;
  };

  // A session's own place: shared, an automation's run, its project, or (none known) its repository set.
  const sectionOf = (r: InboxRow): string => {
    if (r.shared) return SHARED_GROUP.key;
    if (r.kind === 'automation') return AUTOMATIONS_GROUP.key;
    const project = projectOf(r.projectId);
    const own = project?.userProjectId ? ownProjects.get(project.userProjectId) : undefined;
    return own ? `${USER_PROJECT_KEY}${own.id}` : repoSetKey(project);
  };
  // A child (an ask, a spawn) sits in its parent's group, so it can nest under it: walk to the top
  // through parents the list shows outside Needs you. A loop leaves each member where it is.
  const byKey = new Map(rest.map(r => [r.key, r]));
  const parentOf = new Map<string, string>();
  for (const l of links) {
    const child = linkKeyOf(l.projectId, l.workstream);
    const parent = linkKeyOf(l.parentProjectId, l.parentWorkstream);
    if (child !== parent && byKey.has(child) && byKey.has(parent) && !parentOf.has(child)) parentOf.set(child, parent);
  }
  const rootOf = (k: string): string => {
    const seen = new Set([k]);
    let at = k;
    for (let p = parentOf.get(at); p; p = parentOf.get(at)) {
      if (seen.has(p)) return k;
      seen.add(p);
      at = p;
    }
    return at;
  };

  const projectAt = (r: InboxRow): number => {
    const at = projectOf(r.projectId)?.lastActiveAt;
    const ms = at ? Date.parse(at) : NaN;
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  // A session sorts by its own activity: its project's is any of its sessions', so it
  // would tie every session of a project. Only a session with none of its own falls back.
  const sessionAt = (r: InboxRow): number => activeAt(r) ?? projectAt(r);
  // A group is as recent as the latest of its sessions and their projects.
  const recency = (r: InboxRow): number => Math.max(activeAt(r) ?? -Infinity, projectAt(r));
  const newestFirst = (a: InboxRow, b: InboxRow) => sessionAt(b) - sessionAt(a);

  interface Bucket { key: string; rows: InboxRow[]; up: number; newest: number; pinned: boolean; named: { at: number; repoKeys?: string[] } | null }
  const buckets = new Map<string, Bucket>();
  const bucket = (key: string) => {
    let b = buckets.get(key);
    if (!b) { b = { key, rows: [], up: 0, newest: userProjectAt(key), pinned: false, named: null }; buckets.set(key, b); }
    return b;
  };
  // `own`: the session's own place is this group, not a parent's it nests under. Only those
  // name and pin it; any of its sessions makes it recent.
  const note = (b: Bucket, r: InboxRow, own: boolean) => {
    const at = recency(r);
    if (at > b.newest) b.newest = at;
    if (!own) return;
    const project = projectOf(r.projectId);
    if (project?.pinned) b.pinned = true;
    // Named in the order of its most recently active project's checkout.
    if (!b.named || at > b.named.at) b.named = { at, repoKeys: project?.repoKeys };
  };
  for (const r of rest) {
    const own = sectionOf(r);
    const key = sectionOf(byKey.get(rootOf(r.key)) ?? r);
    const b = bucket(key);
    b.rows.push(r);
    note(b, r, own === key);
  }
  for (const r of [...needs, ...away]) {
    const b = bucket(sectionOf(r));
    b.up += 1;
    note(b, r, true);
  }

  const out: ProjectGroup[] = [];
  const waited = (r: InboxRow) => { const s = stateSince(r); const t = s ? Date.parse(s) : NaN; return Number.isNaN(t) ? Infinity : t; };
  if (needs.length) {
    out.push({ ...NEEDS_YOU_GROUP, kind: 'needs-you', rows: [...needs].sort((a, b) => waited(a) - waited(b)), items: [], count: needs.length });
  }
  const special = new Set<string>([SHARED_GROUP.key, AUTOMATIONS_GROUP.key]);
  // A project with no session at all (made with + New project, nothing started): its group says so.
  // Not one whose sessions the filter hides, nor one whose only sessions nest under another group's,
  // nor one whose record has sessions the project list doesn't show under it yet.
  if (view.showIdle && userProjects) {
    const owned = new Set(rows.map(sectionOf));
    for (const p of userProjects) {
      const key = `${USER_PROJECT_KEY}${p.id}`;
      if (!owned.has(key) && !(p.liveSessions && p.liveSessions > 0)) bucket(key);
    }
  }
  // Open PRs, per project: each PR once, and the most recently active session with one.
  const rowByKey = new Map(rows.map(r => [r.key, r]));
  const prsOf = new Map<string, { prs: Set<string>; open: InboxRow }>();
  for (const { key, pr } of openPrs) {
    const r = rowByKey.get(key);
    if (!r) continue;
    const section = sectionOf(r);
    const got = prsOf.get(section);
    if (!got) prsOf.set(section, { prs: new Set([pr]), open: r });
    else {
      got.prs.add(pr);
      if (sessionAt(r) > sessionAt(got.open)) got.open = r;
    }
  }
  const nameOf = (b: Bucket): string => {
    if (b.key.startsWith(USER_PROJECT_KEY)) return ownProjects.get(b.key.slice(USER_PROJECT_KEY.length))?.name ?? repoSetName(b.named?.repoKeys);
    return b.key === NO_REPO_GROUP.key ? NO_REPO_GROUP.name : repoSetName(b.named?.repoKeys);
  };
  const isEmpty = (b: Bucket) => b.rows.length === 0 && (b.up === 0 || Boolean(redesign)) && b.key.startsWith(USER_PROJECT_KEY);
  // As the project list sorts (pinned first, then recent activity); a name breaks a tie.
  const projects = [...buckets.values()].filter(b => !special.has(b.key) && (b.rows.length > 0 || isEmpty(b)))
    .map(b => ({ b, name: nameOf(b) }))
    .sort((x, y) => Number(y.b.pinned) - Number(x.b.pinned) || y.b.newest - x.b.newest || x.name.localeCompare(y.name));
  for (const { b, name } of projects) {
    const group: ProjectGroup = { key: b.key, kind: 'project', name, rows: [...b.rows].sort(newestFirst), items: [], count: redesign ? b.rows.length : b.rows.length + b.up };
    if (b.key.startsWith(USER_PROJECT_KEY)) group.userProjectId = b.key.slice(USER_PROJECT_KEY.length);
    if (isEmpty(b)) group.empty = true;
    if (b.pinned) group.pinned = true;
    if (redesign && b.up > 0) group.elsewhere = b.up;
    const prs = prsOf.get(b.key);
    if (prs) group.prs = { count: prs.prs.size, openKey: prs.open.key };
    out.push(group);
  }
  for (const g of [SHARED_GROUP, AUTOMATIONS_GROUP]) {
    const b = buckets.get(g.key);
    if (!b || b.rows.length === 0) continue;
    out.push({ ...g, kind: g.key === SHARED_GROUP.key ? 'shared' : 'automations', rows: [...b.rows].sort(newestFirst), items: [], count: redesign ? b.rows.length : b.rows.length + b.up });
  }
  // The redesign's files are the side panel's (pages/chat/FilesTool.tsx), not a group here.
  if (redesign) return out;
  const shownFiles = files.filter(i => i.kind !== 'chat' && (view.showFiles || i.id === openTab));
  if (shownFiles.length) out.push({ ...FILES_GROUP, kind: 'files', rows: [], items: shownFiles, count: shownFiles.length });
  return out;
}

/** Folded groups, kept per browser: `true` folded, `false` unfolded; unset is the default, which folds only Automations. */
export const PROJECT_FOLDS_KEY = 'termag.chat.projectFolds';

export function projectGroupFolded(folds: Readonly<Record<string, boolean>>, key: string): boolean {
  return folds[key] ?? key === AUTOMATIONS_GROUP.key;
}

export function readProjectFolds(storage: Pick<Storage, 'getItem'> | null): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(PROJECT_FOLDS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'));
  } catch {
    return {};
  }
}

export function toggleProjectFold(folds: Readonly<Record<string, boolean>>, key: string, storage: Pick<Storage, 'setItem'> | null): Record<string, boolean> {
  const next = { ...folds, [key]: !projectGroupFolded(folds, key) };
  try { storage?.setItem(PROJECT_FOLDS_KEY, JSON.stringify(next)); } catch { /* private mode, quota */ }
  return next;
}
