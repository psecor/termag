import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { prsApi, type PrRow } from '../services/api';
import { usePolled } from '../pages/dashboard/useDashboardData';
import type { SessionMilestone } from '../types';
import { PRS_CHANGED_EVENT, lanesOf, rowParam } from '../utils/prPipeline';
import { pillTarget, provisionalPill, withProvisional, worktreeKey, worktreePills, type WorktreePill } from '../utils/worktreePrs';

/**
 * Every workstream's pills, from the same /api/prs read as the PRs tile (the
 * backend memoizes it per user, so this costs GitHub nothing more). Re-read
 * when the overlay changes a PR.
 */
export function useWorktreePills(): (projectId: string, workstream: string, milestone: SessionMilestone | null | undefined) => WorktreePill[] {
  return useWorktreePrs().pillsFor;
}

/** The pills plus the rows behind them, for a caller that opens the overview itself (the phone header). */
export function useWorktreePrs(): {
  pillsFor: (projectId: string, workstream: string, milestone: SessionMilestone | null | undefined) => WorktreePill[];
  rowFor: (pill: WorktreePill) => PrRow | null;
  refresh: () => void;
} {
  const prs = usePolled(() => prsApi.list(), 60_000);
  const refresh = prs.refresh;
  useEffect(() => {
    window.addEventListener(PRS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PRS_CHANGED_EVENT, refresh);
  }, [refresh]);
  const byWorktree = useMemo(() => worktreePills(prs.data, Date.now()), [prs.data]);
  const rows = useMemo(() => lanesOf(prs.data).flatMap(l => l.rows), [prs.data]);
  return {
    pillsFor: (projectId, workstream, milestone) => {
      const listed = byWorktree.get(worktreeKey(projectId, workstream)) ?? [];
      return withProvisional(listed, provisionalPill(milestone, listed, Date.now()));
    },
    rowFor: pill => (pill.view ? rows.find(r => rowParam(r) === pill.key) ?? null : null),
    refresh,
  };
}

/**
 * A workstream's PR pills on its sidebar row (utils/worktreePrs.ts), most
 * pressing first and the faint past ones last. The first always shows; the
 * rest show while they fit, and those that do not wrap out of sight (one line
 * high, overflow hidden), so the past ones are the first to go. "+N" counts
 * the hidden ones, and the tooltip lists them all. A click opens the PR overlay
 * on that PR (GitHub for one the overlay does not list), not the workstream.
 */
export function WorktreePrPills({ pills }: { pills: WorktreePill[] }) {
  const rest = useRef<HTMLSpanElement | null>(null);
  const [hidden, setHidden] = useState(0);
  const count = pills.length;
  // Re-measure when the pills change, not only their number: the poll can swap one label for a wider one.
  const shape = pills.map(p => p.key).join(' ');
  useLayoutEffect(() => {
    const el = rest.current;
    if (!el) { setHidden(0); return; }
    const measure = () => {
      // Out of sight: wrapped below the one line, or (the first of a line, which never wraps) clipped at the right.
      const box = el.getBoundingClientRect();
      const kids = [...el.children].map(k => k.getBoundingClientRect());
      setHidden(kids.filter(r => r.top >= box.bottom - 1 || r.right > box.right + 1).length);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [shape]);
  if (count === 0) return null;
  const [top, ...others] = pills;
  return (
    <span className="worktree-pr-pills" title={pills.map(p => p.title).join('\n\n')}>
      <Pill p={top} />
      {others.length > 0 && (
        <span className="worktree-pr-rest" ref={rest}>
          {/* The hidden ones are always the last (wrapping goes in order): out of the tab order and the a11y tree. */}
          {others.map((p, i) => <Pill key={p.key} p={p} hidden={i >= others.length - hidden} />)}
        </span>
      )}
      {hidden > 0 && <span className="worktree-pr-more">+{hidden}</span>}
    </span>
  );
}

function Pill({ p, hidden = false }: { p: WorktreePill; hidden?: boolean }) {
  const navigate = useNavigate();
  const open = (e: React.MouseEvent) => {
    e.stopPropagation();
    const target = pillTarget(p, window.location.search);
    if (target && 'search' in target) navigate({ search: target.search });
    else if (target) window.open(target.href, '_blank', 'noopener,noreferrer');
  };
  return (
    <button
      type="button"
      className={`worktree-pr-pill is-${p.tone}`}
      title={p.title}
      tabIndex={hidden ? -1 : undefined}
      aria-hidden={hidden || undefined}
      onClick={open}
      onDoubleClick={e => e.stopPropagation()}
    >
      {p.label}
    </button>
  );
}
