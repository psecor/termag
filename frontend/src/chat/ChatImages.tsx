import { useCallback, useEffect, useRef, useState } from 'react';
import { isEdgeSessionExpired } from '../contexts/ConnectionContext';
import { CHAT_PDF_TYPE, createImageCache, storedImageUrl, type LoadedImage, type PreparedImage } from './chatImageData';
import { ImageLightbox } from './ImageLightbox';
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

function MessageImage({ image, index, layer, projectId, workstream, onShown, onOpen }: {
  image: ChatImage;
  index: number;
  /** Its place in a stack, 0 in front; undefined for a message's only image. */
  layer?: number;
  projectId: string;
  workstream: string;
  /** The URL this thumbnail shows, or undefined while it has none. */
  onShown: (index: number, url: string | undefined) => void;
  onOpen: (index: number, from: HTMLElement) => void;
}) {
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
  const url = loaded?.kind === 'image' ? loaded.url : undefined;
  useEffect(() => { onShown(index, url); }, [index, url, onShown]);
  if (!loaded) return <div className="sdk-image" data-layer={layer} data-loading="" aria-label="Loading image" />;
  if (loaded.kind === 'error') return <div className="sdk-image" data-layer={layer} data-error="" title={loaded.message}>image</div>;
  return (
    // Still a link, so a modified or middle click opens the image in a new tab; a plain click opens the lightbox.
    // In a stack only the front card is a tab stop; the lightbox steps through the rest.
    <a className="sdk-image" data-layer={layer} href={loaded.url} target="_blank" rel="noreferrer" title="View full size"
      tabIndex={layer ? -1 : undefined}
      onClick={e => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onOpen(index, e.currentTarget);
      }}>
      <img src={loaded.url} alt="Attached image" />
    </a>
  );
}

const isPdf = (i: { mediaType: string }) => i.mediaType === CHAT_PDF_TYPE;
const pdfName = (i: { name?: string }) => i.name || 'PDF document';

/** A PDF in a message: its name, a download while this browser still holds it. */
function MessagePdf({ pdf }: { pdf: ChatImage }) {
  const name = pdfName(pdf);
  return pdf.src
    ? <a className="sdk-file" href={pdf.src} download={name} title={name}><span className="sdk-file-kind">PDF</span><span className="sdk-file-name">{name}</span></a>
    : <span className="sdk-file" title={name}><span className="sdk-file-kind">PDF</span><span className="sdk-file-name">{name}</span></span>;
}

/** The attachments of a user message, above its text: its PDFs, then its images. */
export function MessageImages({ images: all, projectId, workstream }: { images: ChatImage[]; projectId: string; workstream: string }) {
  const pdfs = all.filter(isPdf);
  const images = all.filter(i => !isPdf(i));
  return (
    <>
      {pdfs.length > 0 && (
        <div className="sdk-files">{pdfs.map((pdf, i) => <MessagePdf key={pdf.path ?? i} pdf={pdf} />)}</div>
      )}
      {images.length > 0 && <MessageImageList images={images} projectId={projectId} workstream={workstream} />}
    </>
  );
}

/** The images of a user message: local copies while pending, the box's after. */
function MessageImageList({ images, projectId, workstream }: { images: ChatImage[]; projectId: string; workstream: string }) {
  // Each thumbnail's URL by position, so the lightbox can step through the ones that loaded.
  const [urls, setUrls] = useState<Array<string | undefined>>([]);
  const [open, setOpen] = useState<number | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const onShown = useCallback((index: number, url: string | undefined) => {
    setUrls(prev => {
      if (prev[index] === url) return prev;
      const next = [...prev];
      next[index] = url;
      return next;
    });
  }, []);
  const onOpen = useCallback((index: number, from: HTMLElement) => { opener.current = from; setOpen(index); }, []);
  const close = useCallback(() => { setOpen(null); opener.current?.focus({ preventScroll: true }); }, []);
  const viewable = urls.slice(0, images.length).flatMap((url, index) => url ? [{ url, index }] : []);
  const at = open == null ? -1 : viewable.findIndex(v => v.index === open);
  // Two or more stack as iMessage's do: the first in front, the next two fanned out behind it.
  const stacked = images.length > 1;
  return (
    <div className={stacked ? 'sdk-images sdk-image-stack' : 'sdk-images'}
      role={stacked ? 'group' : undefined} aria-label={stacked ? `${images.length} images` : undefined}>
      {images.map((image, i) => (
        <MessageImage key={image.path ?? image.src ?? i} image={image} index={i} layer={stacked ? i : undefined}
          projectId={projectId} workstream={workstream} onShown={onShown} onOpen={onOpen} />
      ))}
      {at >= 0 && (
        <ImageLightbox urls={viewable.map(v => v.url)} index={at} onIndex={i => setOpen(viewable[i].index)} onClose={close} />
      )}
    </div>
  );
}

/** The composer's attached images, each with a remove button. */
export function ComposerImages({ images, onRemove, disabled }: { images: PreparedImage[]; onRemove: (id: string) => void; disabled?: boolean }) {
  if (!images.length) return null;
  return (
    <div className="chat-attachments" aria-label="Attachments">
      {images.map(image => (
        <div key={image.id} className="chat-attachment" data-file={isPdf(image) || undefined} title={isPdf(image) ? image.name : undefined}>
          {isPdf(image)
            ? <><span className="sdk-file-kind">PDF</span><span className="chat-attachment-name">{image.name}</span></>
            : <img src={image.src} alt={image.name} />}
          <button type="button" className="chat-attachment-remove" aria-label={`Remove ${image.name}`} disabled={disabled}
            onClick={() => onRemove(image.id)}>×</button>
        </div>
      ))}
    </div>
  );
}
