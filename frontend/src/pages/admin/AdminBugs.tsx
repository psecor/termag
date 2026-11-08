import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  adminApi, BUG_AREAS, BUG_SEVERITIES, BUG_STATUSES, type BugChange, type BugDetail, type BugListRow, type BugStatus,
} from '../../services/adminApi';
import { Markdown } from '../../chat/Markdown';
import { ChartCard } from '../dashboard/ChartCard';
import { DataTable, KeyValues, StatusPill, errorText, fmtAgo, pendingText, useAdminPolled, type Column } from './shared';
import { eventText, filtersFromSearch, linkLabel, searchFromFilters, sessionHref } from './bugText';

/**
 * /admin/bugs: the reports agents file with `termag bug
 * report`, new first, and one report's page at /admin/bugs/:id, where an admin
 * sets its status, links a GitHub issue or PR, or marks it a duplicate. Every
 * change is in the report's history and the admin audit log.
 */
export function AdminBugs({ now }: { now: number }) {
  const { id } = useParams();
  return id ? <BugDetailView id={id} now={now} /> : <BugList now={now} />;
}

/** The count of new reports beside the nav tab; nothing while there are none. */
export function BugsBadge() {
  const counts = useAdminPolled(useCallback(() => adminApi.bugCounts(), []), 60_000);
  const n = counts.data?.counts.new ?? 0;
  return n > 0 ? <span className="admin-badge" aria-label={`${n} new`}>{n}</span> : null;
}

function SeverityPill({ severity }: { severity: string }) {
  return <span className={`admin-pill admin-pill--sev-${severity.replace(/[^a-z]/g, '')}`}>{severity}</span>;
}

/** A filter from the URL that the select doesn't offer, such as `area=spaces,boxes`, shown as itself. */
function ExtraOption({ value, known }: { value?: string; known: readonly string[] }) {
  return value && !known.includes(value) ? <option value={value}>{value.split(',').join(', ')}</option> : null;
}

