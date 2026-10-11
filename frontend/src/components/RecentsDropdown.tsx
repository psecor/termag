import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useProjects } from '../contexts/ProjectContext';
import { useRecents } from '../hooks/useRecents';
import type { RecentRow } from '../services/api';
import { filterRecents, isCurrentRecent, RECENTS_DEFAULT_LIMIT } from '../utils/recents';
import { RecentsList, recentKey } from './RecentsList';

const FILTER_FROM = RECENTS_DEFAULT_LIMIT + 1;

/**
 * "Recents ▾" in the sidebar header: the last sessions you opened, as a
 * popover you can drive from the keyboard. Jumping, not browsing — archived
 * projects and MetaTerm are left out (the dashboard section shows them).
 */
export function RecentsDropdown() {
  const { projects, activeProjectId, setActiveProject, setActiveWorkstream, getActiveWorkstream } = useProjects();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(Date.now());
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // One hook instance: its limit follows the "all" toggle, and its request
  // sequencing means a slow limit=10 response can't overwrite the full list.
  // Slice defensively so toggling back to ten never shows the stale full
  // list while the smaller fetch is in flight.
  const { rows: fetched, refresh } = useRecents(showAll ? 'all' : RECENTS_DEFAULT_LIMIT);
  const source = fetched === null ? null : showAll ? fetched : fetched.slice(0, RECENTS_DEFAULT_LIMIT);

  const rows = useMemo(() => filterRecents(source ?? [], { query }), [source, query]);
  const activeWs = activeProjectId ? getActiveWorkstream(activeProjectId) : 'main';
  const currentKey = useMemo(() => {
    const cur = rows.find(r => isCurrentRecent(r, activeProjectId, activeWs));
    return cur ? recentKey(cur) : null;
  }, [rows, activeProjectId, activeWs]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    refresh();
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [open, refresh]);

  // Reset highlight when the list changes; focus the filter when it appears.
  useEffect(() => { setActive(0); }, [query, showAll, open]);
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0); }, [open, showAll]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const select = (r: RecentRow) => {
    // Only switch to projects the sidebar knows about (own + shared, unarchived);
    // the server already filtered, this is belt and braces.
    if (!projects.some(p => p.id === r.projectId)) return;
    // Order matters: the workstream first, so setActiveProject records the
    // visit and writes ?ws= from the updated map (the context mirrors it into
    // its ref synchronously for exactly this back-to-back call).
    setActiveWorkstream(r.projectId, r.workstream || 'main');
    setActiveProject(r.projectId);
    setOpen(false);
    setQuery('');
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); btnRef.current?.focus(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(rows.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter' && rows[active]) { e.preventDefault(); select(rows[active]); }
  };

  // Keep the highlighted row in view.
  useEffect(() => {
    if (!open) return;
    popRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const anchor = btnRef.current?.getBoundingClientRect();
  const style: React.CSSProperties | undefined = anchor
    ? { top: anchor.bottom + 6, left: Math.max(8, Math.min(anchor.left, window.innerWidth - 380)) }
    : undefined;
  const showFilter = (source?.length ?? 0) >= FILTER_FROM || showAll;

  return (
    <>
      <button
        ref={btnRef}
        className={`btn-ghost recents-trigger${open ? ' is-open' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Recently opened sessions"
      >
        Recents <span aria-hidden>▾</span>
      </button>
      {open && createPortal(
        <div className="recents-popover" ref={popRef} style={style} onKeyDown={onKey} role="dialog" aria-label="Recent sessions">
          <div className="recents-popover-head">
            <span>Recents</span>
            <button type="button" className="recents-link" onClick={() => setShowAll(s => !s)}>
              {showAll ? `last ${RECENTS_DEFAULT_LIMIT}` : 'all'}
            </button>
          </div>
          {showFilter && (
            <input
              ref={inputRef}
              className="recents-filter"
              placeholder="Filter…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              aria-label="Filter recent sessions"
            />
          )}
          {!showFilter && <div tabIndex={0} ref={el => { if (el && !inputRef.current) el.focus(); }} className="recents-focus-trap" />}
          <div className="recents-scroll">
            {source === null
              ? <div className="recents-empty">Loading…</div>
              : <RecentsList rows={rows} now={now} mode="button" onSelect={select} currentKey={currentKey} activeIndex={active} />}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
