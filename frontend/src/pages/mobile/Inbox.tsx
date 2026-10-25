import React, { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { useConnection } from '../../contexts/ConnectionContext';
import { HOME_FILTERS, HomeFilter, matchesFilter, parseFilter } from '../../mobile/inbox';
import { useHome } from '../../mobile/useHome';
import { prsApi } from '../../services/api';
import { usePolled } from '../dashboard/useDashboardData';
import { myReviewCount, prsStale } from '../../utils/prPipeline';
import { SessionRow, useRowActions } from './SessionRow';
import { TabBar } from './TabBar';
import { Sheet } from './Sheet';
import { BriefingCard, useBriefingLatest } from '../../components/BriefingCard';
import { openCount } from '../../components/briefing';
import { PullScroll } from './PullScroll';
import { AppMenu } from './AppMenu';
import { FLAGS, useFlag } from '../../flags';

const EMPTY: Record<HomeFilter, string> = {
  attention: 'Nothing is waiting on you.',
  running: 'No agent is running.',
  reviewing: 'No review in progress.',
};

// The home list: every session in one list, ordered
// needs you → running → reviewing → the rest, under a strip of counts that
// double as filters. The filter lives in the URL (?f=) so Back from a
// conversation returns to it.
export function Inbox() {
  const automationsOn = useFlag(FLAGS.automations, false);
  const { projects } = useProjects();
  const connection = useConnection();
  const { rows, counts, now } = useHome();
  const actions = useRowActions();
  // The PRs link counts reviews asked of you by name, as the web tile does.
  // The backend memoizes per user, so this and the PR screen share one GitHub read.
  const prs = usePolled(() => prsApi.list(), 60_000);
  const prCount = myReviewCount(prs.data);
  // Out of date (utils/prPipeline prsStale): the count dims and takes a "?", the title says why.
  const prsOld = prsStale(prs.data, prs.error, now);
  // The latest daily briefing as one strip tile; hidden until there is one.
  const briefing = useBriefingLatest();
  const [briefingOpen, setBriefingOpen] = useState(false);
  const left = openCount(briefing.data);

  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get('f'), params.get('g'));
  const toggle = (f: HomeFilter) => {
    const next = new URLSearchParams(params);
    next.delete('g');
    if (filter === f) next.delete('f'); else next.set('f', f);
    setParams(next, { replace: true });
  };
  const shown = filter ? rows.filter(r => matchesFilter(r, filter)) : rows;

  // The retired tab pick (termag-mobile-group) has no reader any more.
  useEffect(() => { try { localStorage.removeItem('termag-mobile-group'); } catch { /* private mode */ } }, []);
  useEffect(() => {
    document.title = counts.attention > 0 ? `(${counts.attention}) termag` : 'termag';
    return () => { document.title = 'termag'; };
  }, [counts.attention]);

  // The retired Recents tab lives on as the Search tab's recent sessions.
  if (params.get('g') === 'recents') return <Navigate to="/m/search" replace />;

  return (
    <div className="m-screen">
      <header className="m-header">
        <span className="m-title">termag</span>
        <span className="m-header-actions">
          {prs.data?.connected && (
            <Link className="m-link m-prs-link" to="/m/prs" title={prsOld ?? 'Pull requests: reviews asked of you by name'}>
              PRs{(prCount > 0 || prsOld) && <span className={`m-segment-count m-prs-count${prsOld ? ' is-stale' : ''}`}>{prCount}{prsOld ? '?' : ''}</span>}
            </Link>
          )}
          <Link className="m-link" to="/m/new" title="New project" aria-label="New project" data-analytics="new-project">+ New</Link>
          {automationsOn && <Link className="m-link" to="/m/new-automation" title="New automation: a prompt an agent runs on a schedule">⏱ Automation</Link>}
          <AppMenu />
          <Link className="m-link" to="/settings" aria-label="Settings" title="Settings">⚙</Link>
        </span>
      </header>
      {connection.state !== 'online' && (
        <div className="m-banner" data-connection={connection.state} role="status">
          {connection.state === 'offline' ? 'Connection to termag lost · statuses are stale' : 'Reconnecting to termag…'}
        </div>
      )}
      <div className="m-summary" role="group" aria-label="Filter sessions">
        {HOME_FILTERS.map(f => (
          <button
            key={f.id}
            className={`m-summary-tile ${filter === f.id ? 'active' : ''}`}
            data-filter={f.id}
            data-zero={counts[f.id] === 0 || undefined}
            aria-pressed={filter === f.id}
            onClick={() => toggle(f.id)}
          >
            <span className="m-summary-count">{counts[f.id]}</span>
            <span className="m-summary-label">{f.label}</span>
          </button>
        ))}
        {(briefing.state === 'ready' || briefing.state === 'running') && (
          <button
            className="m-summary-tile"
            data-filter="briefing"
            data-zero={(briefing.state === 'ready' && left === 0) || undefined}
            onClick={() => setBriefingOpen(true)}
            // The count is the latest briefing's open items, not a number of
            // briefings; say so where the label alone can't.
            title={briefing.state === 'running' ? 'A daily briefing is running' : `Your latest daily briefing: ${left} ${left === 1 ? 'item' : 'items'} left open`}
            aria-label={briefing.state === 'running' ? 'Daily briefing running' : `Daily briefing, ${left} left open`}
          >
            <span className="m-summary-count">{briefing.state === 'running' ? '…' : left}</span>
            <span className="m-summary-label">{briefing.state === 'running' ? 'Briefing running…' : 'Daily Briefing'}</span>
          </button>
        )}
      </div>
      {briefingOpen && (
        <Sheet title="Briefing" onClose={() => setBriefingOpen(false)}>
          <div className="m-briefing-sheet">
            <BriefingCard variant="compact" linkMode="mobile" />
          </div>
        </Sheet>
      )}
      {actions.error && <div className="m-banner" data-connection="offline" role="alert" onClick={actions.clearError}>{actions.error} · tap to dismiss</div>}
      <PullScroll onRefresh={prs.refresh}>
        {shown.length === 0 && (
          <div className="m-empty">
            {projects.length === 0 ? 'No projects yet. Create one with + New.'
              : filter ? EMPTY[filter] : 'No sessions.'}
          </div>
        )}
        {shown.length > 0 && (
          <ul className="m-list">
            {shown.map(r => <SessionRow key={r.key} row={r} now={now} onMore={actions.open} />)}
          </ul>
        )}
      </PullScroll>
      <TabBar attention={counts.attention} />
      {actions.sheets}
    </div>
  );
}
