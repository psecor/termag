/**
 * Any file attached to a simple-UI chat message that doesn't go in its text
 * (Other files): a zip, a spreadsheet, a
 * binary, a text file over the inline cap. The browser uploads each one as
 * it is attached, through POST /api/projects/:id/chat/files (a raw body, not
 * base64 in the message), and the box keeps it in the chat's checkout
 * (agent/chat-files.js, chat-file-put); the message then names the path it
 * answers, for Claude to open with its tools.
 *
 * Behind chat-file-attachments-enabled, read for the person attaching, and
 * the box's chat-files-v1.
 */

/** The box keeps a chat's files (agent/chat-files.js). */
export const CHAT_FILES_CAPABILITY = 'chat-files-v1';
export const CHAT_FILE_ATTACHMENTS_FLAG = 'chat-file-attachments-enabled';
/** One file, as the box takes it (agent/chat-files.js MAX_FILE_BYTES). */
export const MAX_CHAT_FILE_BYTES = 20 * 1000 * 1000;
/** The upload route's raw body limit: a little over one file, so the route, not the parser, says it is too large. */
export const CHAT_FILE_BODY_LIMIT = '21mb';
/** The chat-file-put RPC's wait: up to ~27 MB of base64 to the box, which writes it before it answers. */
export const CHAT_FILE_PUT_TIMEOUT_MS = 60_000;
/** The body's type: not one a form or a no-cors fetch can send, so another site can't post a file. */
export const CHAT_FILE_CONTENT_TYPE = 'application/octet-stream';

type Refusal = { status: number; body: { error: string; code: string } };

/** An attached file's name from the query: no control characters, bounded, or null. The box makes it a safe path. */
export function chatFileName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return name || null;
}

/** Why an upload's body can't go, or null. */
export function chatFileBodyRefusal(body: unknown, contentType: string | undefined): Refusal | null {
  const media = contentType?.split(';')[0]?.trim().toLowerCase();
  if (media !== CHAT_FILE_CONTENT_TYPE || !Buffer.isBuffer(body)) {
    return { status: 415, body: { error: `Send the file as the request body with Content-Type: ${CHAT_FILE_CONTENT_TYPE}`, code: 'bad-file' } };
  }
  if (body.length === 0) return { status: 400, body: { error: 'The file is empty', code: 'bad-file' } };
  if (body.length > MAX_CHAT_FILE_BYTES) return { status: 413, body: { error: `Files can be up to ${MAX_CHAT_FILE_BYTES / 1_000_000} MB`, code: 'file-too-large' } };
  return null;
}

/**
 * Why this chat's box can't take a file, or null: an ask's thread (its turns
 * run in a clone of their own), or an agent from before chat-files-v1.
 */
export function chatFilesRefusal(capabilities: readonly string[], ask: boolean): Refusal | null {
  if (ask) return { status: 409, body: { error: "Files can't be attached in an ask's thread yet", code: 'files-unsupported' } };
  if (!capabilities.includes(CHAT_FILES_CAPABILITY)) {
    return { status: 409, body: { error: "This box's agent can't take files yet; it needs an update and a restart", code: 'files-unsupported' } };
  }
  return null;
}

/**
 * What GET …/chat says about files for this viewer: `fileInput` when the
 * composer offers them, and `fileRefusal`, why not, when the flag is on but
 * this box can't (the composer says so instead of offering them).
 */
export function chatFileInput(on: boolean, capabilities: readonly string[], ask: boolean): { fileInput: boolean; fileRefusal?: string } {
  if (!on) return { fileInput: false };
  const refusal = chatFilesRefusal(capabilities, ask);
  return refusal ? { fileInput: false, fileRefusal: refusal.body.error } : { fileInput: true };
}

/** The chat-file-put RPC's failure as the route's answer. */
export function chatFileRpcFailure(message: string): Refusal {
  const refused = /^file-refused: (.+)$/.exec(message);
  if (refused) return { status: 400, body: { error: refused[1].charAt(0).toUpperCase() + refused[1].slice(1), code: 'file-refused' } };
  if (/Unknown command/.test(message)) return { status: 409, body: { error: "This box's agent can't take files yet; it needs an update and a restart", code: 'files-unsupported' } };
  return { status: 502, body: { error: `The box did not keep the file: ${message}`, code: 'file-failed' } };
}

/** The box's answer, checked: the path it kept the file at (relative to the checkout), its name and size. */
export function chatFileKept(raw: unknown): { path: string; name: string; size: number } | null {
  const r = raw as { path?: unknown; name?: unknown; size?: unknown } | null;
  if (!r || typeof r.path !== 'string' || typeof r.name !== 'string' || typeof r.size !== 'number') return null;
  // The box answers .termag-attachments/<id>/<name>: never absolute, never up.
  if (!/^\.termag-attachments\/[0-9a-f]{16}\/[A-Za-z0-9._-]+$/.test(r.path)) return null;
  return { path: r.path, name: r.name, size: r.size };
}
