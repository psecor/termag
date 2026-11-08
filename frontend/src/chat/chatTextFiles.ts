// Text files in a simple-UI chat message (Text
// files): any dropped, pasted or picked file whose bytes are valid UTF-8,
// whatever its name, goes in the message itself, after what was typed, as a
// fenced block headed with its name. Claude reads it as text; the backend and
// the box see only text, so it needs no capability and no route of its own.
// The bubble reads the blocks back as file chips (splitTextFiles), live and
// from the stored transcript alike, and other clients (the full UI, the
// desktop app) show the Markdown as it is.

/** The send route's and the box's limit on a message's text (backend services/chatRunner.ts MAX_CHAT_TEXT). */
export const MAX_CHAT_TEXT = 100_000;
/** One text file, and a message's text files together, in characters (at most as many as its UTF-8 bytes); the rest is for what is typed. */
export const MAX_TEXT_FILE_CHARS = 90_000;
/** How much of a file too big to send is read to tell text from not. */
const SNIFF_BYTES = 4096;

/** A text file held for a message: its name and its text, exactly as the file has it. */
export interface TextFile { id: string; name: string; text: string }

/**
 * Any other file, kept on the chat's box (backend services/chatFiles.ts, agent
 * chat-files.js): `path` (under the checkout) once it is there; until then it
 * is uploading, or waiting for the box to wake.
 */
export interface BoxFile { id: string; name: string; size: number | string; path: string | null; status: 'uploading' | 'waking' | 'kept' }

/** A box file as a message names it, and as a bubble reads it back. */
export interface SentBoxFile { name: string; path: string; size: string }

const HEAD = 'Attached file: ';
const BOX_HEAD = 'Attached file on the box: ';
const BOX_LINE = /^Attached file on the box: (\.termag-attachments\/[0-9a-f]{16}\/([A-Za-z0-9._-]+)) \(([^()\n]+)\)$/;

/** A file name fit for the block's heading line: no control characters, bounded. */
function headingName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || 'file.txt';
}

