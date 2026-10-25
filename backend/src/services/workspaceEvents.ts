/**
 * Tells a user's browsers that their project or box list changed, so a project
 * or box made, renamed, archived, powered or terminated outside that tab (the
 * CLI, an agent spawn, a sweep, another tab) shows up without a reload.
 * index.ts wires the callback to push `{type: 'workspace', what}` to the
 * owner's status WebSocket clients; the browser refetches the list it names.
 * Only the fact of a change is pushed, never the row.
 */
export type WorkspaceChange = 'projects' | 'boxes';

type ChangeCallback = (ownerId: string, what: WorkspaceChange) => void;
let onChange: ChangeCallback | null = null;

export function setWorkspaceChangeCallback(cb: ChangeCallback | null): void {
  onChange = cb;
}

export function notifyWorkspaceChange(ownerId: string, what: WorkspaceChange): void {
  try { onChange?.(ownerId, what); } catch (err) {
    console.error(`[WORKSPACE] ${what} change push failed:`, err instanceof Error ? err.message : String(err));
  }
}

/** Pass a change's result through, notifying the owner when it succeeded (any 2xx). */
export function notifyOnSuccess<T extends { status: number }>(
  result: T, ownerId: string, what: WorkspaceChange | WorkspaceChange[],
): T {
  if (result.status >= 200 && result.status < 300) {
    for (const w of Array.isArray(what) ? what : [what]) notifyWorkspaceChange(ownerId, w);
  }
  return result;
}

/**
 * Wraps a push so a burst of changes (box create, then project create, then
 * workstream create within seconds) costs each browser one reload per window
 * rather than one per write. The first change for an (owner, list) opens a
 * window of `windowMs`; the push goes out when it closes, and every change in
 * between rides along. A change only ever waits, it is never dropped: one that
 * lands after the push opens the next window.
 */
export function coalesceWorkspaceChanges(push: ChangeCallback, windowMs: number): ChangeCallback {
  const pending = new Set<string>();
  return (ownerId, what) => {
    const key = `${what}\0${ownerId}`;
    if (pending.has(key)) return;
    pending.add(key);
    const timer = setTimeout(() => {
      pending.delete(key);
      try { push(ownerId, what); } catch (err) {
        console.error(`[WORKSPACE] ${what} change push failed:`, err instanceof Error ? err.message : String(err));
      }
    }, windowMs);
    timer.unref?.();
  };
}
