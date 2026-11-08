// The images, PDFs and text files a composer holds for its next message:
// dropped, pasted or picked, admitted and made
// small enough to send by chat/chatImageData.ts, or read as text by
// chat/chatTextFiles.ts (anything else whose bytes are UTF-8). One hook for every composer that takes them, an open
// chat's (pages/chat/useSdkChat.ts) and New session's first message
// (pages/chat/NewChat.tsx), so both take the same types, as many, as large,
// and say the same thing about what they leave out.
import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { admitImages, dragHasFiles, filesOf, isChatImageType, isPdfFile, MAX_CHAT_IMAGES, prepareAttachment, type PreparedImage } from './chatImageData';
import { formatFileSize, MAX_TEXT_FILE_CHARS, noRoom, pastedTextFile, pastesAsFile, prepareTextFile, TextFileRefusal, textFilesChars, type BoxFile, type TextFile } from './chatTextFiles';

/** The largest file the box keeps (backend services/chatFiles.ts MAX_CHAT_FILE_BYTES). */
export const MAX_BOX_FILE_BYTES = 20 * 1000 * 1000;

/** Uploads one file to the chat's box, saying meanwhile when it is waiting for the box to wake; answers where it was kept. */
export type BoxFileUpload = (file: File, waiting: () => void) => Promise<{ path: string; name: string; size: number }>;

export interface ComposerAttachments {
  images: PreparedImage[];
  setImages: React.Dispatch<React.SetStateAction<PreparedImage[]>>;
  /** Text files, which go in the message's text (chat/chatTextFiles.ts withTextFiles), not beside it. */
  files: TextFile[];
  setFiles: React.Dispatch<React.SetStateAction<TextFile[]>>;
  /** The text files held now, for a callback that must not wait for a render. */
  filesRef: React.MutableRefObject<TextFile[]>;
  /** Other files, kept on the box: the message names their paths (chat/chatTextFiles.ts withTextFiles). */
  boxFiles: BoxFile[];
  setBoxFiles: React.Dispatch<React.SetStateAction<BoxFile[]>>;
  /** A file is still on its way to the box: the message can't name it yet. */
  uploading: boolean;
  /** What the last attach left out, or why an image could not be read. */
  note: string | null;
  setNote: React.Dispatch<React.SetStateAction<string | null>>;
  /** Files are still being read and made small enough: a send now would leave them behind. */
  preparing: boolean;
  /** Files are being dragged over the drop target. */
  dragging: boolean;
  setDragging: React.Dispatch<React.SetStateAction<boolean>>;
  /** The images held now, for a callback that must not wait for a render. */
  imagesRef: React.MutableRefObject<PreparedImage[]>;
  attach: (files: File[]) => Promise<void>;
  /** An image, PDF or text file goes, by its id. */
  remove: (id: string) => void;
  /** The images, the text files and their note go, as after a send. */
  clear: () => void;
  /** A paste into the message: its files are attached, and admitImages notes what cannot be sent; long text is held as a text file. */
  onPaste: (e: React.ClipboardEvent) => void;
  /** Drag and drop handlers for the element files may be dropped on; `after` runs once a drop is taken. */
  dropHandlers: (after?: () => void) => Pick<React.DOMAttributes<HTMLElement>, 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'>;
}

export interface ComposerAttachmentOptions {
  /** PDFs are taken too, beside images (chat-pdfs-v1, on Claude's own models). */
  pdfs?: boolean;
  /** Images on their way into the composer from elsewhere, whose room counts as taken (useSdkChat's take-backs). */
  coming?: React.MutableRefObject<number>;
  /** Any other file goes to the box this way (chat-file-attachments-enabled, chat-files-v1); absent, it is refused. */
  upload?: BoxFileUpload;
  /** Why this chat's box can't take other files, said of one it refuses (GET …/chat fileRefusal). */
  uploadRefusal?: string;
}

let boxId = 0;

/**
 * A paste replaces what is selected; one held as a chip still has to drop it. The input event
 * reaches the controlled box's onChange like a keystroke would.
 */
