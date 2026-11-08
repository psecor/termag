import { useCallback, useEffect, useRef, useState } from 'react';
import { isEdgeSessionExpired } from '../contexts/ConnectionContext';
import { CHAT_PDF_TYPE, createImageCache, storedImageUrl, type LoadedImage, type PreparedImage } from './chatImageData';
import { formatFileSize, textFileKind, type BoxFile, type SentBoxFile, type TextFile } from './chatTextFiles';
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

type SentTextFile = Pick<TextFile, 'name' | 'text'>;

/**
 * A text file in a message (chat/chatTextFiles.ts): its name, a download of
 * its text, which the message itself holds, so it is there from the history too.
 */
function MessageTextFile({ file }: { file: SentTextFile }) {
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') return;
    const made = URL.createObjectURL(new Blob([file.text], { type: 'text/plain;charset=utf-8' }));
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [file.text]);
  const title = `${file.name} · ${formatFileSize(new TextEncoder().encode(file.text).length)}`;
  const inner = <><span className="sdk-file-kind">{textFileKind(file.name)}</span><span className="sdk-file-name">{file.name}</span></>;
  return url
    ? <a className="sdk-file" data-text-file="" href={url} download={file.name} title={title}>{inner}</a>
    : <span className="sdk-file" data-text-file="" title={title}>{inner}</span>;
}

/** A file the box keeps for a message (chat/chatTextFiles.ts): its name, and where on the box, which this browser can't fetch. */
function MessageBoxFile({ file }: { file: SentBoxFile }) {
  return (
    <span className="sdk-file" data-box-file="" title={`${file.name} · ${file.size} · on the box at ${file.path}`}>
      <span className="sdk-file-kind">{textFileKind(file.name)}</span><span className="sdk-file-name">{file.name}</span>
    </span>
  );
}

/** A message's text files and box files alone, as chips above its text: for a bubble with no images to show (Not sent). */
export function MessageTextFiles({ files, boxFiles = [] }: { files: SentTextFile[]; boxFiles?: SentBoxFile[] }) {
  if (!files.length && !boxFiles.length) return null;
  return (
    <div className="sdk-files">
      {files.map((file, i) => <MessageTextFile key={`${i}:${file.name}`} file={file} />)}
      {boxFiles.map(file => <MessageBoxFile key={file.path} file={file} />)}
    </div>
  );
}

/** The attachments of a user message, above its text: its PDFs and text files, then its images. */
export function MessageImages({ images: all, files = [], boxFiles = [], projectId, workstream }: { images: ChatImage[]; files?: SentTextFile[]; boxFiles?: SentBoxFile[]; projectId: string; workstream: string }) {
  const pdfs = all.filter(isPdf);
  const images = all.filter(i => !isPdf(i));
  return (
    <>
      {(pdfs.length > 0 || files.length > 0 || boxFiles.length > 0) && (
        <div className="sdk-files">
          {pdfs.map((pdf, i) => <MessagePdf key={pdf.path ?? i} pdf={pdf} />)}
          {files.map((file, i) => <MessageTextFile key={`${i}:${file.name}`} file={file} />)}
          {boxFiles.map(file => <MessageBoxFile key={file.path} file={file} />)}
        </div>
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

/** The composer's attached images, PDFs and text files, each with a remove button. */
export function ComposerImages({ images, files = [], boxFiles = [], onRemove, disabled }: { images: PreparedImage[]; files?: TextFile[]; boxFiles?: BoxFile[]; onRemove: (id: string) => void; disabled?: boolean }) {
  if (!images.length && !files.length && !boxFiles.length) return null;
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
      {files.map(file => (
        <div key={file.id} className="chat-attachment" data-file="" data-text-file="" title={`${file.name} · goes in the message as text`}>
          <span className="sdk-file-kind">{textFileKind(file.name)}</span><span className="chat-attachment-name">{file.name}</span>
          <button type="button" className="chat-attachment-remove" aria-label={`Remove ${file.name}`} disabled={disabled}
            onClick={() => onRemove(file.id)}>×</button>
        </div>
      ))}
      {boxFiles.map(file => {
        // Where it is: on its way, waiting for the box to wake, or there (the message will name its path).
        const status = file.status === 'kept' ? 'on the box' : file.status === 'waking' ? 'waking the box…' : 'uploading…';
        return (
          <div key={file.id} className="chat-attachment" data-file="" data-box-file={file.status} title={`${file.name} · ${typeof file.size === 'number' ? formatFileSize(file.size) : file.size} · ${status}`}>
            <span className="sdk-file-kind">{textFileKind(file.name)}</span><span className="chat-attachment-name">{file.name}</span>
            {file.status !== 'kept' && <span className="chat-attachment-status" role="status">{status}</span>}
            <button type="button" className="chat-attachment-remove" aria-label={`Remove ${file.name}`} disabled={disabled}
              onClick={() => onRemove(file.id)}>×</button>
          </div>
        );
      })}
    </div>
  );
}
