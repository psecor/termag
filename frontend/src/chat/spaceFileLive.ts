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