function dropSelection(box: EventTarget) {
  if (!(box instanceof HTMLTextAreaElement || box instanceof HTMLInputElement)) return;
  const { selectionStart: start, selectionEnd: end } = box;
  if (start === null || end === null || start === end) return;
  box.setRangeText('', start, end, 'end');
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

export function useComposerAttachments({ pdfs = false, coming, upload, uploadRefusal }: ComposerAttachmentOptions = {}): ComposerAttachments {
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [files, setFiles] = useState<TextFile[]>([]);
  const [boxFiles, setBoxFiles] = useState<BoxFile[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState(0);
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const filesRef = useRef(files);
  filesRef.current = files;
  // One file to the box: its chip shows at once, says when it waits for the box to wake, and gets its path,
  // or goes with a note saying why. One removed meanwhile stays gone.
  const sendToBox = useCallback(async (f: File, notes: string[]) => {
    const name = f.name || 'file';
    if (f.size > MAX_BOX_FILE_BYTES) { notes.push(`${name} is ${formatFileSize(f.size)}: files can be up to ${formatFileSize(MAX_BOX_FILE_BYTES)}`); setNote(notes.join('. ')); return; }
    const id = `box${++boxId}`;
    setBoxFiles(held => [...held, { id, name, size: f.size, path: null, status: 'uploading' }]);
    try {
      const kept = await upload!(f, () => setBoxFiles(held => held.map(b => (b.id === id ? { ...b, status: 'waking' } : b))));
      setBoxFiles(held => held.map(b => (b.id === id ? { ...b, name: kept.name, size: kept.size, path: kept.path, status: 'kept' } : b)));
    } catch (err) {
      setBoxFiles(held => held.filter(b => b.id !== id));
      setNote(`${name} didn't reach the box: ${(err as Error).message}`);
    }
  }, [upload]);
  // Dropped, pasted or picked files: the images (and, where taken, PDFs) among them, made small enough
  // to send; anything else, as text when it is, within MAX_TEXT_FILE_CHARS in all.
  const attach = useCallback(async (dropped: File[]) => {
    if (!dropped.length) return;
    const reserved = coming?.current ?? 0;
    const media = dropped.filter(f => isChatImageType(f.type) || (pdfs && isPdfFile(f)));
    const refusedPdfs = pdfs ? [] : dropped.filter(f => !isChatImageType(f.type) && isPdfFile(f));
    const others = dropped.filter(f => !isChatImageType(f.type) && !isPdfFile(f));
    const { take, note: left } = admitImages(imagesRef.current.length + reserved, media, pdfs);
    const notes = [...(refusedPdfs.length ? ["This chat can't take PDFs"] : []), ...(left ? [left] : [])];
    setNote(notes.length ? notes.join('. ') : null);
    const ready: PreparedImage[] = [];
    const texts: TextFile[] = [];
    setPreparing(n => n + 1);
    try {
      for (const f of take) {
        try { ready.push(await prepareAttachment(f)); } catch (err) { notes.push((err as Error).message); }
      }
      if (ready.length) setImages(held => [...held, ...ready].slice(0, Math.max(held.length, MAX_CHAT_IMAGES - (coming?.current ?? 0))));
      const toBox: File[] = [];
      for (const f of others) {
        const room = MAX_TEXT_FILE_CHARS - textFilesChars(filesRef.current) - textFilesChars(texts);
        try {
          texts.push(await prepareTextFile(f, room));
        } catch (err) {
          // Not text, or more than goes in a message: the box keeps it, where it can.
          if (err instanceof TextFileRefusal && upload) toBox.push(f);
          // Where the box can't keep it either, say both: why not as text, and why not on the box.
          else if (err instanceof TextFileRefusal && uploadRefusal) {
            notes.push(err.reason === 'not-text' ? `${f.name || 'That file'} can't be attached: ${uploadRefusal}` : `${err.message}; the box can't keep it instead: ${uploadRefusal}`);
          }
          else notes.push((err as Error).message);
        }
      }
      for (const f of toBox) void sendToBox(f, notes);
      // Checked again against what is held now: another attach may have added files while these were read.
      let left = MAX_TEXT_FILE_CHARS - textFilesChars(filesRef.current);
      const fit = texts.filter(t => {
        if (t.text.length > left) { notes.push(noRoom(t.name)); return false; }
        left -= t.text.length;
        return true;
      });
      if (fit.length) {
        filesRef.current = [...filesRef.current, ...fit];
        setFiles(filesRef.current);
      }
    } finally {
      setPreparing(n => n - 1);
    }
    setNote(notes.length ? notes.join('. ') : null);
  }, [pdfs, coming, upload, uploadRefusal, sendToBox]);
  const remove = useCallback((id: string) => { setImages(held => held.filter(i => i.id !== id)); setFiles(held => held.filter(f => f.id !== id)); setBoxFiles(held => held.filter(f => f.id !== id)); }, []);
  const clear = useCallback(() => { setImages([]); setFiles([]); setBoxFiles([]); setNote(null); }, []);
  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const files = filesOf(e.clipboardData.files);
    const text = e.clipboardData.getData('text/plain');
    if (!files.length) {
      // Long text is held as a file (chatTextFiles.ts pastedTextFile): the box would cut it at its limit.
      if (!pastesAsFile(text)) return;
      e.preventDefault();
      if (text.length > MAX_TEXT_FILE_CHARS - textFilesChars(filesRef.current)) { setNote(noRoom('The pasted text')); return; }
      filesRef.current = [...filesRef.current, pastedTextFile(text, filesRef.current)];
      setFiles(filesRef.current);
      setNote(null);
      dropSelection(e.currentTarget);
      return;
    }
    // An image copied with its caption (a web page) pastes both; a bare image pastes nothing else.
    if (!text) e.preventDefault();
    void attach(files);
  }, [attach]);
  const dropHandlers = useCallback((after?: () => void) => ({
    onDragEnter: (e: React.DragEvent) => { if (dragHasFiles(e.dataTransfer.types)) { e.preventDefault(); setDragging(true); } },
    onDragOver: (e: React.DragEvent) => { if (dragHasFiles(e.dataTransfer.types)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); },
    onDrop: (e: React.DragEvent) => {
      if (!dragHasFiles(e.dataTransfer.types)) return;
      e.preventDefault();
      setDragging(false);
      void attach(filesOf(e.dataTransfer.files));
      after?.();
    },
  }), [attach]);
  return { images, setImages, files, setFiles, filesRef, boxFiles, setBoxFiles, uploading: boxFiles.some(b => !b.path), note, setNote, preparing: preparing > 0, dragging, setDragging, imagesRef, attach, remove, clear, onPaste, dropHandlers };
}
