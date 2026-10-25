/**
 * Images in a simple-UI chat message: what
 * POST /api/projects/:id/chat/messages accepts in `images`, checked before
 * anything reaches the box. The box checks again (agent/chat-images.js) and
 * keeps them; Claude gets them as image content blocks.
 */

export const CHAT_IMAGE_INPUT_FLAG = 'chat-image-input-enabled';
/** The runner takes images with chat-send (agent/chat-images.js). */
export const CHAT_IMAGES_CAPABILITY = 'chat-images-v1';
export const MAX_CHAT_IMAGES = 4;
/** Decoded bytes per image: the Messages API takes at most 5 MB of base64 per image. */
export const MAX_CHAT_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
/** The JSON body limit of the send route: four images at the cap in base64, plus the text. */
export const CHAT_MESSAGE_BODY_LIMIT = '22mb';
/** The chat-send RPC's wait when it carries images: up to ~20 MB to the box, which writes them before it answers. */
export const CHAT_IMAGE_SEND_TIMEOUT_MS = 30_000;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export type ChatImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** The image type `buf` starts with (no SVG: nothing a browser would run), or null. */
export function sniffImageType(buf: Buffer): ChatImageType | null {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'image/gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export interface ChatImage { mediaType: ChatImageType; data: string }

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
    const mediaType = sniffImageType(Buffer.from(data.slice(0, 24), 'base64'));
    if (!mediaType) return { ok: false, status: 415, error: `Image ${i + 1} is not a PNG, JPEG, GIF or WebP`, code: 'bad-image-type' };
    images.push({ mediaType, data });
  }
  return { ok: true, images };
}

/**
 * Why this send's images cannot go, or null: images need the person's
 * chat-image-input-enabled and a box whose runner takes them.
 */
export function chatImagesRefusal(count: number, flagOn: boolean, capabilities: readonly string[]): { status: number; error: string; code: string } | null {
  if (count === 0) return null;
  if (!flagOn) return { status: 403, error: 'Images in chat messages are not turned on for you', code: 'images-disabled' };
  if (!capabilities.includes(CHAT_IMAGES_CAPABILITY)) {
    return { status: 409, error: "This box's chat runner cannot take images yet; it needs an update and a restart", code: 'images-unsupported' };
  }
  return null;
}

/** Whether this viewer's composer offers images: their flag, on a box whose runner takes them. */
export function chatImageInput(flagOn: boolean, capabilities: readonly string[]): boolean {
  return flagOn && capabilities.includes(CHAT_IMAGES_CAPABILITY);
}
