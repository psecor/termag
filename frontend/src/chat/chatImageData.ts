// Images in a simple-UI chat message: what
// the composer accepts (dropped, pasted or picked), made small enough to
// send, as the base64 the backend's POST …/chat/messages takes in `images`.
// The limits mirror backend/src/services/chatImages.ts, which checks again.

export const MAX_CHAT_IMAGES = 4;
/** Decoded bytes per image: the Messages API takes at most 5 MB of base64 per image. */
export const MAX_CHAT_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
/** Longer than this and the model sees it downscaled anyway; sending it bigger only costs upload. */
export const MAX_IMAGE_EDGE = 2000;
export const CHAT_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const CHAT_IMAGE_ACCEPT = CHAT_IMAGE_TYPES.join(',');

/** One image ready to send: `data` is what the backend takes, `src` what the composer and bubble show. */
export interface PreparedImage { id: string; mediaType: string; data: string; src: string; name: string }

export function isChatImageType(type: string): boolean {
  return (CHAT_IMAGE_TYPES as readonly string[]).includes(type);
}

/** The image files among dropped or pasted items (a drag of text, or a folder, has none). */
export function imageFilesOf(list: { readonly length: number; [i: number]: File } | null | undefined): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (let i = 0; i < list.length; i++) if (list[i].type.startsWith('image/')) out.push(list[i]);
  return out;
}

/** Whether a drag carries files at all, which is all a dragover may know. */
export function dragHasFiles(types: readonly string[] | DOMStringList | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types as ArrayLike<string>).includes('Files');
}

/**
 * Which of `files` the composer takes, holding `held` already: the
 * supported types, up to MAX_CHAT_IMAGES in all, with one note for what it
 * left out.
 */
export function admitImages(held: number, files: readonly File[]): { take: File[]; note: string | null } {
  const supported = files.filter(f => isChatImageType(f.type));
  const room = Math.max(0, MAX_CHAT_IMAGES - held);
  const take = supported.slice(0, room);
  const notes: string[] = [];
  if (supported.length < files.length) notes.push('Only PNG, JPEG, GIF and WebP images can be sent');
  if (supported.length > room) notes.push(`At most ${MAX_CHAT_IMAGES} images per message`);
  return { take, note: notes.length ? notes.join('. ') : null };
}

/** Width and height that fit `max` on the longer edge, or the same when they already do. */
export function scaledSize(width: number, height: number, max = MAX_IMAGE_EDGE): { width: number; height: number } {
  const edge = Math.max(width, height);
  if (edge <= max || edge === 0) return { width, height };
  const k = max / edge;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** Decoded bytes of a base64 string, from its length. */
export function base64Bytes(data: string): number {
  return Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

function readDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = url;
  });
}

let nextId = 0;

/**
 * A file as an image to send: as it is when it is small enough, else drawn
 * smaller (at most MAX_IMAGE_EDGE on its long edge) and re-encoded, a JPEG on
 * white for anything without transparency to keep. Throws a sentence to show.
 */
export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!isChatImageType(file.type)) throw new Error(`${file.name || 'That file'} is not a PNG, JPEG, GIF or WebP image`);
  const original = await readDataUrl(file);
  const img = await loadImage(original).catch(() => { throw new Error(`${file.name || 'That image'} could not be read`); });
  const id = `img${++nextId}`;
  const name = file.name || 'image';
  const fits = Math.max(img.naturalWidth, img.naturalHeight) <= MAX_IMAGE_EDGE;
  if (fits && file.size <= MAX_CHAT_IMAGE_BYTES) {
    return { id, mediaType: file.type, data: original.slice(original.indexOf(',') + 1), src: original, name };
  }
  const size = scaledSize(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`${name} could not be resized`);
  // PNG keeps transparency (a screenshot); everything else goes to JPEG, which has none.
  const keepPng = file.type === 'image/png';
  if (!keepPng) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size.width, size.height); }
  ctx.drawImage(img, 0, 0, size.width, size.height);
  const attempts: Array<[string, number | undefined]> = keepPng
    ? [['image/png', undefined], ['image/jpeg', 0.9], ['image/jpeg', 0.75]]
    : [['image/jpeg', 0.9], ['image/jpeg', 0.75]];
  for (const [type, quality] of attempts) {
    if (type === 'image/jpeg' && keepPng) { ctx.globalCompositeOperation = 'destination-over'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size.width, size.height); }
    const src = canvas.toDataURL(type, quality);
    const data = src.slice(src.indexOf(',') + 1);
    if (base64Bytes(data) <= MAX_CHAT_IMAGE_BYTES) return { id, mediaType: type, data, src, name };
  }
  throw new Error(`${name} is too large to send, even made smaller`);
}

/** Where the backend serves an image the box keeps for a chat (routes/sessions.ts, the read-image RPC). */
export function storedImageUrl(projectId: string, workstream: string, path: string): string {
  const q = new URLSearchParams({ workstream, path });
  return `/termag/api/projects/${encodeURIComponent(projectId)}/image?${q}`;
}

export type LoadedImage = { kind: 'image'; url: string } | { kind: 'error'; message: string };

/** A hold on one cached image: its read, and the release a thumbnail calls when it unmounts. */
export interface ImageHold { loaded: Promise<LoadedImage>; release: () => void }

/**
 * A bounded cache of image reads whose blob URLs are revoked only once no
 * thumbnail holds them. Past `max` entries the oldest is dropped; one a
 * mounted thumbnail still shows keeps its URL until its last hold goes, so
 * a long chat's earlier images never go blank. A failed read is dropped at
 * once, so the next mount tries again.
 */
export function createImageCache(load: (url: string) => Promise<LoadedImage>, revoke: (blobUrl: string) => void, max: number) {
  type Entry = { loaded: Promise<LoadedImage>; holds: number; evicted: boolean };
  const entries = new Map<string, Entry>();
  const free = (e: Entry) => { void e.loaded.then(r => { if (r.kind === 'image') revoke(r.url); }); };
  const evict = () => {
    for (const [key, e] of entries) {
      if (entries.size <= max) break;
      entries.delete(key);
      e.evicted = true;
      if (e.holds === 0) free(e);
    }
  };
  function hold(url: string): ImageHold {
    let e = entries.get(url);
    if (!e) {
      const entry: Entry = { loaded: load(url), holds: 0, evicted: false };
      e = entry;
      entries.set(url, entry);
      void entry.loaded.then(r => { if (r.kind === 'error' && entries.get(url) === entry) entries.delete(url); });
    }
    const entry = e;
    entry.holds++;
    evict();
    let released = false;
    return {
      loaded: entry.loaded,
      release: () => {
        if (released) return;
        released = true;
        entry.holds--;
        if (entry.holds === 0 && entry.evicted) free(entry);
      },
    };
  }
  return { hold, size: () => entries.size };
}
