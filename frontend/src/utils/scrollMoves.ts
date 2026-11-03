// Whether a scroll moves `el` on screen: what scrolled is the page, or a
// scroller `el` sits in. Something floating by `el` (a tooltip) goes with
// such a scroll and stays through any other, the chat's transcript following
// new output among them. React Aria closes its non-modal popovers by the same
// rule (useCloseOnScroll, which it doesn't export).
export function scrollMoves(e: Event, el: Element | null): boolean {
  if (!el) return false;
  const what = e.target;
  return !(what instanceof Node) || what.contains(el);
}
