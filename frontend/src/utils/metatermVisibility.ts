/**
 * Whether the sidebar offers MetaTerm. Opt-in (Settings → Appearance,
 * `sidebarMetaTerm`): on a first run the entry reads like a place to work,
 * and people ended up doing project work on the orchestrator. An existing
 * MetaTerm that is the open project stays listed, so the session on screen
 * never drops out of the sidebar.
 */
export interface MetaTermVisibility {
  /** Show the pinned MetaTerm row (the user already has one). */
  showRow: boolean;
  /** Show the "⚡ MetaTerm · open" entry that creates one. */
  showEntry: boolean;
}

export function metatermVisibility(input: {
  optedIn: boolean;
  metatermId: string | null;
  activeProjectId: string | null;
}): MetaTermVisibility {
  const exists = input.metatermId !== null;
  const isOpen = exists && input.metatermId === input.activeProjectId;
  const shown = input.optedIn || isOpen;
  return { showRow: shown && exists, showEntry: shown && !exists };
}
