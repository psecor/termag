// Keep a transcript scrolled to the bottom as it grows, unless the reader has
// scrolled up; then flag that there is unseen output instead. `resetKey` names
// the conversation: when it changes (a view that stays mounted switches to
// another one) the new conversation opens following its latest output.
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const STICKY_PX = 48; // how close to the bottom still counts as "following"

export function useFollowBottom(content: unknown, resetKey: string) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [unseen, setUnseen] = useState(false);
  useLayoutEffect(() => {
    following.current = true;
    setUnseen(false);
  }, [resetKey]);
  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_PX;
    if (following.current) setUnseen(false);
  }, []);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || content == null) return;
    if (following.current) el.scrollTop = el.scrollHeight;
    else setUnseen(true);
  }, [content]);
  const jumpToBottom = useCallback(() => {
    const el = scroller.current;
    if (el) { el.scrollTop = el.scrollHeight; following.current = true; setUnseen(false); }
  }, []);
  return { scroller, onScroll, unseen, jumpToBottom };
}
