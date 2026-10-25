import React, { useCallback } from 'react';
import { useProjects } from '../contexts/ProjectContext';
import { InboxRow, stateSince, statusLabel } from '../mobile/inbox';
import { StatusDot } from './StatusDot';
import { fmtAge } from '../utils/format';
import { reviewRingTooltip } from '../utils/reviewRing';
import { FOCUS_PANE_EVENT, FocusPaneDetail, resolveWorkstream, WorkspaceTarget } from '../utils/workspaceTarget';
import { BoxPill } from './BoxPill';

/**
 * Switch the workspace to a target: the
 * workstream first, so setActiveProject records the visit with it (as the
 * Recents switcher does), then ask MainLayout to focus the pane once the
 * new terminals have mounted.
 */
export function useOpenTarget(): (t: WorkspaceTarget) => void {
  const { projects, setActiveProject, setActiveWorkstream } = useProjects();
  return useCallback((t: WorkspaceTarget) => {
    if (t.kind === 'external') { window.open(t.url, '_blank', 'noopener'); return; }
    const project = t.kind === 'pane' ? projects.find(p => p.id === t.projectId) : undefined;
    if (t.kind !== 'pane' || !project) return;
    // A pane hit comes from the live tmux inventory, which can outlive its
    // workstream (archived or deleted with the session still up): open main.
    const workstream = resolveWorkstream(project.workstreams, t.workstream);
    setActiveWorkstream(t.projectId, workstream);
    setActiveProject(t.projectId);
    const detail: FocusPaneDetail = { projectId: t.projectId, workstream, pane: t.pane };
    setTimeout(() => window.dispatchEvent(new CustomEvent(FOCUS_PANE_EVENT, { detail })), 0);
  }, [projects, setActiveProject, setActiveWorkstream]);
}

/** One row, exported for the palette's mixed lists; data-index drives keyboard highlighting. */
export function SessionItem({ row, now, index, active, onSelect, box }: {
  row: InboxRow; now: number; index: number; active: boolean; onSelect: (row: InboxRow) => void;
  /** The box's name, shown as its pill (the simple UI's ⌘K). */
  box?: string | null;
}) {
  const since = stateSince(row);
  const age = since ? now - Date.parse(since) : NaN;
  const detail = [statusLabel(row), row.message?.trim()].filter(Boolean).join(' · ');
  return (
    <li role="option" aria-selected={active}>
      <button type="button" className={`recents-item${active ? ' is-active' : ''}`} onClick={() => onSelect(row)} data-index={index}>
        <span className="recents-status session-list-status" aria-hidden>
          <StatusDot status={row.status} />
          {row.ring && <span className={`review-ring is-${row.ring}`} title={reviewRingTooltip(row.ring, row.review?.pr, row.review?.reviewer)} />}
        </span>
        <span className="recents-body">
          <span className="recents-title">
            <span className="recents-name">{row.projectName}</span>
            {row.workstream !== 'main' && <span className="workstream-bar-badge">{row.workstream}</span>}
            {row.shared && <span className="recents-tag" title={`Owned by ${row.owner}`}>shared</span>}
            {row.kind === 'cloud' && <span className="recents-tag">cloud</span>}
            {box && <BoxPill instanceId={row.instanceId} label={box} className="recents-box" />}
          </span>
          <span className="recents-detail session-list-detail">{detail}</span>
        </span>
        <span className="recents-when">{Number.isFinite(age) ? fmtAge(Math.max(0, age)) : ''}</span>
      </button>
    </li>
  );
}

/**
 * Sessions from the home model (mobile/inbox.ts) in the Recents row style:
 * status and review ring, project · workstream, what state it is in and for
 * how long. Shared by the status strip's popovers and the search palette.
 */
export function SessionList({ rows, now, activeIndex = -1, onSelect, empty }: {
  rows: InboxRow[]; now: number; activeIndex?: number; onSelect: (row: InboxRow) => void; empty: string;
}) {
  if (rows.length === 0) return <div className="recents-empty">{empty}</div>;
  return (
    <ul className="recents-list" role="listbox">
      {rows.map((r, i) => <SessionItem key={r.key} row={r} now={now} index={i} active={i === activeIndex} onSelect={onSelect} />)}
    </ul>
  );
}
