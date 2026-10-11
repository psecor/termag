import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useProjects } from '../../contexts/ProjectContext';
import { useConnection } from '../../contexts/ConnectionContext';
import { useRecents } from '../../hooks/useRecents';
import { PROVIDERS } from '../../providers/registry';
import { contextLevel } from '../../utils/thresholds';
import { fmtAge } from '../../utils/format';
import { buildInbox, defaultGroup, INBOX_GROUPS, InboxGroupId, InboxRow, normalizeGroupId, SECTION_LABEL, STATUS_GLYPH, waitingLabel, workingCount } from '../../mobile/inbox';
import { writeOptOut } from '../../mobile/redirect';
import { projectsApi, prsApi } from '../../services/api';
import { usePolled } from '../dashboard/useDashboardData';
import { actionableCount } from '../../utils/prPipeline';
import { cloudSessionFeed } from '../../services/cloudSessionFeed';
import { FLAGS, useFlag } from '../../flags';
import { ActionSheet, ConfirmSheet, apiError } from './Sheet';

// The chosen tab lives in the URL (?g=) so Back from a conversation returns
// to it, and in localStorage so the next visit opens on it too.
const GROUP_KEY = 'termag-mobile-group';
function readStoredGroup(): InboxGroupId | null {
  try { return normalizeGroupId(localStorage.getItem(GROUP_KEY)); } catch { return null; }
}

function conversationHref(row: InboxRow): string {
  const ws = row.workstream !== 'main' ? `?ws=${encodeURIComponent(row.workstream)}` : '';
  return `/m/p/${encodeURIComponent(row.projectId)}${ws}`;
}