function BugList({ now }: { now: number }) {
  const [params, setParams] = useSearchParams();
  const filters = filtersFromSearch(params);
  const [q, setQ] = useState(filters.q ?? '');
  const navigate = useNavigate();
  const list = useAdminPolled(useCallback(() => adminApi.bugReports(filters), [JSON.stringify(filters)]), 30_000, { deps: [filters] });
  const counts = useAdminPolled(useCallback(() => adminApi.bugCounts(), []), 30_000);

  const set = (k: 'status' | 'area' | 'severity' | 'q', v: string) => {
    const next = { ...filters, [k]: v || undefined };
    setParams(new URLSearchParams(searchFromFilters(next).slice(1)), { replace: true });
  };
  // Search as you type, a beat after the last key. The URL holds the search
  // trimmed, so compare it trimmed: padding alone never rewrites the URL.
  const typed = q.trim();
  // The search this input last wrote to the URL: when that URL arrives it is
  // our own write, and keys typed since must stay.
  const wrote = useRef<string | null>(null);
  // The URL changed under the input (the Bugs tab, Back, a link): show its
  // search, so the debounce below never writes the old one back.
  useEffect(() => {
    const urlQ = filters.q ?? '';
    if (urlQ === wrote.current) { wrote.current = null; return; }
    wrote.current = null;
    if (urlQ !== typed) setQ(urlQ);
  }, [filters.q]);
  useEffect(() => {
    if ((filters.q ?? '') === typed) return;
    const t = setTimeout(() => { wrote.current = typed; set('q', typed); }, 300);
    return () => clearTimeout(t);
  }, [typed, params.toString()]);

  const rows = list.data?.reports ?? [];
  const cols: Column<BugListRow>[] = [
    { id: 'status', label: 'status', value: r => (r.status === 'new' ? 0 : 1 + BUG_STATUSES.indexOf(r.status)), render: r => <StatusPill status={r.status} /> },
    { id: 'severity', label: 'severity', value: r => BUG_SEVERITIES.indexOf(r.severity as typeof BUG_SEVERITIES[number]), render: r => <SeverityPill severity={r.severity} /> },
    { id: 'area', label: 'area', value: r => r.area },
    { id: 'title', label: 'title', value: r => r.title, render: r => <Link className="admin-bug-title" to={`/admin/bugs/${encodeURIComponent(r.id)}`}>{r.title}</Link> },
    { id: 'reporter', label: 'reporter', value: r => r.reporter, render: r => <span className="usage-dim">{r.reporter}{r.box ? ` · ${r.box}` : ''}</span> },
    { id: 'agent', label: 'agent', value: r => r.agentProvider ?? '', render: r => r.agentProvider ?? <span className="usage-dim">—</span> },
    { id: 'link', label: 'link', value: r => r.linkUrl ?? r.duplicateOfId ?? '', render: r => r.linkUrl
      ? <a href={r.linkUrl} target="_blank" rel="noreferrer">{linkLabel(r.linkUrl)}</a>
      : r.duplicateOfId ? <Link to={`/admin/bugs/${encodeURIComponent(r.duplicateOfId)}`}>dup of {r.duplicateOfId.slice(-6)}</Link> : <span className="usage-dim">—</span> },
    { id: 'filed', label: 'filed', value: r => Date.parse(r.createdAt), render: r => fmtAgo(r.createdAt, now) },
  ];
  const c = counts.data?.counts;

  return (
    <section className="dash-section">
      <div className="dash-section-title">
        Bug reports {list.data && <span className="dash-count">{rows.length}</span>}
        {c && <span className="usage-dim">{BUG_STATUSES.map(s => `${c[s]} ${s}`).join(' · ')}</span>}
      </div>
      <div className="admin-form admin-bug-filters">
        <input type="search" placeholder="search titles, bodies, commands and errors" value={q} onChange={e => setQ(e.target.value)} aria-label="search bug reports" />
        <select className="admin-select" value={filters.status ?? ''} onChange={e => set('status', e.target.value)} aria-label="status">
          <option value="">every status</option>
          <option value="new,triaged">open (new, triaged)</option>
          {BUG_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          <ExtraOption value={filters.status} known={[...BUG_STATUSES, 'new,triaged']} />
        </select>
        <select className="admin-select" value={filters.area ?? ''} onChange={e => set('area', e.target.value)} aria-label="area">
          <option value="">every area</option>
          {BUG_AREAS.map(a => <option key={a} value={a}>{a}</option>)}
          <ExtraOption value={filters.area} known={BUG_AREAS} />
        </select>
        <select className="admin-select" value={filters.severity ?? ''} onChange={e => set('severity', e.target.value)} aria-label="severity">
          <option value="">every severity</option>
          {BUG_SEVERITIES.map(s => <option key={s} value={s}>{s}</option>)}
          <ExtraOption value={filters.severity} known={BUG_SEVERITIES} />
        </select>
      </div>
      {list.error && list.data ? <div className="admin-error">refresh failed: {errorText(list.error)}</div> : null}
      <DataTable rows={rows} columns={cols} rowKey={r => r.id} defaultSort="status" defaultDesc={false} storageKey="bugs" resetKey={params.toString()}
        onRowClick={r => navigate(`/admin/bugs/${encodeURIComponent(r.id)}`)}
        empty={list.data ? (Object.keys(filters).length ? 'no reports match' : 'no bug reports yet: agents file them with `termag bug report`') : pendingText(list)} />
    </section>
  );
}

function BugDetailView({ id, now }: { id: string; now: number }) {
  const detail = useAdminPolled(useCallback(() => adminApi.bugReport(id), [id]), 60_000, { deps: [id] });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState('');
  const [dupOf, setDupOf] = useState('');
  const [note, setNote] = useState('');
  const d: BugDetail | null = detail.data;
  useEffect(() => { setLink(d?.report.linkUrl ?? ''); }, [d?.report.linkUrl]);

  const change = (body: BugChange) => {
    setErr(null); setBusy(true);
    adminApi.triageBug(id, note.trim() ? { ...body, note: note.trim() } : body)
      .then(() => { setNote(''); setDupOf(''); detail.refresh(); })
      .catch(e => setErr(errorText(e)))
      .finally(() => setBusy(false));
  };

  if (!d) {
    return (
      <>
        <Link to="/admin/bugs">← all bug reports</Link>
        <ChartCard title="Bug report" subtitle={pendingText(detail)} stale={detail.loading}>{null}</ChartCard>
      </>
    );
  }
  const r = d.report;
  const session = sessionHref(r);

  return (
    <div className="admin-bug">
      <div className="admin-bug-nav"><Link to="/admin/bugs">← all bug reports</Link></div>
      <header className="admin-bug-head">
        <h2>{r.title}</h2>
        <div className="admin-bug-meta">
          <StatusPill status={r.status} /> <SeverityPill severity={r.severity} />
          <span className="admin-pill">{r.area}</span>
          <span className="usage-dim">filed {fmtAgo(r.createdAt, now)} by {d.reporter.user}{d.reporter.box ? ` on ${d.reporter.box}` : ''} · <code className="admin-mono">{r.id}</code></span>
          {r.linkUrl && <a href={r.linkUrl} target="_blank" rel="noreferrer">{linkLabel(r.linkUrl)}</a>}
          {d.duplicateOf && <span>duplicate of <Link to={`/admin/bugs/${encodeURIComponent(d.duplicateOf.id)}`}>{d.duplicateOf.title}</Link></span>}
        </div>
      </header>
      {err && <div className="admin-error">{err}</div>}

      <div className="admin-bug-grid">
        <div className="admin-bug-main">
          <ChartCard title="Report" stale={detail.loading}>
            <div className="admin-bug-body"><Markdown text={r.body} /></div>
          </ChartCard>
          {(r.command || r.errorOutput) && (
            <ChartCard title="The command and its error">
              {r.command && <pre className="admin-pre">{r.command}</pre>}
              {r.errorOutput && <pre className="admin-pre admin-pre--error">{r.errorOutput}</pre>}
            </ChartCard>
          )}
          <ChartCard title="History" subtitle={d.events.length ? `${d.events.length} change${d.events.length === 1 ? '' : 's'}` : 'not triaged yet'}>
            <div className="dash-rows">
              <div className="dash-row"><span className="dash-row-label">{fmtAgo(r.createdAt, now)}</span><span className="dash-row-value">filed by {d.reporter.user} ({r.credential === 'box' ? "the box's own credential" : 'a CLI sign-in'})</span></div>
              {d.events.map(e => (
                <div className="dash-row" key={e.id}><span className="dash-row-label">{fmtAgo(e.createdAt, now)}</span><span className="dash-row-value">{e.actor} {eventText(e)}</span></div>
              ))}
            </div>
          </ChartCard>
        </div>

        <div className="admin-bug-side">
          <ChartCard title="Triage">
            <div className="admin-bug-statuses" role="group" aria-label="status">
              {BUG_STATUSES.filter(s => s !== 'duplicate').map(s => (
                <button key={s} type="button" className={`btn-ghost btn-tiny${r.status === s ? ' is-active' : ''}`} aria-pressed={r.status === s}
                  disabled={busy || r.status === s} onClick={() => change({ status: s as BugStatus })}>{s}</button>
              ))}
            </div>
            <label className="admin-bug-field">note for the history (optional)
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="sent with the next change" />
            </label>
            <form className="admin-bug-field" onSubmit={e => { e.preventDefault(); change({ link: link.trim() || null }); }}>
              <span>GitHub issue or PR</span>
              <div className="admin-form">
                <input value={link} onChange={e => setLink(e.target.value)} placeholder="https://github.com/<owner>/<repo>/pull/<n>" aria-label="GitHub issue or PR" />
                <button type="submit" className="btn-ghost btn-tiny" disabled={busy || link.trim() === (r.linkUrl ?? '')}>{link.trim() || !r.linkUrl ? 'link' : 'clear'}</button>
              </div>
            </form>
            <form className="admin-bug-field" onSubmit={e => { e.preventDefault(); if (dupOf.trim()) change({ duplicateOf: dupOf.trim() }); }}>
              <span>duplicate of</span>
              <div className="admin-form">
                <input value={dupOf} onChange={e => setDupOf(e.target.value)} placeholder="the original report's id" aria-label="duplicate of" />
                <button type="submit" className="btn-ghost btn-tiny" disabled={busy || !dupOf.trim()}>mark duplicate</button>
              </div>
            </form>
          </ChartCard>

          <ChartCard title="Reporter">
            <KeyValues items={[
              ['user', d.reporter.user],
              ['box', r.boxId ? <Link to={`/admin/fleet?box=${encodeURIComponent(r.boxId)}`}>{d.reporter.box ?? r.boxId}</Link> : '—'],
              ['project', d.reporter.project ?? '—'],
              ['session', session ? <Link to={session}>{r.threadId ? `ask thread ${r.threadId}` : r.workstream ?? 'main'}</Link> : '—'],
              ['agent', [r.agentProvider, r.agentModel].filter(Boolean).join(' · ') || '—'],
            ]} />
          </ChartCard>

          <ChartCard title="Context">
            <KeyValues items={[
              ['termag CLI', r.cliVersion ? <span className="admin-mono">{r.cliVersion}</span> : '—'],
              ['agent version', r.agentVersion ? <span className="admin-mono">{r.agentVersion}</span> : '—'],
              ['box agent', r.boxAgentCommit ? <code className="admin-mono">{r.boxAgentCommit.slice(0, 12)}</code> : '—'],
              ['capabilities', r.boxAgentCapabilities.length
                ? <details className="admin-bug-caps"><summary>{r.boxAgentCapabilities.length}</summary>{r.boxAgentCapabilities.join(' ')}</details>
                : '—'],
              ['box image', r.boxImage ? <span className="admin-mono">{r.boxImage}</span> : '—'],
              ...(r.redacted.length ? [['redacted', <span className="admin-warn">{r.redacted.join(', ')}</span>] as [string, React.ReactNode]] : []),
            ]} />
          </ChartCard>

          {d.duplicates.length > 0 && (
            <ChartCard title="Duplicates of this report" value={String(d.duplicates.length)}>
              <div className="dash-rows">
                {d.duplicates.map(x => (
                  <div className="dash-row" key={x.id}><Link className="dash-row-label" to={`/admin/bugs/${encodeURIComponent(x.id)}`}>{x.title}</Link><span className="usage-dim">{fmtAgo(x.createdAt, now)}</span></div>
                ))}
              </div>
            </ChartCard>
          )}
        </div>
      </div>
    </div>
  );
}
