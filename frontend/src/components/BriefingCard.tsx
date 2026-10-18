import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { briefingsApi, BriefingLatest, BriefingView } from '../services/api';
import {
  browserTz, cardState, CardState, KIND_LABEL, LinkMode, pendingProblem, pollInterval,
  sessionHref, sessionLabel, statTiles, windowHeading, finishedLabel } from './briefing';

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

/**
 * The latest briefing, polled: every 5 s while one is running, else every
 * 60 s. Reading it is not activity — nothing here sends a human heartbeat.
 */
export function useBriefingLatest(): {
  data: BriefingLatest | null;
  state: CardState;
  error: string | null;
  refresh: () => void;
  setData: (d: BriefingLatest) => void;
} {
  const [data, setData] = useState<BriefingLatest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const state = cardState(data);
  useEffect(() => {
    let cancelled = false;
    briefingsApi.latest()
      .then(d => { if (!cancelled) { setData(d); setError(null); } })
      .catch(err => { if (!cancelled) setError(apiError(err, 'Could not load the briefing')); });
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => {
    const t = setTimeout(() => setTick(n => n + 1), pollInterval(state));
    return () => clearTimeout(t);
  }, [state, tick]);

  const refresh = useCallback(() => setTick(n => n + 1), []);
  return { data, state, error, refresh, setData };
}

interface CardProps {
  variant: 'full' | 'compact';
  /** Where item links go: the desktop workspace or the phone's conversation. */
  linkMode?: LinkMode;
}

export function BriefingCard({ variant, linkMode = 'desktop' }: CardProps) {
  const { data, state, error, refresh, setData } = useBriefingLatest();
  const [busy, setBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [history, setHistory] = useState<BriefingView[] | null>(null);
  const [picked, setPicked] = useState<string>('');

  async function runNow() {
    if (busy || state === 'running') return;
    setBusy(true);
    setRunError(null);
    try {
      const row = await briefingsApi.run(browserTz());
      // Show the new row at once; the poll takes over from here.
      setData(row.status === 'done' ? { latest: row, pending: null } : { latest: data?.latest ?? null, pending: row });
      setPicked('');
    } catch (err) {
      setRunError(apiError(err, 'Could not start a briefing'));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  async function loadHistory() {
    if (history !== null) return;
    try {
      setHistory((await briefingsApi.list(20)).briefings.filter(b => b.status === 'done'));
    } catch {
      setHistory([]);
    }
  }

  const shown: BriefingView | null = (picked && history?.find(b => b.id === picked)) || data?.latest || null;
  const problem = pendingProblem(data);
  const running = state === 'running' ? data?.pending ?? null : null;

  const header = (
    <div className="dash-section-title briefing-title" id={`briefing-h-${variant}`}>
      <span>{variant === 'full' ? 'Today' : 'Briefing'}</span>
      {variant === 'full' && shown && (
        <select
          className="briefing-history"
          aria-label="Earlier briefings"
          value={picked}
          onFocus={loadHistory}
          onMouseDown={loadHistory}
          onChange={e => setPicked(e.target.value)}
        >
          <option value="">Latest</option>
          {(history ?? []).filter(b => b.id !== data?.latest?.id).map(b => (
            <option key={b.id} value={b.id}>{b.window.label || new Date(b.createdAt).toLocaleString()}</option>
          ))}
        </select>
      )}
      <button
        type="button"
        className="briefing-run"
        onClick={runNow}
        disabled={busy || state === 'running' || state === 'loading'}
        title="Review everything since your last briefing now"
      >
        {state === 'running' ? 'Running…' : busy ? 'Starting…' : 'Run now'}
      </button>
    </div>
  );

  return (
    <section className={`dash-section briefing briefing--${variant}`} aria-labelledby={`briefing-h-${variant}`}>
      {header}
      <div className="dash-card briefing-card">
        {error && state === 'loading' && <div className="usage-dim">{error}</div>}
        {state === 'loading' && !error && <div className="usage-dim">Loading…</div>}
        {runError && <div className="error-banner">{runError}<button onClick={() => setRunError(null)}>×</button></div>}
        {running && (
          <div className="briefing-running" role="status">
            <span className="briefing-spinner" aria-hidden="true" />
            Reviewing {running.window.label ? `since ${running.window.label.split(' to ')[0]}` : 'since your last briefing'}
            {running.boxName ? ` on ${running.boxName}` : ''}…
          </div>
        )}
        {problem && <div className="briefing-problem" role="alert">{problem}</div>}
        {state === 'never' && (
          <div className="briefing-empty">
            <p>
              A briefing reviews your sessions since the last one: what was left open, and what to pick up next.
              It runs a short headless Claude on one of your boxes.
            </p>
            <p className="usage-dim">
              Press Run now, or <Link to="/settings#briefing">schedule one</Link> for every morning.
            </p>
          </div>
        )}
        {shown && <BriefingBody view={shown} variant={variant} linkMode={linkMode} />}
        {variant === 'compact' && (
          <div className="briefing-foot"><Link to="/dashboard">Open dashboard →</Link></div>
        )}
      </div>
    </section>
  );
}

function ItemLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  return href ? <Link className="briefing-item-link" to={href}>{children}</Link> : <div className="briefing-item-link">{children}</div>;
}

export function BriefingBody({ view, variant, linkMode }: { view: BriefingView; variant: 'full' | 'compact'; linkMode: LinkMode }) {
  const c = view.content;
  const tiles = statTiles(view.stats);
  const limit = variant === 'compact' ? 3 : Infinity;
  const carry = (c?.carryovers ?? []).slice(0, limit);
  const sugg = (c?.suggestions ?? []).slice(0, limit);
  const finished = finishedLabel(view);

  return (
    <div className="briefing-body">
      <div className="briefing-window">{windowHeading(view)}</div>
      {(view.boxName || finished) && (
        <div className="usage-dim briefing-meta">
          {[view.boxName ? `on ${view.boxName}` : null, finished ? `finished ${finished}` : null].filter(Boolean).join(' · ')}
        </div>
      )}
      {variant === 'full' && tiles.length > 0 && (
        <div className="dash-kpis briefing-stats">
          {tiles.map(t => (
            <div className="dash-tile" key={t.id}>
              <div className="dash-tile-label">{t.label}</div>
              <div className="dash-tile-value">{t.value}</div>
            </div>
          ))}
        </div>
      )}
      {c?.summary && <p className="briefing-summary">{c.summary}</p>}
      {carry.length > 0 && (
        <div className="briefing-group">
          <div className="briefing-group-label">Left open</div>
          <ul className="attn-list briefing-list">
            {carry.map((it, i) => {
              const where = sessionLabel(it.projectId, it.workstream, view.projects);
              return (
                <li key={i}>
                  <ItemLink href={sessionHref(it.projectId, it.workstream, view.projects, linkMode)}>
                    <span className={`attn-chip briefing-kind briefing-kind--${it.kind}`}>{KIND_LABEL[it.kind]}</span>
                    <span className="attn-body">
                      <span className="attn-title">
                        {where && <span className="attn-project">{where}</span>}
                        {it.title}
                      </span>
                      {it.detail && <span className="attn-detail">{it.detail}</span>}
                    </span>
                  </ItemLink>
                </li>
              );
            })}
          </ul>
          {variant === 'compact' && (c?.carryovers.length ?? 0) > limit && (
            <div className="usage-dim">and {(c?.carryovers.length ?? 0) - limit} more</div>
          )}
        </div>
      )}
      {sugg.length > 0 && (
        <div className="briefing-group">
          <div className="briefing-group-label">Pick up today</div>
          <ol className="briefing-suggestions">
            {sugg.map((s, i) => {
              const where = sessionLabel(s.projectId, s.workstream, view.projects);
              return (
                <li key={i}>
                  <ItemLink href={sessionHref(s.projectId, s.workstream, view.projects, linkMode)}>
                    <span className="briefing-sugg-text">
                      {where && <span className="attn-project">{where}</span>}
                      {s.text}
                    </span>
                    {s.why && <span className="attn-detail">{s.why}</span>}
                  </ItemLink>
                </li>
              );
            })}
          </ol>
        </div>
      )}
      {c && carry.length === 0 && sugg.length === 0 && !c.summary && (
        <div className="usage-dim">Nothing was left open.</div>
      )}
    </div>
  );
}
