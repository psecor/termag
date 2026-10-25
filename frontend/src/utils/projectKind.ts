// What a project's `kind` lets the UI offer. Mirrors backend
// services/projectKind.ts (kept in sync by hand, like the provider registry):
// "normal", "metaterm" (the control tower) and "automation" (a project whose
// runs a schedule starts). A `kind === 'metaterm'`
// check that means "not an ordinary project" reads these instead.

export type ProjectKind = 'normal' | 'metaterm' | 'automation';

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
  isAutomation: boolean;
}

const NORMAL: ProjectKindTraits = {
  runsMainAgent: true, canBranchOff: true, canRenameProject: true, canArchive: true, canShare: true,
  canHandOff: true, canSwitchAgent: true, hasPaneActions: true, listedAsWork: true, isAutomation: false,
};

const TRAITS: Record<ProjectKind, ProjectKindTraits> = {
  normal: NORMAL,
  metaterm: {
    runsMainAgent: true, canBranchOff: false, canRenameProject: false, canArchive: false, canShare: false,
    canHandOff: false, canSwitchAgent: false, hasPaneActions: false, listedAsWork: false, isAutomation: false,
  },
  automation: {
    runsMainAgent: false, canBranchOff: false, canRenameProject: true, canArchive: true, canShare: true,
    canHandOff: false, canSwitchAgent: false, hasPaneActions: false, listedAsWork: true, isAutomation: true,
  },
};

export function projectKindTraits(kind: string | null | undefined): ProjectKindTraits {
  return kind === 'metaterm' || kind === 'automation' ? TRAITS[kind] : NORMAL;
}

export function isAutomationProject(p: { kind?: string | null } | null | undefined): boolean {
  return p?.kind === 'automation';
}