function ctxLabel(tokens: number): string {
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}K`;
}

function Row({ row, now, recent, onMore }: { row: InboxRow; now: number; recent: boolean; onMore: (row: InboxRow) => void }) {
  const badge = row.provider ? PROVIDERS[row.provider]?.badge ?? row.provider.slice(0, 2).toUpperCase() : null;
  const preview = row.message ?? (row.status === 'waiting' ? waitingLabel(row.waitingReason) : null);
  const clock = recent && row.lastVisitedAt
    ? `opened ${fmtAge(Math.max(0, now - Date.parse(row.lastVisitedAt)))} ago`
    : row.updatedAt ? fmtAge(Math.max(0, now - Date.parse(row.updatedAt))) : '';
  const ctx = row.contextTokens != null ? contextLevel(row.contextTokens) : 'ok';
  const body = (
    <>
        <span className="m-glyph" data-status={row.status} aria-label={row.status}>{STATUS_GLYPH[row.status]}</span>
        <span className="m-row-main">
          <span className="m-row-title">
            {row.kind === 'metaterm' && <span className="m-metaterm" aria-hidden>⚡ </span>}
            {row.kind === 'cloud' && <span className="m-cloud" aria-label="cloud session">☁ </span>}
            {row.projectName}
            {row.workstream !== 'main' && <span className="m-ws"> · {row.workstream}</span>}
            {row.shared && <span className="m-owner"> ({row.owner})</span>}
          </span>
          {preview && <span className="m-row-preview">{preview}</span>}
        </span>
        <span className="m-row-side">
          <span className="m-row-badges">
            {badge && <span className="m-badge" title={row.provider ?? ''}>{badge}</span>}
            {row.rateLimited && <span className="m-badge m-badge-danger" title={row.rateLimited}>RATE</span>}
            {!row.rateLimited && row.contextTokens != null && ctx !== 'ok' && (
              <span className={`m-badge m-badge-${ctx}`}>{ctxLabel(row.contextTokens)}</span>
            )}
          </span>
          <span className="m-row-clock">{clock}</span>
        </span>
    </>
  );
  // A cloud session has no pane here: the row opens the session on claude.ai.
  if (row.kind === 'cloud') {
    return (
      <li className="m-row-wrap">
        {row.url
          ? <a className="m-row" href={row.url} target="_blank" rel="noreferrer" data-status={row.status}>{body}</a>
          : <span className="m-row" data-status={row.status}>{body}</span>}
      </li>
    );
  }
  return (
    <li className="m-row-wrap">
      <Link className="m-row" to={conversationHref(row)} data-status={row.status}>{body}</Link>
      <button className="m-more" aria-label={`Actions for ${row.projectName}`} onClick={() => onMore(row)}>⋯</button>
    </li>
  );
}

export function Inbox() {
  const { user } = useAuth();
  const { projects, statusMap, reloadProjects } = useProjects();
  const connection = useConnection();
  const navigate = useNavigate();

  // Row actions: a sheet per row, a confirm for archive, an inline error line.
  const [menuRow, setMenuRow] = useState<InboxRow | null>(null);
  const [confirmRow, setConfirmRow] = useState<InboxRow | null>(null);
  const [actionError, setActionError] = useState('');
  const closeMenu = useCallback(() => setMenuRow(null), []);
  const closeConfirm = useCallback(() => setConfirmRow(null), []);
  const togglePin = async (row: InboxRow) => {
    try { await projectsApi.togglePin(row.projectId); await reloadProjects(); }
    catch (err) { setActionError(apiError(err, 'Could not change the pin')); }
  };
  const archive = async (row: InboxRow) => {
    try { await projectsApi.archive(row.projectId); await reloadProjects(); }
    catch (err) { setActionError(apiError(err, 'Could not archive the project')); }
  };
  const openFull = (row: InboxRow) => {
    writeOptOut(typeof localStorage !== 'undefined' ? localStorage : null, true);
    navigate(`/?project=${encodeURIComponent(row.projectId)}${row.workstream !== 'main' ? `&ws=${encodeURIComponent(row.workstream)}` : ''}`);
  };
  const { rows: recents } = useRecents(10);
  // The PRs link counts lanes 5 + 6, the ones a phone can act on. The backend
  // memoizes per user, so this and the PR screen share one GitHub read.
  const prs = usePolled(() => prsApi.list(), 60_000);
  const prCount = actionableCount(prs.data);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Cloud sessions ride along behind the flag; App starts the feed.
  const cloudOn = useFlag(FLAGS.cloudSessions, false);
  const cloudAll = useSyncExternalStore(cloudSessionFeed.subscribe, cloudSessionFeed.getSnapshot);
  const cloudSessions = cloudOn ? cloudAll : null;
  const groups = useMemo(
    () => buildInbox(projects, statusMap, user?.unixUsername ?? '', { recents, now, cloudSessions }),
    [projects, statusMap, user?.unixUsername, recents, now, cloudSessions],
  );
  const needs = groups.find(g => g.id === 'needs-you')?.rows.length ?? 0;

  // Selected tab: explicit (URL, then storage) while it has rows; otherwise
  // the first group that does. An explicit empty pick still shows its
  // empty state rather than jumping away, so the tabs never feel jumpy.
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('g');
  const picked: InboxGroupId | null = normalizeGroupId(fromUrl) ?? readStoredGroup();
  const selected: InboxGroupId = picked ?? defaultGroup(groups, null);
  const pick = (id: InboxGroupId) => {
    const next = new URLSearchParams(params);
    next.set('g', id);
    setParams(next, { replace: true });
    try { localStorage.setItem(GROUP_KEY, id); } catch { /* private mode */ }
  };
  const current = groups.find(g => g.id === selected);
  useEffect(() => {
    document.title = needs > 0 ? `(${needs}) termag` : 'termag';
    return () => { document.title = 'termag'; };
  }, [needs]);

  const fullUi = () => {
    writeOptOut(typeof localStorage !== 'undefined' ? localStorage : null, true);
    navigate('/');
  };

  return (
    <div className="m-screen">
      <header className="m-header">
        <span className="m-title">termag</span>
        <span className="m-header-actions">
          {prs.data?.connected && (
            <Link className="m-link m-prs-link" to="/m/prs" title="Pull requests: reviews asked of you + yours ready to merge">
              PRs{prCount > 0 && <span className="m-segment-count m-prs-count">{prCount}</span>}
            </Link>
          )}
          <Link className="m-link" to="/m/new" title="New project">+ New</Link>
          <button className="m-link" onClick={fullUi}>Full UI</button>
          <Link className="m-link" to="/settings" aria-label="Settings" title="Settings">⚙</Link>
        </span>
      </header>
      {connection.state !== 'online' && (
        <div className="m-banner" data-connection={connection.state} role="status">
          {connection.state === 'offline' ? 'Connection to termag lost · statuses are stale' : 'Reconnecting to termag…'}
        </div>
      )}
      <nav className="m-segments" role="tablist" aria-label="Inbox groups">
        {INBOX_GROUPS.map(g => {
          const group = groups.find(x => x.id === g.id);
          // The Sessions tab counts what is working; the idle rows are always there.
          const n = g.id === 'sessions' ? workingCount(group) : group?.rows.length ?? 0;
          const title = g.id === 'sessions' ? `${n} working · ${(group?.rows.length ?? 0) - n} idle` : undefined;
          return (
            <button
              key={g.id}
              role="tab"
              aria-selected={selected === g.id}
              className={`m-segment ${selected === g.id ? 'active' : ''}`}
              data-group={g.id}
              title={title}
              onClick={() => pick(g.id)}
            >
              <span className="m-segment-label">{g.label}</span>
              <span className="m-segment-count" data-zero={n === 0 || undefined}>{n}</span>
            </button>
          );
        })}
      </nav>
      {actionError && <div className="m-banner" data-connection="offline" role="alert" onClick={() => setActionError('')}>{actionError} · tap to dismiss</div>}
      <main className="m-scroll" role="tabpanel">
        {(!current || current.rows.length === 0) && (
          <div className="m-empty">
            {projects.length === 0 ? 'No projects yet. Create one from the full UI.'
              : selected === 'needs-you' ? 'Nothing is waiting on you.'
              : selected === 'sessions' ? 'No sessions.'
              : 'Nothing opened recently.'}
          </div>
        )}
        {current && current.rows.length > 0 && (
          <ul className="m-list">
            {current.rows.map((r, i) => {
              // Sessions: a small heading where the Working rows end and the Idle ones start.
              const head = current.id === 'sessions' && r.section && r.section !== current.rows[i - 1]?.section
                ? <li key={`head:${r.section}`} className="m-list-head" role="presentation">{SECTION_LABEL[r.section]}</li>
                : null;
              return (
                <React.Fragment key={`${current.id}:${r.key}`}>
                  {head}
                  <Row row={r} now={now} recent={current.id === 'recents'} onMore={setMenuRow} />
                </React.Fragment>
              );
            })}
          </ul>
        )}
      </main>
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
    </div>
  );
}
