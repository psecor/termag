/**
 * What a project's `kind` lets it do. `Project.kind` is a string, not an
 * enum: "normal" (an ordinary project), "metaterm" (the per-user control
 * tower) and "automation" (a project whose runs a
 * schedule starts). Every route and query that used to
 * compare against 'metaterm' or filter on 'normal' reads these traits
 * instead, so a new kind is one entry here rather than a sweep of the code.
 * The frontend mirrors this in frontend/src/utils/projectKind.ts.
 */

export const PROJECT_KINDS = ['normal', 'metaterm', 'automation'] as const;
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
  isAutomation: boolean;
}

const NORMAL: ProjectKindTraits = {
  runsMainAgent: true, canBranchOff: true, canRenameProject: true, canArchive: true, canShare: true,
  canHandOff: true, canSwitchAgent: true, canEditWorkflows: true, listedAsWork: true, isAutomation: false,
};

const TRAITS: Record<ProjectKind, ProjectKindTraits> = {
  normal: NORMAL,
  metaterm: {
    runsMainAgent: true, canBranchOff: false, canRenameProject: false, canArchive: false, canShare: false,
    canHandOff: false, canSwitchAgent: false, canEditWorkflows: false, listedAsWork: false, isAutomation: false,
  },
  automation: {
    // main holds the clone and a chat-runner workflow; runs are workstreams the scheduler makes.
    runsMainAgent: false, canBranchOff: false, canRenameProject: true, canArchive: true, canShare: true,
    canHandOff: false, canSwitchAgent: false, canEditWorkflows: false, listedAsWork: true, isAutomation: true,
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

/** The refusal a route answers when a kind cannot do something, in MetaTerm's wording for MetaTerm. */
export function kindRefusal(kind: string | null | undefined, what: string): string {
  const name = kind === 'metaterm' ? 'MetaTerm' : kind === 'automation' ? 'An automation' : 'This project';
  return `${name} cannot ${what}`;
}
