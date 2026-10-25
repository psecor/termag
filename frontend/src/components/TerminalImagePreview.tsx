import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { isEdgeSessionExpired } from '../contexts/ConnectionContext';

/**
 * The floating preview of an image path hovered in a terminal pane
 * (Terminal.tsx, utils/imagePathLinks.ts). The box reads the file and the
 * backend serves its bytes (GET /api/projects/:id/image); a fetch rather than
 * a bare <img src> so a refusal shows the backend's reason.
 */

export interface ImagePreviewAnchor {
  url: string;
  path: string;
  /** Pointer position in viewport pixels. */
  x: number;
  y: number;
}

type Loaded = { kind: 'image'; objectUrl: string } | { kind: 'error'; message: string };

// Hovering back and forth along a list of screenshots should not re-read the
// box each time, but a re-taken screenshot at the same path should show.
const CACHE_MS = 15_000;
const cache = new Map<string, { at: number; result: Promise<Loaded> }>();

export function loadImagePreview(url: string, now: number = Date.now()): Promise<Loaded> {
  const hit = cache.get(url);
  if (hit && now - hit.at < CACHE_MS) return hit.result;
  for (const [k, v] of cache) {
    if (now - v.at < CACHE_MS) continue;
    cache.delete(k);
    void v.result.then(r => { if (r.kind === 'image') URL.revokeObjectURL(r.objectUrl); });
  }
  const result = (async (): Promise<Loaded> => {
    try {
      // redirect: 'manual', as the status probe does: behind the ALB an
      // expired session 302s to the identity provider, and a background
      // fetch following it can race the sign-in nonce of a real one.
      const res = await fetch(url, { credentials: 'same-origin', redirect: 'manual' });
      if (isEdgeSessionExpired(res)) return { kind: 'error', message: 'Signed out. Reload the page to sign in again' };
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        return { kind: 'error', message: body?.error ?? `HTTP ${res.status}` };
      }
      return { kind: 'image', objectUrl: URL.createObjectURL(await res.blob()) };
    } catch {
      return { kind: 'error', message: 'Could not reach the box' };
    }
  })();
  cache.set(url, { at: now, result });
  // Only an image is worth keeping: after signing back in, or once the
  // screenshot exists, the next hover should ask again.
  void result.then(r => { if (r.kind === 'error' && cache.get(url)?.result === result) cache.delete(url); });
  return result;
}

const MAX_W = 520;
const MAX_H = 380;
const GAP = 14;

export function TerminalImagePreview({ anchor }: { anchor: ImagePreviewAnchor }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let live = true;
    setLoaded(null);
    void loadImagePreview(anchor.url).then(r => { if (live) setLoaded(r); });
    return () => { live = false; };
  }, [anchor.url]);

  // Below-right of the pointer, flipped to whichever side has room.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = anchor.x + GAP + MAX_W > vw ? Math.max(8, anchor.x - GAP - MAX_W) : anchor.x + GAP;
  const top = anchor.y + GAP + MAX_H + 28 > vh ? Math.max(8, anchor.y - GAP - MAX_H - 28) : anchor.y + GAP;
  const name = anchor.path.slice(anchor.path.lastIndexOf('/') + 1);

  return createPortal(
    <div className="terminal-image-preview" style={{ left, top, maxWidth: MAX_W }} role="tooltip">
      <div className="terminal-image-preview-body" style={{ maxHeight: MAX_H }}>
        {!loaded && <span className="terminal-image-preview-note">Loading…</span>}
        {loaded?.kind === 'error' && <span className="terminal-image-preview-note">{loaded.message}</span>}
        {loaded?.kind === 'image' && (
          <img src={loaded.objectUrl} alt={name} style={{ maxWidth: MAX_W, maxHeight: MAX_H }} />
        )}
      </div>
      <div className="terminal-image-preview-caption" title={anchor.path}>
        {name} · click to open
      </div>
    </div>,
    document.body,
  );
}
