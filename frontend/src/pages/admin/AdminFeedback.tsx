import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, ListBox, ListBoxItem, Popover, Select, SelectValue, ToggleButton, ToggleButtonGroup } from '@launchpad-ui/components';
import { adminApi, FEEDBACK_KINDS, FEEDBACK_STATUSES, type FeedbackItem, type FeedbackStatus } from '../../services/adminApi';
import { LP_THEME } from '../../launchpad/theme';
import { DataTable, StatusPill, errorText, fmtAgo, pendingText, useAdminPolled, type Column } from './shared';
import { sessionHref } from './bugText';
import { agentText, emptyText, feedbackFiltersFromSearch, truncatedText, whereFrom } from './feedbackText';

/** Sent when the page changes a status, so the nav badge (polled on its own) counts again at once. */
const COUNTS_CHANGED = 'termag:feedback-counts-changed';

/**
 * /admin/feedback: what people said about termag in their
 * chats, logged by their agents with `termag feedback`, newest first. Each
 * piece is new until an admin marks it seen. The whole list is the page:
 * the text is short, so there is no detail view.
 */
export function AdminFeedback({ now }: { now: number }) {
  const [params, setParams] = useSearchParams();
  const filters = feedbackFiltersFromSearch(params);
  const list = useAdminPolled(useCallback(() => adminApi.feedback(filters), [JSON.stringify(filters)]), 30_000, { deps: [filters] });
  const counts = useAdminPolled(useCallback(() => adminApi.feedbackCounts(), []), 30_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const set = (k: 'status' | 'kind', v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };
  const mark = (f: FeedbackItem, status: FeedbackStatus) => {
    setErr(null); setBusy(f.id);
    adminApi.setFeedbackStatus(f.id, status)
      .then(() => { list.refresh(); counts.refresh(); window.dispatchEvent(new Event(COUNTS_CHANGED)); })
      .catch(e => setErr(errorText(e)))
      .finally(() => setBusy(null));
  };

  const rows = list.data?.feedback ?? [];
  const cols: Column<FeedbackItem>[] = [
    { id: 'when', label: 'when', value: r => Date.parse(r.createdAt), render: r => <span title={new Date(r.createdAt).toLocaleString()}>{fmtAgo(r.createdAt, now)}</span> },
    { id: 'status', label: 'status', value: r => r.status, render: r => <StatusPill status={r.status} /> },
    { id: 'kind', label: 'kind', value: r => r.kind, render: r => <span className={`admin-pill admin-pill--fb-${r.kind}`}>{r.kind}</span> },
    { id: 'text', label: 'feedback', value: r => r.body, render: r => (
      <div className="admin-feedback-text">
        {r.body}
        {r.redacted.length > 0 && <span className="admin-warn"> (redacted: {r.redacted.join(', ')})</span>}
      </div>
    ) },
    { id: 'who', label: 'who', value: r => r.reporter },
    { id: 'where', label: 'where from', value: r => whereFrom(r), render: r => {
      const href = sessionHref(r);
      return href ? <Link to={href}>{whereFrom(r)}</Link> : <span className="usage-dim">{whereFrom(r)}</span>;
    } },
    { id: 'agent', label: 'agent', value: r => agentText(r), render: r => agentText(r) || <span className="usage-dim">—</span> },
    // Out of the text filter: its words ("Mark seen") are on every row.
    { id: 'action', label: '', value: r => r.status, text: () => '', render: r => (
      <Button size="small" variant={r.status === 'new' ? 'default' : 'minimal'} isDisabled={busy === r.id}
        onPress={() => mark(r, r.status === 'new' ? 'seen' : 'new')}
        aria-label={r.status === 'new' ? `Mark feedback ${r.id} seen` : `Mark feedback ${r.id} new`}>
        {r.status === 'new' ? 'Mark seen' : 'Mark new'}
      </Button>
    ) },
  ];
  const c = counts.data?.counts;
  const truncated = list.data ? truncatedText(list.data.more, filters) : null;
  const kindOptions = [{ id: 'all', name: 'Every kind' }, ...FEEDBACK_KINDS.map(k => ({ id: k, name: k }))];

  return (
    <section className={`dash-section admin-feedback ${LP_THEME}`}>
      <div className="dash-section-title">
        Feedback {list.data && <span className="dash-count">{rows.length}</span>}
        {c && <span className="usage-dim">{FEEDBACK_STATUSES.map(s => `${c[s]} ${s}`).join(' · ')}</span>}
      </div>
      <div className="admin-feedback-filters" role="search" aria-label="Filter feedback">
        <ToggleButtonGroup aria-label="Status" selectionMode="single" disallowEmptySelection
          selectedKeys={[filters.status ?? 'all']}
          onSelectionChange={keys => { const k = String([...keys][0] ?? 'all'); set('status', k === 'all' ? null : k); }}>
          <ToggleButton id="new" size="small">New</ToggleButton>
          <ToggleButton id="seen" size="small">Seen</ToggleButton>
          <ToggleButton id="all" size="small">All</ToggleButton>
        </ToggleButtonGroup>
        <Select aria-label="Kind" selectedKey={filters.kind ?? 'all'} className="admin-feedback-kind"
          onSelectionChange={k => set('kind', k == null || k === 'all' ? null : String(k))}>
          <Button size="small"><SelectValue /></Button>
          <Popover className={LP_THEME} placement="bottom start">
            <ListBox items={kindOptions}>
              {o => <ListBoxItem id={o.id} textValue={o.name}>{o.name}</ListBoxItem>}
            </ListBox>
          </Popover>
        </Select>
      </div>
      {err && <div className="admin-error">{err}</div>}
      {list.error && list.data ? <div className="admin-error">refresh failed: {errorText(list.error)}</div> : null}
      {truncated && <div className="admin-feedback-truncated usage-dim" role="status">{truncated}</div>}
      <DataTable rows={rows} columns={cols} rowKey={r => r.id} storageKey="feedback" resetKey={params.toString()}
        search="search the feedback, people and places"
        empty={list.data ? emptyText(filters) : pendingText(list)} />
    </section>
  );
}

/** The count of new feedback beside the nav tab; nothing while there is none. */
export function FeedbackBadge() {
  const counts = useAdminPolled(useCallback(() => adminApi.feedbackCounts(), []), 60_000);
  // usePolled's refresh is a new function each render: listen once, call the latest.
  const refresh = useRef(counts.refresh);
  refresh.current = counts.refresh;
  useEffect(() => {
    const again = () => refresh.current();
    window.addEventListener(COUNTS_CHANGED, again);
    return () => window.removeEventListener(COUNTS_CHANGED, again);
  }, []);
  const n = counts.data?.counts.new ?? 0;
  return n > 0 ? <span className="admin-badge" aria-label={`${n} new`}>{n}</span> : null;
}