/** The fence's info string: the file's extension, when it has a plain one. */
function fenceLang(name: string): string {
  return /\.([A-Za-z0-9+#-]{1,16})$/.exec(name)?.[1].toLowerCase() ?? '';
}

/** The chip's label for a file: its extension (four letters at most), or TXT. */
export function textFileKind(name: string): string {
  const ext = fenceLang(name);
  return ext && ext.length <= 4 && /^[a-z0-9]+$/.test(ext) ? ext.toUpperCase() : 'TXT';
}

/** A fence longer than any run of backticks in `text`, so nothing inside can close it. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

// The file's text exactly, then a newline and the closing fence: one that ends in a newline shows a blank
// line before the fence, and every file, one with no final newline or only a newline included, comes back as it was.
function block(file: Pick<TextFile, 'name' | 'text'>): string {
  const name = headingName(file.name);
  const fence = fenceFor(file.text);
  return `${HEAD}${name}\n${fence}${fenceLang(name)}\n${file.text}\n${fence}`;
}

/**
 * The message that goes: what was typed, then each text file as a fenced
 * block headed with its name, then a line naming where the box keeps each
 * other file (its path relative to the checkout, Claude's working directory).
 */
export function withTextFiles(typed: string, files: ReadonlyArray<Pick<TextFile, 'name' | 'text'>>, boxFiles: ReadonlyArray<{ path: string; size: number | string }> = []): string {
  if (!files.length && !boxFiles.length) return typed;
  const lines = boxFiles.map(f => `${BOX_HEAD}${f.path} (${typeof f.size === 'number' ? formatFileSize(f.size) : f.size})`);
  return [typed, ...files.map(block), ...lines].filter(Boolean).join('\n\n');
}

/** Box files read back from a message, held again (a draft handed over, a message taken back). */
export function heldBoxFiles(files: ReadonlyArray<SentBoxFile>, prefix: string): BoxFile[] {
  return files.map((f, n) => ({ id: `${prefix}-box${n}`, name: f.name, size: f.size, path: f.path, status: 'kept' as const }));
}

type Attached = { files: Array<{ name: string; text: string }>; boxFiles: SentBoxFile[] };

/** The blocks and box lines from `at` to the end of `text`, or null unless that is all it holds. */
function blocksFrom(text: string, at: number): Attached | null {
  const files: Array<{ name: string; text: string }> = [];
  const boxFiles: SentBoxFile[] = [];
  let p = at;
  for (;;) {
    if (text.startsWith(BOX_HEAD, p)) {
      const end = text.indexOf('\n', p);
      const line = BOX_LINE.exec(text.slice(p, end < 0 ? text.length : end));
      if (!line) return null;
      boxFiles.push({ path: line[1], name: line[2], size: line[3] });
      p = end < 0 ? text.length : end;
      if (p === text.length) return { files, boxFiles };
      if (!text.startsWith('\n\n', p)) return null;
      p += 2;
      continue;
    }
    if (!text.startsWith(HEAD, p)) return null;
    const nameEnd = text.indexOf('\n', p);
    if (nameEnd < 0) return null;
    const name = text.slice(p + HEAD.length, nameEnd);
    const openEnd = text.indexOf('\n', nameEnd + 1);
    if (openEnd < 0) return null;
    const open = /^(`{3,})[^`\n]*$/.exec(text.slice(nameEnd + 1, openEnd));
    if (!open || !name) return null;
    const fence = open[1];
    // Nothing inside holds a run of backticks this long, so the first one is the close.
    const close = text.indexOf(`\n${fence}`, openEnd + 1);
    if (close < 0) return null;
    files.push({ name, text: text.slice(openEnd + 1, close) });
    p = close + 1 + fence.length;
    if (p === text.length) return { files, boxFiles };
    if (!text.startsWith('\n\n', p)) return null;
    p += 2;
  }
}

/**
 * A sent message's typed text and its text files (withTextFiles' blocks at
 * its end), or the text as it is with none. Typed text that happens to end
 * in such a block reads as a file too, which is what it would say anyway.
 */
export function splitTextFiles(message: string): { text: string; files: Array<{ name: string; text: string }>; boxFiles?: SentBoxFile[] } {
  const MARK = 'Attached file';
  if (!message.includes(MARK)) return { text: message, files: [] };
  // Where the blocks may start, earliest first: the earliest from which the rest is all blocks has every file.
  const starts: Array<{ cut: number; at: number }> = message.startsWith(MARK) ? [{ cut: 0, at: 0 }] : [];
  for (let i = message.indexOf(`\n\n${MARK}`); i >= 0; i = message.indexOf(`\n\n${MARK}`, i + 1)) starts.push({ cut: i, at: i + 2 });
  for (const { cut, at } of starts) {
    const found = blocksFrom(message, at);
    if (found) return { text: message.slice(0, cut), files: found.files, ...(found.boxFiles.length ? { boxFiles: found.boxFiles } : {}) };
  }
  return { text: message, files: [] };
}

/** A file's size as Finder says it: bytes, KB or MB, in thousands. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${Math.ceil(bytes / 100) / 10} KB`;
  return `${Math.ceil(bytes / 100_000) / 10} MB`;
}

function readBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsArrayBuffer(blob);
  });
}

/**
 * `bytes` as text when they are valid UTF-8 with no NUL (what a binary file
 * has), else null. `partial`: they are a file's start, which may end inside a
 * character.
 */
export function decodeText(bytes: Uint8Array, partial = false): string | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: partial });
  } catch {
    return null;
  }
  return text.includes('\u0000') ? null : text;
}

let nextId = 0;

/** Why a file can't go as text: it isn't text, it is over the cap, or it doesn't fit beside the others. A box may take it instead. */
export class TextFileRefusal extends Error {
  constructor(message: string, readonly reason: 'not-text' | 'too-large' | 'no-room') { super(message); }
}

/**
 * A file as a text file to send, with `room` characters left of
 * MAX_TEXT_FILE_CHARS. Throws a sentence to show: not text, or too big.
 */
