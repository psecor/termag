// Keep a transcript scrolled to the bottom as it grows, unless the reader has
// scrolled up; then flag that there is unseen output instead. `resetKey` names
// the conversation: when it changes (a view that stays mounted switches to
// another one) the new conversation opens following its latest output.
import { useCallback, useLayoutEffect, useRef, useState } from 'react';

const STICKY_PX = 48; // how close to the bottom still counts as "following"

// The position each scroller was last sent to here, until its scroll event
// arrives: ui.touch.scrolled (touchScrollEvents.ts) must not count a jump to
// the bottom as a finger's doing.
const followed = new WeakMap<Element, number>();

function toBottom(el: HTMLElement) {
  el.scrollTop = el.scrollHeight;
  followed.set(el, el.scrollTop);
}

/** Whether this scroll of `el` is the one toBottom caused (it is still where toBottom put it); forgets it either way. */
export function tookFollowBottomScroll(el: Element): boolean {
  const at = followed.get(el);
  if (at === undefined) return false;
  followed.delete(el);
  return at === el.scrollTop;
}

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
    if (following.current) toBottom(el);
    else setUnseen(true);
  }, [content]);
  // The scroller shrinking (a notice banner appearing above the pane, the
  // composer growing) keeps a follower at the bottom too. The scroller can
  // mount after the first render, so each render checks which one is watched.
  const watched = useRef<{ el: HTMLElement; ro: ResizeObserver } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (watched.current?.el === el) return;
    watched.current?.ro.disconnect();
    watched.current = null;
    if (!el || typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => { if (following.current) toBottom(el); });
    ro.observe(el);
    watched.current = { el, ro };
  });
  useLayoutEffect(() => () => { watched.current?.ro.disconnect(); watched.current = null; }, []);
  const jumpToBottom = useCallback(() => {
    const el = scroller.current;
    if (el) { toBottom(el); following.current = true; setUnseen(false); }
  }, []);
  return { scroller, onScroll, unseen, jumpToBottom };
}
