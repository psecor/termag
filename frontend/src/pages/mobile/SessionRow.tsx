// One session row, shared by the home list and the Search tab, plus the
// row's ⋯ action sheet (pin / archive / open in full UI).
import React, { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { PROVIDERS } from '../../providers/registry';
import { contextLevel } from '../../utils/thresholds';
import { fmtAge } from '../../utils/format';
import { conversationHref, InboxRow, opensReview, stateSince, STATUS_GLYPH, statusLabel } from '../../mobile/inbox';
import { optOutOfMobile } from '../../mobile/redirect';
import { projectsApi } from '../../services/api';
import { ActionSheet, ConfirmSheet, apiError } from './Sheet';

function ctxLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`;
}

/** The glyph: the agent's, except a row whose state is its review shows the review's. */
const REVIEW_GLYPH = '◎';

export function SessionRow({ row, now, recent, onMore, onOpen, href }: {
  row: InboxRow;
  now: number;
  /** Recent sessions: the clock is when you opened it, not the state's age. */
  recent?: boolean;
  /** The row's ⋯ sheet; without it the row has no ⋯ (the share picker). */
  onMore?: (row: InboxRow) => void;
  /** Where the row goes instead of its conversation (the share picker's draft link). */
  href?: string;
  onOpen?: (row: InboxRow) => void;
}) {
  const badge = row.provider ? PROVIDERS[row.provider]?.badge ?? row.provider.slice(0, 2).toUpperCase() : null;
  const reviewLed = opensReview(row);
  const since = stateSince(row);
  const clock = recent && row.lastVisitedAt
    ? `opened ${fmtAge(Math.max(0, now - Date.parse(row.lastVisitedAt)))} ago`
    : since ? fmtAge(Math.max(0, now - Date.parse(since))) : '';
  const ctx = row.contextTokens != null ? contextLevel(row.contextTokens) : 'ok';
  const label = statusLabel(row);
  const body = (
    <>
        <span className="m-glyph" data-status={row.status} data-ring={reviewLed ? row.ring ?? undefined : undefined} aria-hidden>
          {reviewLed ? REVIEW_GLYPH : STATUS_GLYPH[row.status]}
        </span>
        <span className="m-row-main">
          <span className="m-row-title">
            {row.kind === 'metaterm' && <span className="m-metaterm" aria-hidden>⚡ </span>}
            {row.kind === 'automation' && <span className="m-automation" aria-label="automation run">⏱ </span>}
            {row.kind === 'cloud' && <span className="m-cloud" aria-label="cloud session">☁ </span>}
            {row.projectName}
            {row.workstream !== 'main' && <span className="m-ws"> · {row.workstream}</span>}
            {row.shared && <span className="m-owner"> ({row.owner})</span>}
          </span>
          {row.message && <span className="m-row-preview">{row.message}</span>}
        </span>
        <span className="m-row-side">
          <span className="m-row-state" data-band={row.band}>{label}</span>
          <span className="m-row-badges">
            {/* A review beside a running or waiting agent: the row reads as the agent, the badge says Devin is at it too. */}
            {!reviewLed && row.ring && <span className="m-badge m-badge-review" data-ring={row.ring} title={statusLabel({ ...row, status: 'idle' })}>RV</span>}
            {badge && <span className="m-badge" title={row.provider ?? ''}>{badge}</span>}
            {row.rateLimited && <span className="m-badge m-badge-danger" title={row.rateLimited}>RATE</span>}
            {!row.rateLimited && row.contextTokens != null && ctx !== 'ok' && (
              <span className={`m-badge m-badge-${ctx}`}>{ctxLabel(row.contextTokens)}</span>
            )}
            <span className="m-row-clock">{clock}</span>
          </span>
        </span>
    </>
  );
  // A cloud session has no pane here: the row opens the session on claude.ai.
  if (row.kind === 'cloud') {
    return (
      <li className="m-row-wrap">
        {row.url
          ? <a className="m-row" href={row.url} target="_blank" rel="noreferrer" data-status={row.status} onClick={() => onOpen?.(row)}>{body}</a>
          : <span className="m-row" data-status={row.status}>{body}</span>}
      </li>
    );
  }
  return (
    <li className="m-row-wrap">
      <Link className="m-row" to={href ?? conversationHref(row)} data-status={row.status} data-band={row.band} onClick={() => onOpen?.(row)}>{body}</Link>
      {onMore && <button className="m-more" aria-label={`Actions for ${row.projectName}`} onClick={() => onMore(row)}>⋯</button>}
    </li>
  );
}

/** The ⋯ sheet and its archive confirm; `sheets` renders them, `error` is the inline banner text. */
export function useRowActions(): { open: (row: InboxRow) => void; sheets: React.ReactNode; error: string; clearError: () => void } {
  const { reloadProjects } = useProjects();
  const navigate = useNavigate();
  const [menuRow, setMenuRow] = useState<InboxRow | null>(null);
  const [confirmRow, setConfirmRow] = useState<InboxRow | null>(null);
  const [error, setError] = useState('');
  const closeMenu = useCallback(() => setMenuRow(null), []);
  const closeConfirm = useCallback(() => setConfirmRow(null), []);
  const clearError = useCallback(() => setError(''), []);
  const togglePin = async (row: InboxRow) => {
    try { await projectsApi.togglePin(row.projectId); await reloadProjects(); }
    catch (err) { setError(apiError(err, 'Could not change the pin')); }
  };
  const archive = async (row: InboxRow) => {
    try { await projectsApi.archive(row.projectId); await reloadProjects(); }
    catch (err) { setError(apiError(err, 'Could not archive the project')); }
  };
  const openFull = (row: InboxRow) => {
    optOutOfMobile();
    navigate(`/?project=${encodeURIComponent(row.projectId)}${row.workstream !== 'main' ? `&ws=${encodeURIComponent(row.workstream)}` : ''}`);
  };
  const sheets = (
    <>
      {menuRow && (
        <ActionSheet
          title={`${menuRow.projectName}${menuRow.workstream !== 'main' ? ` · ${menuRow.workstream}` : ''}`}
          onClose={closeMenu}
          actions={[
            { label: menuRow.pinned ? 'Unpin' : 'Pin', onClick: () => { void togglePin(menuRow); }, disabled: menuRow.shared },
            { label: 'Archive project…', onClick: () => setConfirmRow(menuRow), danger: true, disabled: menuRow.shared || menuRow.kind === 'metaterm' },
            { label: 'Open in full UI', onClick: () => openFull(menuRow) },
          ]}
        />
      )}
      {confirmRow && (
        <ConfirmSheet
          message={<>Archive <strong>{confirmRow.projectName}</strong>? This kills every tmux session of the project, all workstreams included.</>}
          confirmLabel="Archive"
          danger
          onConfirm={() => { void archive(confirmRow); }}
          onClose={closeConfirm}
        />
      )}
    </>
  );
  return { open: setMenuRow, sheets, error, clearError };
}
