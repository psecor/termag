import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { HOME_FILTERS, HomeFilter, InboxRow, matchesFilter } from '../mobile/inbox';
import { useHome } from '../mobile/useHome';
import { prsApi } from '../services/api';
import { usePolled } from '../pages/dashboard/useDashboardData';
import { PRS_CHANGED_EVENT, actionableCount, prsSearch, prsTileView } from '../utils/prPipeline';
import { clampIndex } from '../utils/searchPalette';
import { rowTarget } from '../utils/workspaceTarget';
import { SessionList, useOpenTarget } from './SessionList';


/**
 * The phone's summary strip on the desktop: the
 * three home counts, each opening a popover of its sessions, and the PRs
 * count (everything that needs you, utils/prPipeline needsYou) opening the PR
 * overlay over the workspace (components/PrsOverlay.tsx).
 */
export function StatusStrip() {
  const { rows, counts, now } = useHome();
  const openTarget = useOpenTarget();
  // Everything that needs you, as on the phone; the backend memoizes per user,
  // so this shares one GitHub read with the overlay, the dashboard and /m/prs.
  const prs = usePolled(() => prsApi.list(), 60_000);
  const location = useLocation();
  const refreshPrs = prs.refresh;
  useEffect(() => {
    window.addEventListener(PRS_CHANGED_EVENT, refreshPrs);
    return () => window.removeEventListener(PRS_CHANGED_EVENT, refreshPrs);
  }, [refreshPrs]);
  const prTile = prsTileView(prs.data, prs.error, actionableCount(prs.data));
  const [open, setOpen] = useState<HomeFilter | null>(null);
  const [active, setActive] = useState(0);
  const stripRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => (open ? rows.filter(r => matchesFilter(r, open)) : []), [rows, open]);

  useEffect(() => {
    document.title = counts.attention > 0 ? `(${counts.attention}) termag` : 'termag';
    return () => { document.title = 'termag'; };
  }, [counts.attention]);

  useEffect(() => { setActive(0); }, [open]);
  // Sessions leave the list as their state changes under the highlight.
  useEffect(() => { setActive(i => clampIndex(i, shown.length)); }, [shown.length]);
  useEffect(() => { if (open) popRef.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || stripRef.current?.contains(t)) return;
      setOpen(null);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  useEffect(() => {
    if (open) popRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const select = (r: InboxRow) => { setOpen(null); openTarget(rowTarget(r)); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(null); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(shown.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter' && shown[active]) { e.preventDefault(); select(shown[active]); }
  };

  const anchor = stripRef.current?.getBoundingClientRect();
  const style: React.CSSProperties | undefined = anchor
    ? { top: anchor.bottom + 6, left: Math.max(8, Math.min(anchor.left, window.innerWidth - 380)) }
    : undefined;
  const tile = HOME_FILTERS.find(t => t.id === open);

  return (
    <>
      <div className="status-strip" ref={stripRef} role="group" aria-label="Session counts">
        {HOME_FILTERS.map(t => (
          <button
            key={t.id}
            type="button"
            className={`status-tile${open === t.id ? ' is-open' : ''}`}
            data-filter={t.id}
            data-zero={counts[t.id] === 0 || undefined}
            aria-haspopup="listbox"
            aria-expanded={open === t.id}
            title={t.title}
            onClick={() => setOpen(o => (o === t.id ? null : t.id))}
          >
            <span className="status-tile-count">{counts[t.id]}</span>
            <span className="status-tile-label">{t.short}</span>
          </button>
        ))}
        {prTile.show && (
          <Link
            className={`status-tile${prTile.failed ? ' is-failed' : ''}`}
            data-filter="prs"
            data-zero={prTile.zero || undefined}
            to={{ search: prsSearch(location.search, 'needs_you') }}
            title={prTile.title}
          >
            <span className="status-tile-count">{prTile.text}</span>
            <span className="status-tile-label">PRs</span>
          </Link>
        )}
      </div>
      {open && tile && createPortal(
        <div className="recents-popover" ref={popRef} style={style} onKeyDown={onKey} tabIndex={-1} role="dialog" aria-label={tile.title}>
          <div className="recents-popover-head"><span>{tile.title}</span><span>{shown.length}</span></div>
          <div className="recents-scroll">
            <SessionList rows={shown} now={now} activeIndex={active} onSelect={select} empty={tile.empty} />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
