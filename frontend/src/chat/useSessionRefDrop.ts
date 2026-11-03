// A composer that takes a session dropped on it (chat/sessionRef.ts): the
// reference goes into the message at the drop point (the end of the word
// there), or at the caret where the browser can't say, and a session that
// can't be messaged says why in the composer's notes for a few seconds. Only
// a drag that carries a reference is taken: images and anything else go on
// to their own handlers.
import type React from 'react';
import { useEffect, useState } from 'react';
import { FLAGS, useFlag } from '../flags';
import { insertRef, readSessionRef, SESSION_REF_TYPE, wordEnd } from './sessionRef';

const NOTE_MS = 6000;

const carriesRef = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes(SESSION_REF_TYPE);

/** Where in the textarea a drop at (x, y) lands, where the browser says (CSSOM's caretPositionFromPoint on a text control). */
function dropOffset(input: HTMLTextAreaElement, x: number, y: number): number | null {
  const doc = input.ownerDocument as Document & { caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null };
  const at = doc.caretPositionFromPoint?.(x, y);
  return at && at.offsetNode === input ? at.offset : null;
}

export function useSessionRefDrop({ input, text, setText, max }: {
  input: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (text: string) => void;
  /** The longest message the composer takes; a reference that doesn't fit is refused, not cut. */
  max: number;
}) {
  // Off, the composer takes no reference, whatever a drag carries.
  const on = useFlag(FLAGS.chatSessionReferences, false);
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);
  // stopPropagation: a sidebar tab's drag refuses every drop outside its own space (OpenItems.tsx).
  const handlers = {
    onDragEnter: (e: React.DragEvent) => { if (carriesRef(e)) { e.preventDefault(); e.stopPropagation(); setOver(true); } },
    onDragOver: (e: React.DragEvent) => {
      if (!carriesRef(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); },
    onDrop: (e: React.DragEvent) => {
      if (!carriesRef(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setOver(false);
      const ref = readSessionRef(e.dataTransfer.getData(SESSION_REF_TYPE));
      const el = input.current;
      if (!ref || !el || el.disabled) return;
      if ('refusal' in ref) { setNote(ref.refusal); return; }
      const point = dropOffset(el, e.clientX, e.clientY);
      const at = point === null ? null : wordEnd(text, point);
      const next = insertRef(text, at ?? el.selectionStart, at ?? el.selectionEnd, ref.text);
      if (next.value.length > max) { setNote('The message is too long to take that reference.'); return; }
      setNote(null);
      setText(next.value);
      requestAnimationFrame(() => { el.focus(); el.setSelectionRange(next.caret, next.caret); });
    },
  };
  return { handlers: on ? handlers : {}, over, note };
}
