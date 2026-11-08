/**
 * Images (and PDFs) in a simple-UI chat message: what
 * POST /api/projects/:id/chat/messages accepts in `images`, checked before
 * anything reaches the box. The box checks again (agent/chat-images.js) and
 * keeps them; Claude gets them as image content blocks.
 */

/** The runner takes images with chat-send (agent/chat-images.js). */
export const CHAT_IMAGES_CAPABILITY = 'chat-images-v1';
/** The runner also takes PDFs in a send's `images`, as Claude document blocks. */
export const CHAT_PDFS_CAPABILITY = 'chat-pdfs-v1';
export const MAX_CHAT_IMAGES = 4;
/** Decoded bytes per image: the Messages API takes at most 5 MB of base64 per image. */
export const MAX_CHAT_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
/** The JSON body limit of the send route: four images at the cap in base64, plus the text. */
export const CHAT_MESSAGE_BODY_LIMIT = '22mb';
/** The chat-send RPC's wait when it carries images: up to ~20 MB to the box, which writes them before it answers. */
export const CHAT_IMAGE_SEND_TIMEOUT_MS = 30_000;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type ChatImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf';

/** The attachment type `buf` starts with: an image (no SVG: nothing a browser would run) or a PDF, or null. */
export function sniffAttachmentType(buf: Buffer): ChatImageType | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  return null;
}

/** `name`: a PDF's file name, its document title for Claude. */
export interface ChatImage { mediaType: ChatImageType; data: string; name?: string }

/** A sent file name, without control characters and bounded, or undefined. */
function attachmentName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return name || undefined;
}

export type ChatImagesCheck =
  | { ok: true; images: ChatImage[] }
  | { ok: false; status: number; error: string; code: string };

/**
 * A send's `images`, checked: a list of at most MAX_CHAT_IMAGES base64
 * PNG/JPEG/GIF/WebP images (by their bytes) of at most MAX_CHAT_IMAGE_BYTES.
 * Absent or empty is no images. The declared type is replaced by the sniffed one.
 */
export function checkChatImages(raw: unknown): ChatImagesCheck {
  if (raw == null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, status: 400, error: 'images must be a list', code: 'bad-image' };
  if (raw.length > MAX_CHAT_IMAGES) return { ok: false, status: 400, error: `At most ${MAX_CHAT_IMAGES} images per message`, code: 'too-many-images' };
  const images: ChatImage[] = [];
  for (const [i, item] of raw.entries()) {
    const data = item && typeof item === 'object' ? (item as { data?: unknown }).data : undefined;
    if (typeof data !== 'string' || !BASE64_RE.test(data)) {
      return { ok: false, status: 400, error: `Image ${i + 1} is not base64 data`, code: 'bad-image' };
    }
    // Decoded length from the base64 length, before decoding anything big.
    const bytes = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (bytes > MAX_CHAT_IMAGE_BYTES) {
      return { ok: false, status: 413, error: `Image ${i + 1} is larger than ${Math.round(MAX_CHAT_IMAGE_BYTES / 1024 / 1024 * 10) / 10} MB`, code: 'image-too-large' };
    }
    const mediaType = sniffAttachmentType(Buffer.from(data.slice(0, 24), 'base64'));
    if (!mediaType) return { ok: false, status: 415, error: `Attachment ${i + 1} is not a PNG, JPEG, GIF, WebP or PDF`, code: 'bad-image-type' };
    const name = mediaType === 'application/pdf' ? attachmentName((item as { name?: unknown }).name) : undefined;
    images.push({ mediaType, data, ...(name ? { name } : {}) });
  }
  return { ok: true, images };
}

/**
 * Why this send's images cannot go, or null: images need a box whose runner
 * takes them; `pdfs` of them, a runner that takes PDFs too.
 */
export function chatImagesRefusal(count: number, capabilities: readonly string[], pdfs = 0, backend: string | null = null): { status: number; error: string; code: string } | null {
  if (count === 0) return null;
  if (!capabilities.includes(CHAT_IMAGES_CAPABILITY)) {
    return { status: 409, error: "This box's chat runner cannot take images yet; it needs an update and a restart", code: 'images-unsupported' };
  }
  if (pdfs > 0 && !capabilities.includes(CHAT_PDFS_CAPABILITY)) {
    return { status: 409, error: "This box's chat runner cannot take PDFs yet; it needs an update and a restart", code: 'pdfs-unsupported' };
  }
  if (pdfs > 0 && backend) {
    return { status: 409, error: `PDFs go to Claude's own models; this chat runs on ${backend}`, code: 'pdfs-unsupported' };
  }
  return null;
}

/** How many of a send's checked images are PDFs. */
export function pdfCount(images: readonly ChatImage[]): number {
  return images.filter(i => i.mediaType === 'application/pdf').length;
}

/** Whether this viewer's composer offers images: on a box whose runner takes them. */
export function chatImageInput(capabilities: readonly string[]): boolean {
  return capabilities.includes(CHAT_IMAGES_CAPABILITY);
}

/** Whether it offers PDFs as well: images, on a runner that takes PDFs, in a chat on Claude's own models (no other `backend`). */
export function chatPdfInput(imageInput: boolean, capabilities: readonly string[], backend: string | null = null): boolean {
  return imageInput && capabilities.includes(CHAT_PDFS_CAPABILITY) && !backend;
}
