// Dictation for one composer (chat/dictation.ts): the mic button's state, the
// note under the box, and the keys a composer hands it first.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { FLAGS, useFlag } from '../flags';
import { Dictation, dictationEngine, dictationErrorText, engineMemory, isBlockedError, isDictationShortcut, type DictationState } from './dictation';
import { localRecognitionCtor } from './localRecognition';

export interface DictationInput {
  text: string;
  setText: (text: string) => void;
  /** The composer's length cap; dictated text past it is cut off. */
  max: number;
  /** The conversation the composer is for: switching it stops listening. */
  chatKey?: string;
}

export interface DictationControl {
  /** Shown at all: the flag is on and this browser can recognise speech. */
  available: boolean;
  /** The microphone is refused for this site until the person allows it. */
  blocked: boolean;
  state: DictationState;
  listening: boolean;
  /** The last error, until the next start. */
  error: string | null;
  /** The on-device speech model's first download, 0–1, while dictation waits for it. */
  loading: number | null;
  toggle(): void;
  cancel(): void;
  /** Stop listening and keep what is in the box (before a send). */
  detach(): void;
  /**
   * The composer's keydown, first: the shortcut toggles, Esc cancels while
   * listening. True when it handled the key.
   */
  onKeyDown(e: React.KeyboardEvent): boolean;
  /** The composer's change: typing over the words being dictated stops listening. */
  onEdit(): void;
}

function browserWindow() {
  return typeof window !== 'undefined' ? window : null;
}

function browserStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function useDictation({ text, setText, max, chatKey }: DictationInput): DictationControl {
  const flagOn = useFlag(FLAGS.chatVoiceInput, false);
  const Ctor = useMemo(() => {
    const win = browserWindow();
    return dictationEngine(win as Parameters<typeof dictationEngine>[0], localRecognitionCtor(win as Parameters<typeof localRecognitionCtor>[0]), engineMemory(browserStorage()));
  }, []);
  const available = flagOn && Ctor != null;

  const [state, setState] = useState<DictationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState<number | null>(null);

  const textRef = useRef(text);
  textRef.current = text;
  const setTextRef = useRef(setText);
  setTextRef.current = setText;
  const maxRef = useRef(max);
  maxRef.current = max;
  // Every value dictation has put in the box this session, oldest first. A
  // render can lag behind them (the recogniser fires again before React runs
  // the last render's effects), so the box showing any of them is dictation's
  // own output; anything else came from outside (a send cleared it, another
  // field replaced it).
  const written = useRef<string[]>([]);

  const dictation = useMemo(() => {
    if (!available || !Ctor) return null;
    const lang = typeof navigator !== 'undefined' ? navigator.language || 'en-US' : 'en-US';
    return new Dictation(Ctor, lang, {
      onText: t => {
        const next = t.slice(0, maxRef.current);
        written.current.push(next);
        setTextRef.current(next);
      },
      onState: setState,
      onProgress: setLoading,
      onError: code => {
        setError(dictationErrorText(code));
        if (isBlockedError(code)) setBlocked(true);
      },
    });
  }, [available, Ctor]);

  // A microphone already refused for this site disables the button up front,
  // and allowing it again (in the browser's site settings) enables it.
  useEffect(() => {
    if (!available || typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let status: PermissionStatus | null = null;
    let gone = false;
    const sync = () => { if (status) setBlocked(status.state === 'denied'); };
    navigator.permissions.query({ name: 'microphone' as PermissionName }).then(s => {
      if (gone) return;
      status = s;
      sync();
      s.addEventListener('change', sync);
    }).catch(() => { /* Safari before 16 and others do not know "microphone" */ });
    return () => { gone = true; status?.removeEventListener('change', sync); };
  }, [available]);

  // Leaving the conversation, or the page, stops listening.
  useEffect(() => () => dictation?.detach(), [dictation, chatKey]);

  // Text the composer set itself, while listening, stops dictation: otherwise
  // the next result would write the spoken words back over it.
  useEffect(() => {
    if (!dictation || dictation.state === 'idle') return;
    const at = written.current.lastIndexOf(text);
    // Values older than the one on screen can no longer arrive.
    if (at >= 0) written.current = written.current.slice(at);
    else dictation.detach();
  }, [text, dictation]);

  const listening = state !== 'idle';

  const toggle = useCallback(() => {
    if (!dictation) return;
    if (dictation.state === 'idle') {
      setError(null);
      written.current = [];
      dictation.start(textRef.current);
    } else {
      dictation.stop();
    }
  }, [dictation]);
  const cancel = useCallback(() => dictation?.cancel(), [dictation]);
  const detach = useCallback(() => dictation?.detach(), [dictation]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!dictation) return false;
    if (isDictationShortcut({ key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey })) {
      e.preventDefault();
      if (!blocked || dictation.state !== 'idle') toggle();
      return true;
    }
    if (e.key === 'Escape' && dictation.state !== 'idle') {
      e.preventDefault();
      dictation.cancel();
      return true;
    }
    return false;
  }, [dictation, toggle, blocked]);

  const onEdit = useCallback(() => {
    if (dictation && dictation.state !== 'idle') dictation.detach();
  }, [dictation]);

  return { available, blocked, state, listening, error, loading, toggle, cancel, detach, onKeyDown, onEdit };
}
