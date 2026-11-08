/**
 * What a project's `kind` lets it do. `Project.kind` is a string, not an
 * enum: "normal" (an ordinary project), "metaterm" (the per-user control
 * tower), "automation" (a project whose runs a
 * schedule starts) and "space-orchestrator" (the project a
 * space's Slack orchestrator runs in, made by termag when a space's first Slack
 * channel is linked). Every route and query that used to
 * compare against 'metaterm' or filter on 'normal' reads these traits
 * instead, so a new kind is one entry here rather than a sweep of the code.
 * The frontend mirrors this in frontend/src/utils/projectKind.ts.
 */

export const PROJECT_KINDS = ['normal', 'metaterm', 'automation', 'space-orchestrator'] as const;
export type ProjectKind = typeof PROJECT_KINDS[number];

export interface ProjectKindTraits {
  /** The project's main workstream runs an agent a person talks to. */
  runsMainAgent: boolean;
  /** A person may branch off a workstream (the scheduler may always). */
  canBranchOff: boolean;
  canRenameProject: boolean;
  canArchive: boolean;
  canShare: boolean;
  canHandOff: boolean;
  /** A person may change which agent a workstream runs. */
  canSwitchAgent: boolean;
  /** Workflows are the owner's to add and remove (false: termag manages them). */
  canEditWorkflows: boolean;
  /** Counts as the user's work: PR pills, the briefing ledger, ask targets, stale-project signals. */
  listedAsWork: boolean;
  /**
   * Shown in navigation and pickers at all. MetaTerm is (as the control
   * tower); a space orchestrator is not: it is the space's, reached from Slack.
   *
   * The rule, for every later use (docs/agents/domain-model.md, "Space channel"):
   * - Filter on it (LISTED_PROJECT_KINDS) only for navigation and pickers: the
   *   sidebar and project lists (web, TUI, `termag projects`), the session
   *   inventory, recents, Slack's Home tab and Slack and Discord `/t projects`
   *   and `/t switch`, and any default or automatic choice of a project (the
   *   `/t` fallback, a saved target, a proj- channel match, adoption pickers).
   * - Never filter on it where a person is told what an action will destroy
   *   or hand over: box remove (`termag box rm`, the web Terminate confirm),
   *   stop and hibernate warnings, project or account deletion, transfer.
   *   Nor in admin inventory, usage and cost. There, include the project and
   *   label it (services/spaceSlack/projectLabels.ts: "space orchestrator for
   *   <space>"), so the person knows what they are removing.
   */
  inProjectLists: boolean;
  /** A person may make a project of this kind through POST /api/projects. */
  creatableByHand: boolean;
  isAutomation: boolean;
}

const NORMAL: ProjectKindTraits = {
  runsMainAgent: true, canBranchOff: true, canRenameProject: true, canArchive: true, canShare: true,
  canHandOff: true, canSwitchAgent: true, canEditWorkflows: true, listedAsWork: true, inProjectLists: true,
  creatableByHand: true, isAutomation: false,
};

const TRAITS: Record<ProjectKind, ProjectKindTraits> = {
  normal: NORMAL,
  metaterm: {
    runsMainAgent: true, canBranchOff: false, canRenameProject: false, canArchive: false, canShare: false,
    canHandOff: false, canSwitchAgent: false, canEditWorkflows: false, listedAsWork: false, inProjectLists: true,
    creatableByHand: false, isAutomation: false,
  },
  automation: {
    // main holds the clone and a chat-runner workflow; runs are workstreams the scheduler makes.
    runsMainAgent: false, canBranchOff: false, canRenameProject: true, canArchive: true, canShare: true,
    canHandOff: false, canSwitchAgent: false, canEditWorkflows: false, listedAsWork: true, inProjectLists: true,
    creatableByHand: true, isAutomation: true,
  },
  'space-orchestrator': {
    // Made and managed by termag for a space (services/spaceSlack): its main
    // runs the orchestrator's chat-runner turns, which Slack drives, not a
    // person in a pane. Renaming, archiving or sharing it would break the
    // space's link to it; the space's Slack settings disable it instead.
    runsMainAgent: false, canBranchOff: false, canRenameProject: false, canArchive: false, canShare: false,
    canHandOff: false, canSwitchAgent: false, canEditWorkflows: false, listedAsWork: false, inProjectLists: false,
    creatableByHand: false, isAutomation: false,
  },
};

export function isProjectKind(value: unknown): value is ProjectKind {
  return typeof value === 'string' && (PROJECT_KINDS as readonly string[]).includes(value);
}

/** The traits of a kind; an unknown or missing kind is treated as normal. */
export function projectKindTraits(kind: string | null | undefined): ProjectKindTraits {
  return isProjectKind(kind) ? TRAITS[kind] : NORMAL;
}

/** The kinds that count as the user's work, for Prisma `kind: { in: … }` filters. */
export const WORK_PROJECT_KINDS: ProjectKind[] = PROJECT_KINDS.filter(k => TRAITS[k].listedAsWork);

/**
 * A project that navigation may land on, or null: a saved `/t` target or an
 * attach on a project not in lists (a space orchestrator) reads as gone.
 */
export function listedOrNull<P extends { kind?: string | null }>(project: P | null | undefined): P | null {
  return project && projectKindTraits(project.kind).inProjectLists ? project : null;
}

/** The kinds the owner's project lists show, for Prisma `kind: { in: … }` filters (inProjectLists). */
export const LISTED_PROJECT_KINDS: ProjectKind[] = PROJECT_KINDS.filter(k => TRAITS[k].inProjectLists);

/** Every kind's traits, for the frontend mirror's agreement test. */
export const PROJECT_KIND_TRAITS: Readonly<Record<ProjectKind, ProjectKindTraits>> = TRAITS;

/** The refusal a route answers when a kind cannot do something, in MetaTerm's wording for MetaTerm. */
export function kindRefusal(kind: string | null | undefined, what: string): string {
  const name = kind === 'metaterm' ? 'MetaTerm'
    : kind === 'automation' ? 'An automation'
      : kind === 'space-orchestrator' ? "A space's orchestrator" : 'This project';
  return `${name} cannot ${what}`;
}
