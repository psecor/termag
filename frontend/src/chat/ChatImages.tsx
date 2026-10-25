import { useEffect, useState } from 'react';
import { isEdgeSessionExpired } from '../contexts/ConnectionContext';
import { createImageCache, storedImageUrl, type LoadedImage, type PreparedImage } from './chatImageData';
import type { ChatImage } from './sdkChat';

// A chat's stored images do not change (named by their bytes), so one read
// each is kept for the page's life, up to a bound.
const MAX_CACHED = 64;

async function readStoredImage(url: string): Promise<LoadedImage> {
  try {
    // redirect: 'manual', as TerminalImagePreview: an expired session's 302 must not be followed in the background.
    const res = await fetch(url, { credentials: 'same-origin', redirect: 'manual' });
    if (isEdgeSessionExpired(res)) return { kind: 'error', message: 'Signed out' };
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      return { kind: 'error', message: body?.error ?? `HTTP ${res.status}` };
    }
    return { kind: 'image', url: URL.createObjectURL(await res.blob()) };
  } catch {
    return { kind: 'error', message: 'Could not reach the box' };
  }
}

const storedImages = createImageCache(readStoredImage, url => URL.revokeObjectURL(url), MAX_CACHED);

function MessageImage({ image, projectId, workstream }: { image: ChatImage; projectId: string; workstream: string }) {
  const [loaded, setLoaded] = useState<LoadedImage | null>(image.src ? { kind: 'image', url: image.src } : null);
  useEffect(() => {
    if (image.src) { setLoaded({ kind: 'image', url: image.src }); return; }
    if (!image.path) { setLoaded({ kind: 'error', message: 'Image not kept' }); return; }
    let live = true;
    setLoaded(null);
    const held = storedImages.hold(storedImageUrl(projectId, workstream, image.path));
    void held.loaded.then(r => { if (live) setLoaded(r); });
    return () => { live = false; held.release(); };
  }, [image.src, image.path, projectId, workstream]);
  if (!loaded) return <div className="sdk-image" data-loading="" aria-label="Loading image" />;
  if (loaded.kind === 'error') return <div className="sdk-image" data-error="" title={loaded.message}>image</div>;
  return (
    <a className="sdk-image" href={loaded.url} target="_blank" rel="noreferrer" title="Open full size">
      <img src={loaded.url} alt="Attached image" />
    </a>
  );
}

/** The images of a user message, above its text: local copies while pending, the box's after. */
export function MessageImages({ images, projectId, workstream }: { images: ChatImage[]; projectId: string; workstream: string }) {
  return (
    <div className="sdk-images">
      {images.map((image, i) => <MessageImage key={image.path ?? image.src ?? i} image={image} projectId={projectId} workstream={workstream} />)}
    </div>
  );
}

/** The composer's attached images, each with a remove button. */
export function ComposerImages({ images, onRemove, disabled }: { images: PreparedImage[]; onRemove: (id: string) => void; disabled?: boolean }) {
  if (!images.length) return null;
  return (
    <div className="chat-attachments" aria-label="Attached images">
      {images.map(image => (
        <div key={image.id} className="chat-attachment">
          <img src={image.src} alt={image.name} />
          <button type="button" className="chat-attachment-remove" aria-label={`Remove ${image.name}`} disabled={disabled}
            onClick={() => onRemove(image.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
