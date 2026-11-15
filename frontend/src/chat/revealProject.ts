// The header's project name (pages/chat/SessionHeader.tsx ProjectCrumb) reveals
// the project's group in the sidebar
// (open question 4): an event the Projects view (pages/chat/ProjectsList.tsx)
// answers by unfolding the group, scrolling it into view and focusing its head.
// From the Tabs view the crumb switches the sidebar to Projects first, so the
// view mounts after the event: the reveal waits for it (takePendingReveal).

export const REVEAL_PROJECT_EVENT = 'termag:reveal-project';

let pending: string | null = null;

export function revealProject(userProjectId: string): void {
  pending = userProjectId;
  window.dispatchEvent(new CustomEvent<{ userProjectId: string }>(REVEAL_PROJECT_EVENT, { detail: { userProjectId } }));
}

/** The reveal asked for before the Projects view was there to answer it, once: the view reads it as it mounts. */
export function takePendingReveal(): string | null {
  const id = pending;
  pending = null;
  return id;
}

/** Calls `onReveal` with each revealed project's id; returns the unsubscribe. */
export function onRevealProject(onReveal: (userProjectId: string) => void): () => void {
  const listener = (e: Event) => {
    const id = (e as CustomEvent<{ userProjectId?: unknown }>).detail?.userProjectId;
    if (typeof id !== 'string') return;
    pending = null;
    onReveal(id);
  };
  window.addEventListener(REVEAL_PROJECT_EVENT, listener);
  return () => window.removeEventListener(REVEAL_PROJECT_EVENT, listener);
}
