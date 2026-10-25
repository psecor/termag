// A click in a simple-UI transcript puts the cursor back in the composer, as
// in a chat app, unless the click meant something else: a tap (focusing would
// pop the phone's keyboard), a modified or non-primary click, the end of a text
// selection, or a click on something in the transcript that takes clicks itself
// (links, tool cards, Retry, a code block's Copy).
import { useCallback, useRef } from 'react';
import type React from 'react';

export interface TranscriptClick {
  /** The pointerType of the pointerdown that started the click; null when there was none (a keyboard "click"). */
  pointerType: string | null;
  button: number;
  modified: boolean;
  /** What the click leaves selected in the document. */
  selectionText: string;
  targetIsInteractive: boolean;
  composerDisabled: boolean;
  composerFocused: boolean;
}

export function shouldFocusComposer(c: TranscriptClick): boolean {
  if (c.pointerType !== 'mouse' && c.pointerType !== 'pen') return false;
  if (c.button !== 0 || c.modified) return false;
  if (c.selectionText !== '') return false;
  return !c.targetIsInteractive && !c.composerDisabled && !c.composerFocused;
}

const INTERACTIVE = [
  'a', 'button', 'input', 'textarea', 'select', 'summary', 'label', 'option', 'video', 'audio',
  '[contenteditable]:not([contenteditable="false"])',
  ...['button', 'link', 'menuitem', 'checkbox', 'radio', 'switch', 'tab', 'option', 'textbox', 'slider'].map(r => `[role="${r}"]`),
  '[tabindex]:not([tabindex^="-"])',
].join(', ');

/** Whether `target` is, or sits inside, something that handles its own clicks, short of `boundary` (the transcript). */
export function isInteractiveTarget(target: EventTarget | null, boundary: Element): boolean {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const hit = el?.closest(INTERACTIVE);
  return hit != null && hit !== boundary && boundary.contains(hit);
}

/** Handlers for the transcript scroller. `enabled` is whether the composer takes input now. */
export function useTranscriptFocus(composer: React.RefObject<HTMLTextAreaElement | null>, enabled: boolean) {
  // A click event doesn't say what pointer made it in every browser; its pointerdown does.
  const pointer = useRef<string | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent) => { pointer.current = e.pointerType; }, []);
  const onClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const pointerType = pointer.current;
    pointer.current = null;
    const input = composer.current;
    if (!input) return;
    const focus = shouldFocusComposer({
      pointerType,
      button: e.button,
      modified: e.altKey || e.ctrlKey || e.metaKey || e.shiftKey,
      selectionText: window.getSelection()?.toString() ?? '',
      targetIsInteractive: isInteractiveTarget(e.target, e.currentTarget),
      composerDisabled: !enabled || input.disabled,
      composerFocused: document.activeElement === input,
    });
    if (focus) input.focus({ preventScroll: true });
  }, [composer, enabled]);
  return { onPointerDown, onClick };
}
