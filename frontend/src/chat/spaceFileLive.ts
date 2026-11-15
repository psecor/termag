// Live space files: `space-file` frames from
// the status socket (ProjectContext) to the open file view and the explorer
// (pages/chat/SpaceFileLive.tsx), and what a frame means for the file on
// screen. The server sends a frame only to people who can read the space. A
// frame with `resync` (the socket reopened, or the server's LISTEN connection
// came back) names nothing: whoever shows a file checks it.

export interface SpaceFileFrame {
  type: 'space-file';
  space?: string;
  kind?: 'put' | 'mv' | 'rm';
  /** A path ending in `/` is a folder; absent when the paths didn't fit the server's NOTIFY. */
  path?: string;
  /** A move's destination. */
  to?: string;
  /** A put's new version. */
  etag?: string;
  resync?: true;
}

type Listener = (frame: SpaceFileFrame) => void;
const listeners = new Set<Listener>();

export const spaceFileEvents = {
  publish(frame: SpaceFileFrame): void {
    for (const fn of listeners) fn(frame);
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  /** The status socket (re)opened: frames may have been missed while it was down. */
  notifyReconnect(): void {
    for (const fn of listeners) fn({ type: 'space-file', resync: true });
  },
};

/**
 * The other moments to look again at the files on screen (under project-files-enabled):
 * the window regains focus, the tab becomes visible, or the open session's turn ends (recheckFiles). A
 * frame can be missed (the socket down, a write nobody confirmed), and an agent's turn is when its files land, so
 * these are when a missed one would show. Events, not a timer: nothing runs while nothing changes. Focus and
 * visibility usually come together, so they count once a second; a turn's end always counts. The window's
 * listeners are attached only while something on screen listens.
 */
type Recheck = () => void;
const rechecks = new Set<Recheck>();
const WINDOW_RECHECK_MS = 1000;
let lastWindowRecheck = -Infinity;
const runRechecks = () => { for (const fn of [...rechecks]) fn(); };
const onWindowBack = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (now - lastWindowRecheck < WINDOW_RECHECK_MS) return;
  lastWindowRecheck = now;
  runRechecks();
};

/** Calls `fn` on each moment to look again; returns the unsubscribe. */
export function onFilesRecheck(fn: Recheck): () => void {
  if (rechecks.size === 0 && typeof window !== 'undefined') {
    window.addEventListener('focus', onWindowBack);
    document.addEventListener('visibilitychange', onWindowBack);
  }
  rechecks.add(fn);
  return () => {
    rechecks.delete(fn);
    if (rechecks.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('focus', onWindowBack);
      document.removeEventListener('visibilitychange', onWindowBack);
    }
  };
}

/** The open session's turn ended: its agent may have written files, so look again at the ones on screen. */
export function recheckFiles(): void {
  runRechecks();
}

/** How long the "Updated" cue shows. */
export const CUE_MS = 2500;

export type FileEffect =
  | { kind: 'changed'; etag?: string }
  | { kind: 'gone'; movedTo?: string }
  | { kind: 'check' }
  | null;

const under = (folder: string, path: string) => folder.endsWith('/') && path.startsWith(folder);

/** What `frame` means for `space:path` on screen: reload it, it's gone (or moved), ask the server, or nothing. */
export function effectOnFile(frame: SpaceFileFrame, space: string, path: string): FileEffect {
  if (frame.resync) return { kind: 'check' };
  if (frame.space !== space) return null;
  if (frame.path === undefined) return { kind: 'check' };
  const p = frame.path;
  switch (frame.kind) {
    case 'put':
      return p === path ? { kind: 'changed', ...(frame.etag ? { etag: frame.etag } : {}) } : null;
    case 'rm':
      return p === path || under(p, path) ? { kind: 'gone' } : null;
    case 'mv': {
      const to = frame.to;
      if (p === path) return { kind: 'gone', ...(to !== undefined ? { movedTo: to } : {}) };
      if (under(p, path)) return { kind: 'gone', ...(to !== undefined ? { movedTo: to + path.slice(p.length) } : {}) };
      // Something moved onto this path: a new version of it.
      if (to !== undefined && (to === path || under(to, path))) return { kind: 'changed' };
      return to === undefined ? { kind: 'check' } : null;
    }
    default:
      return null;
  }
}

/** Whether `frame` may change a listing of `space`. */
export function touchesSpace(frame: SpaceFileFrame, space: string): boolean {
  return frame.resync === true || frame.space === space;
}

/**
 * A view that would lose its place if swapped under the reader (a PDF, a video
 * or audio player, any other framed URL) waits for a click on the cue; text,
 * code, Markdown, HTML, SVG and images reload in place.
 */
export function holdsOnChange(loaded: { state: string; show?: { kind: string }; type?: string; text?: string }): boolean {
  return loaded.state === 'ok' && loaded.show?.kind === 'frame' && loaded.text === undefined && !(loaded.type ?? '').startsWith('image/');
}
