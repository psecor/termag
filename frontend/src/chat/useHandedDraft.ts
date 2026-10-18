// The composer's text for a chat. It starts with the first message New chat
// handed over in the navigation state (only when storage would not queue it),
// read once per mount, and that history entry's state is cleared at once so a
// reload or back/forward cannot bring sent text back. It empties only when the
// chat itself changes, so a repeated effect (Strict Mode) never wipes it.
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

function draftIn(state: unknown): string | null {
  const draft = (state as { draft?: unknown } | null)?.draft;
  return typeof draft === 'string' ? draft : null;
}

export function useComposerText(chatKey: string): [string, (text: string) => void] {
  const location = useLocation();
  const navigate = useNavigate();
  const [text, setText] = useState(() => draftIn(location.state) ?? '');
  const hasDraft = draftIn(location.state) != null;

  useEffect(() => {
    if (hasDraft) navigate({ pathname: location.pathname, search: location.search }, { replace: true, state: null });
  }, [hasDraft, location.pathname, location.search, navigate]);

  // A draft belongs to the conversation it was typed for.
  const shownFor = useRef(chatKey);
  useEffect(() => {
    if (shownFor.current === chatKey) return;
    shownFor.current = chatKey;
    setText('');
  }, [chatKey]);

  return [text, setText];
}
