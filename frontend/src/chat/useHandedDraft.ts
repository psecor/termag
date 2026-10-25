// The composer's text for a chat. It starts with the first message New chat
// handed over in the navigation state (only when storage would not queue it),
// read once per mount, and that history entry's state is cleared at once so a
// reload or back/forward cannot bring sent text back. Otherwise it starts with
// the chat's unsent draft: what was typed is kept per chat in localStorage, so
// switching chats or reloading never loses it, and sending (an empty
// composer) drops it.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

const DRAFT_PREFIX = 'termag.chat.draft.';

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): DraftStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function readDraft(store: DraftStorage | null, chatKey: string): string {
  try { return store?.getItem(DRAFT_PREFIX + chatKey) ?? ''; } catch { return ''; }
}

export function writeDraft(store: DraftStorage | null, chatKey: string, text: string): void {
  try {
    if (text) store?.setItem(DRAFT_PREFIX + chatKey, text);
    else store?.removeItem(DRAFT_PREFIX + chatKey);
  } catch { /* full or blocked: the draft lives only in this view */ }
}

function draftIn(state: unknown): string | null {
  const draft = (state as { draft?: unknown } | null)?.draft;
  return typeof draft === 'string' ? draft : null;
}

export function useComposerText(chatKey: string): [string, (text: string) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const [text, setTextState] = useState(() => draftIn(location.state) ?? readDraft(storage(), chatKey));
  const hasDraft = draftIn(location.state) != null;

  useEffect(() => {
    if (hasDraft) navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
  }, [hasDraft, location.pathname, location.search, navigate]);

  // A draft belongs to the conversation it was typed for.
  const shownFor = useRef(chatKey);
  useEffect(() => {
    if (shownFor.current === chatKey) return;
    shownFor.current = chatKey;
    setTextState(readDraft(storage(), chatKey));
  }, [chatKey]);

  const setText = useCallback((next: string) => {
    writeDraft(storage(), shownFor.current, next);
    setTextState(next);
  }, []);

  return [text, setText];
}
