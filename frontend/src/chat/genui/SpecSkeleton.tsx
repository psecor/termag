// What a ```spec fence shows until it can be drawn: while it streams in, and
// while the renderer's chunk loads. The shape of a small card, so the surface
// doesn't jump when it arrives.
export function SpecSkeleton() {
  return (
    <div className="genui-skeleton" role="status" aria-live="polite">
      <div className="genui-skeleton-line" style={{ width: '38%' }} />
      <div className="genui-skeleton-line" style={{ width: '82%' }} />
      <div className="genui-skeleton-line" style={{ width: '64%' }} />
      <span className="genui-skeleton-label">Drawing the UI…</span>
    </div>
  );
}