export async function prepareTextFile(file: File, room = MAX_TEXT_FILE_CHARS): Promise<TextFile> {
  const name = file.name || 'file.txt';
  const notText = `${name} can't be attached: only text files, images and PDFs can`;
  const limit = `text files go in the message up to ${formatFileSize(MAX_TEXT_FILE_CHARS)}`;
  // Bigger than that in bytes, it cannot fit in characters: only its start is read, to say which it is.
  if (file.size > MAX_TEXT_FILE_CHARS * 4) {
    if (decodeText(await readBytes(file.slice(0, SNIFF_BYTES)), true) == null) throw new TextFileRefusal(notText, 'not-text');
    throw new TextFileRefusal(`${name} is ${formatFileSize(file.size)}: ${limit}`, 'too-large');
  }
  const text = decodeText(await readBytes(file));
  if (text == null) throw new TextFileRefusal(notText, 'not-text');
  if (text.length > MAX_TEXT_FILE_CHARS) throw new TextFileRefusal(`${name} is ${formatFileSize(file.size)}: ${limit}`, 'too-large');
  if (text.length > room) throw new TextFileRefusal(noRoom(name), 'no-room');
  return { id: `txt${++nextId}`, name, text };
}

/**
 * Claude Code's cutoffs: a paste over 800 characters or with more than two line
 * breaks goes as a text file (pastedTextFile) rather than into the box.
 */
export const PASTE_AS_FILE_CHARS = 800;
export const PASTE_AS_FILE_BREAKS = 2;
const PASTED = /^Pasted text #(\d+)\b/;
const lineBreaks = (text: string) => text.match(/\r\n|\r|\n/g)?.length ?? 0;

/** Whether pasted text is long enough to be held as a file. */
export function pastesAsFile(text: string): boolean {
  return text.length > PASTE_AS_FILE_CHARS || lineBreaks(text) > PASTE_AS_FILE_BREAKS;
}

/**
 * A long paste as a text file, named as Claude Code names one ("Pasted text #1
 * +39 lines": its line breaks), numbered after the pastes already held. It goes
 * in the message like any text file, so nothing pasted is cut at the box's
 * limit and the bubble shows the chip, not the wall of text.
 */
export function pastedTextFile(text: string, held: ReadonlyArray<Pick<TextFile, 'name'>>): TextFile {
  const n = 1 + held.reduce((max, f) => Math.max(max, Number(PASTED.exec(f.name)?.[1] ?? 0)), 0);
  const breaks = lineBreaks(text);
  return { id: `txt${++nextId}`, name: breaks ? `Pasted text #${n} +${breaks} lines` : `Pasted text #${n}`, text };
}

/** What the composer says of a text file that would take the message's text files past MAX_TEXT_FILE_CHARS. */
export function noRoom(name: string): string {
  return `${name} doesn't fit: a message's text files go in the message up to ${formatFileSize(MAX_TEXT_FILE_CHARS)} in all`;
}

/** Text files read back from a message, held again (a draft handed over, a message taken back), with ids. */
export function heldTextFiles(files: ReadonlyArray<Pick<TextFile, 'name' | 'text'>>, prefix: string): TextFile[] {
  return files.map((f, n) => ({ id: `${prefix}-file${n}`, name: f.name, text: f.text }));
}

/**
 * Whether a message queued before Claude is ready may join the one already
 * waiting (useQueuedMessage enqueue appends it after a space, and a sent
 * queue is taken off as its prefix): not when either carries files, whose
 * blocks must stay at the message's end, and only within MAX_CHAT_TEXT.
 * Answers why not, or null.
 */
export function queueJoinRefusal(waiting: string, text: string): string | null {
  const a = splitTextFiles(waiting);
  const b = splitTextFiles(text);
  if (a.files.length || b.files.length || a.boxFiles || b.boxFiles) {
    return 'A message is already waiting for Claude, and files go in a message of their own: send this once Claude is ready';
  }
  if (messageTooLong(`${waiting} ${text}`)) return 'This and the message already waiting for Claude are too long to send together: send it once Claude is ready';
  return null;
}

/** Characters the held files take of MAX_TEXT_FILE_CHARS. */
export function textFilesChars(files: ReadonlyArray<Pick<TextFile, 'text'>>): number {
  return files.reduce((n, f) => n + f.text.length, 0);
}

/** Why a message this long cannot go, or null: the send route's and the box's MAX_CHAT_TEXT. */
export function messageTooLong(message: string): string | null {
  if (message.length <= MAX_CHAT_TEXT) return null;
  return `This message and its files come to ${message.length.toLocaleString('en-US')} characters, over the ${MAX_CHAT_TEXT.toLocaleString('en-US')} a message can be: remove a file or shorten the message`;
}
