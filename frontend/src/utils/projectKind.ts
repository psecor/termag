// What a project's `kind` lets the UI offer. Mirrors backend
// services/projectKind.ts (kept in sync by hand, like the provider registry):
// "normal", "metaterm" (the control tower), "automation" (a project whose
// runs a schedule starts) and "space-orchestrator" (the
// project a space's Slack orchestrator runs in). A `kind === 'metaterm'` check that means "not an ordinary project"
// reads these instead. projectKind.test.ts checks the traits both files share
// against the backend's, kind by kind.

export const PROJECT_KINDS = ['normal', 'metaterm', 'automation', 'space-orchestrator'] as const;
export type ProjectKind = typeof PROJECT_KINDS[number];

export interface ProjectKindTraits {
  /** The project row stands for an agent a person talks to in main. */
  runsMainAgent: boolean;
  canBranchOff: boolean;
  canRenameProject: boolean;
  canArchive: boolean;
  canShare: boolean;
  canHandOff: boolean;
  canSwitchAgent: boolean;
  /** The Review button and the other per-pane agent actions apply. */
  hasPaneActions: boolean;
  /** Counts as the user's work in lists (the simple UI's chats, pickers). */
  listedAsWork: boolean;
  /**
   * In navigation and pickers at all (see the backend's projectKind.ts for the
   * rule): the sidebar, project lists, recents, default or automatic choices.
   * Never a reason to hide a project from a destructive or ownership
   * confirmation, or from admin inventory, usage and cost: there it is named
   * and labelled (projectWithLabel).
   */
  inProjectLists: boolean;
  isAutomation: boolean;
}

const NORMAL: ProjectKindTraits = {
  runsMainAgent: true, canBranchOff: true, canRenameProject: true, canArchive: true, canShare: true,
  canHandOff: true, canSwitchAgent: true, hasPaneActions: true, listedAsWork: true, inProjectLists: true, isAutomation: false,
};

const TRAITS: Record<ProjectKind, ProjectKindTraits> = {
  normal: NORMAL,
  metaterm: {
    runsMainAgent: true, canBranchOff: false, canRenameProject: false, canArchive: false, canShare: false,
    canHandOff: false, canSwitchAgent: false, hasPaneActions: false, listedAsWork: false, inProjectLists: true, isAutomation: false,
  },
  automation: {
    runsMainAgent: false, canBranchOff: false, canRenameProject: true, canArchive: true, canShare: true,
    canHandOff: false, canSwitchAgent: false, hasPaneActions: false, listedAsWork: true, inProjectLists: true, isAutomation: true,
  },
  // Termag's, for a space: Slack drives its main, so nothing a person does to a project applies.
  'space-orchestrator': {
    runsMainAgent: false, canBranchOff: false, canRenameProject: false, canArchive: false, canShare: false,
    canHandOff: false, canSwitchAgent: false, hasPaneActions: false, listedAsWork: false, inProjectLists: false, isAutomation: false,
  },
};

/** Every kind's traits, for the agreement test with the backend's. */
export const PROJECT_KIND_TRAITS: Readonly<Record<ProjectKind, ProjectKindTraits>> = TRAITS;

export function isProjectKind(value: unknown): value is ProjectKind {
  return typeof value === 'string' && (PROJECT_KINDS as readonly string[]).includes(value);
}

/** The traits of a kind; an unknown or missing kind is treated as normal. */
export function projectKindTraits(kind: string | null | undefined): ProjectKindTraits {
  return isProjectKind(kind) ? TRAITS[kind] : NORMAL;
}

/** "name (space orchestrator for <space>)" where the backend labelled a managed project, else the name. */
export function projectWithLabel(p: { name: string; label?: string }): string {
  return p.label ? `${p.name} (${p.label})` : p.name;
}

export function isAutomationProject(p: { kind?: string | null } | null | undefined): boolean {
  return p?.kind === 'automation';
}
