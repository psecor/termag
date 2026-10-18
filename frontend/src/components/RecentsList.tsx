import React from 'react';
import { Link } from 'react-router-dom';
import type { RecentRow } from '../services/api';
import { StatusDot } from './StatusDot';
import { fmtAge } from '../utils/format';
import { agentActivityLabel, recentHref } from '../utils/recents';

interface Props {
  rows: RecentRow[];
  now: number;
  /** 'link' navigates by URL (dashboard); 'button' calls onSelect (in-workspace switcher). */
  mode: 'link' | 'button';
  onSelect?: (row: RecentRow) => void;
  /** Row to mark as the one currently open. */
  currentKey?: string | null;
  /** Keyboard-highlighted index (switcher). */
  activeIndex?: number;
  /** Stable key for a row: used for current/active matching. */
  rowKey?: (row: RecentRow) => string;
}

export const recentKey = (r: Pick<RecentRow, 'projectId' | 'workstream'>) => `${r.projectId}:${r.workstream || 'main'}`;

/**
 * The rows of "Recents", shared by the sidebar switcher and the dashboard
 * section. Primary line: status glyph, project, workstream badge, box stripe.
 * Secondary line: what the agent has been doing (not visit counts — the
 * question being answered is "is this still live?"). Right edge: when the
 * user last opened it.
 */
export function RecentsList({ rows, now, mode, onSelect, currentKey, activeIndex = -1, rowKey = recentKey }: Props) {
  if (rows.length === 0) {
    return <div className="recents-empty">No sessions visited yet. Select a project and it shows up here.</div>;
  }
  return (
    <ul className="recents-list" role={mode === 'button' ? 'listbox' : undefined}>
      {rows.map((r, i) => {
        const key = rowKey(r);
        const isCurrent = currentKey != null && key === currentKey;
        const visited = now - Date.parse(r.lastVisitedAt);
        const stripe = r.color ?? undefined;
        const body = (
          <>
            <span className="recents-status"><StatusDot status={r.status} /></span>
            <span className="recents-body">
              <span className="recents-title">
                {stripe && <i className="recents-stripe" style={{ background: stripe }} />}
                <span className="recents-name">{r.projectName}</span>
                {r.workstream && r.workstream !== 'main' && <span className="workstream-bar-badge">{r.workstream}</span>}
                {r.access === 'collaborator' && <span className="recents-tag" title={`Owned by ${r.owner}`}>shared</span>}
                {r.archived && <span className="recents-tag recents-tag--archived">archived</span>}
                {isCurrent && <span className="recents-tag recents-tag--current">current</span>}
              </span>
              <span className="recents-detail">{agentActivityLabel(r, now, fmtAge)}</span>
            </span>
            <span className="recents-when" title={new Date(r.lastVisitedAt).toLocaleString()}>
              {Number.isFinite(visited) ? `${fmtAge(Math.max(0, visited))} ago` : ''}
            </span>
          </>
        );
        const cls = `recents-item${isCurrent ? ' is-current' : ''}${i === activeIndex ? ' is-active' : ''}${r.archived ? ' is-archived' : ''}`;
        return (
          <li key={key} role={mode === 'button' ? 'option' : undefined} aria-selected={mode === 'button' ? i === activeIndex : undefined}>
            {mode === 'link'
              ? <Link className={cls} to={recentHref(r)}>{body}</Link>
              : <button type="button" className={cls} onClick={() => onSelect?.(r)} data-index={i}>{body}</button>}
          </li>
        );
      })}
    </ul>
  );
}
