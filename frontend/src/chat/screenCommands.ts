// Commands the screen in view lends ⌘K under the simple UI's chrome refresh:
// the open chat's Archive and Open
// in Lab, which only it can run (its confirm, its box). It provides them while
// it is mounted, and the sidebar's palette lists them beside its own.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { PaletteAction } from '../utils/searchPalette';

let current: readonly PaletteAction[] = [];
const listeners = new Set<() => void>();

function publish(next: readonly PaletteAction[]) {
  current = next;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The commands the screen in view provides; none when it provides none. */
export function useScreenCommands(): readonly PaletteAction[] {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

/** What a command says on screen; `run` is left out, so a re-render alone republishes nothing. */
const shownAs = (a: PaletteAction) => [a.id, a.label, a.detail ?? '', a.icon ?? '', a.keys ?? '', a.disabled ? 1 : 0].join('\u0000');

/**
 * Provides `commands` (null: none) while the caller is mounted. Each command's
 * `run` is called through a ref, so it is always the latest render's, and the
 * palette only re-renders when what a command says changes.
 */
export function useProvideScreenCommands(commands: readonly PaletteAction[] | null): void {
  const latest = useRef(commands);
  latest.current = commands;
  const key = commands ? commands.map(shownAs).join('\u0001') : null;
  useEffect(() => {
    const now = latest.current;
    if (!now) return;
    publish(now.map(c => ({ ...c, run: () => latest.current?.find(x => x.id === c.id)?.run() })));
    return () => publish([]);
  }, [key]);
}

/** For tests: forget whatever a test left behind. */
export function resetScreenCommandsForTests(): void {
  publish([]);
}
