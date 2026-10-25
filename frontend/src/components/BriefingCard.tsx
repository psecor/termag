import React, { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { briefingsApi, BriefingDismissal, BriefingLatest, BriefingView } from '../services/api';
import {
  activeMarks, browserTz, cardState, CardState, groupWorkedOn, KIND_LABEL, LinkMode, markLabel, MarkOverride, overlayMarks, pendingProblem, pollInterval,
  prHref, prLabel, sessionHref, sessionLabel, splitMarked, statTiles, windowHeading, finishedLabel } from './briefing';
// Lazy: recharts stays on the /dashboard chunk. The workspace home view
// mounts the compact card, which never draws charts.
const BriefingCharts = lazy(() => import('./BriefingCharts').then(m => ({ default: m.BriefingCharts })));

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
  /** When the request behind `data` left (ms), for overlayMarks. */
  fetchedFrom: number;
} {
  const [data, setData] = useState<BriefingLatest | null>(null);
  const [fetchedFrom, setFetchedFrom] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const state = cardState(data);
  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    briefingsApi.latest()
      .then(d => { if (!cancelled) { setData(d); setFetchedFrom(startedAt); setError(null); } })
      .catch(err => { if (!cancelled) setError(apiError(err, 'Could not load the briefing')); });
    return () => { cancelled = true; };
  }, [tick]);

  useEffect(() => {
    const t = setTimeout(() => setTick(n => n + 1), pollInterval(state));
    return () => clearTimeout(t);
  }, [state, tick]);

  const refresh = useCallback(() => setTick(n => n + 1), []);
  return { data, state, error, refresh, setData, fetchedFrom };
}

interface CardProps {
  variant: 'full' | 'compact';
  /** Where item links go: the desktop workspace or the phone's conversation. */
  linkMode?: LinkMode;
}

export function BriefingCard({ variant, linkMode = 'desktop' }: CardProps) {
  const { data, state, error, refresh, setData, fetchedFrom } = useBriefingLatest();
  const [overrides, setOverrides] = useState<MarkOverride[]>([]);
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
      // Keep the marks: dropping them would bring Done and deferred items back until the next poll.
      const dismissals = data?.dismissals;
      setData(row.status === 'done' ? { latest: row, pending: null, dismissals } : { latest: data?.latest ?? null, pending: row, dismissals });
      setPicked('');
    } catch (err) {
      setRunError(apiError(err, 'Could not start a briefing'));
    } finally {
      setBusy(false);
      refresh();
    }
  }

  // Done / Defer / Bring back: shown at once as an override on the polled
  // marks, kept until a poll that left after the save answers; a failed save
  // drops the override, which puts the item back.
  const marks = activeMarks(overlayMarks(data?.dismissals, overrides, fetchedFrom));
  const put = (o: MarkOverride) => setOverrides(list => [...list.filter(x => x.key !== o.key), o]);
  const drop = (key: string) => setOverrides(list => list.filter(x => x.key !== key));
  async function mark(key: string, action: 'done' | 'defer') {
    const now = new Date();
    put({ key, settledAt: null, mark: { key, kind: action, createdAt: now.toISOString(), until: new Date(now.getTime() + 86_400_000).toISOString() } });
    try {
      put({ key, mark: await briefingsApi.dismiss(key, action), settledAt: Date.now() });
    } catch (err) {
      drop(key);
      setRunError(apiError(err, 'Could not save that'));
    }
  }
  async function restore(key: string) {
    put({ key, mark: null, settledAt: null });
    try {
      await briefingsApi.restore(key);
      put({ key, mark: null, settledAt: Date.now() });
    } catch (err) {
      drop(key);
      setRunError(apiError(err, 'Could not bring it back'));
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
        {shown && <BriefingBody view={shown} variant={variant} linkMode={linkMode} marks={marks} onMark={mark} onRestore={restore} />}
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

function PrLink({ pr }: { pr: string }) {
  const href = prHref(pr);
  return href
    ? <a className="briefing-pr" href={href} target="_blank" rel="noreferrer" title={pr}>{prLabel(pr)}</a>
    : <span className="briefing-pr">{prLabel(pr)}</span>;
}

/** The row's right column, the same width on every row so the rows line up: its PR, then Done and Defer. */
function RowSide({ itemKey, pr, onMark }: { itemKey: string | null; pr?: string | null; onMark?: (key: string, action: 'done' | 'defer') => void }) {
  if (!pr && (!itemKey || !onMark)) return null;
  return (
    <span className="briefing-side">
      {pr && <PrLink pr={pr} />}
      <MarkButtons itemKey={itemKey} onMark={onMark} />
    </span>
  );
}

function MarkButtons({ itemKey, onMark }: { itemKey: string | null; onMark?: (key: string, action: 'done' | 'defer') => void }) {
  if (!itemKey || !onMark) return null;
  return (
    <span className="briefing-marks">
      <button type="button" className="briefing-mark" onClick={() => onMark(itemKey, 'done')} title="Done: leave it out of the next briefings">Done</button>
      <button type="button" className="briefing-mark" onClick={() => onMark(itemKey, 'defer')} title="Leave it out for a day">Defer a day</button>
    </span>
  );
}

interface BodyProps {
  view: BriefingView;
  variant: 'full' | 'compact';
  linkMode: LinkMode;
  marks?: ReadonlyMap<string, BriefingDismissal>;
  onMark?: (key: string, action: 'done' | 'defer') => void;
  onRestore?: (key: string) => void;
}

export function BriefingBody({ view, variant, linkMode, marks = new Map(), onMark, onRestore }: BodyProps) {
  const c = view.content;
  const tiles = statTiles(view.stats);
  const compact = variant === 'compact';
  const finished = finishedLabel(view);
  const open = splitMarked(c?.leftOpen ?? [], marks, view.createdAt);
  const better = splitMarked(c?.workBetter ?? [], marks, view.createdAt);
  const worked = groupWorkedOn(c?.workedOn ?? [], view.projects);
  const hidden = [
    ...open.hidden.map(x => ({ key: x.key!, text: x.title, mark: x.mark })),
    ...better.hidden.map(x => ({ key: x.key, text: x.text, mark: x.mark })),
  ];
  const openShown = compact ? open.shown.slice(0, 3) : open.shown;
  const workedShown = compact ? worked.slice(0, 2).map(g => ({ ...g, items: g.items.slice(0, 2) })) : worked;
  const betterShown = compact ? better.shown.slice(0, 2) : better.shown;
  const where = (projectId: string | null, workstream: string | null) => sessionLabel(projectId, workstream, view.projects);

  return (
    <div className="briefing-body">
      <div className="briefing-window">{windowHeading(view)}</div>
      {(view.boxName || finished) && (
        <div className="usage-dim briefing-meta">
          {[view.boxName ? `on ${view.boxName}` : null, finished ? `finished ${finished}` : null].filter(Boolean).join(' · ')}
        </div>
      )}
      {c?.headline && <p className="briefing-headline">{c.headline}</p>}
      {!compact && tiles.length > 0 && (
        <div className="dash-kpis briefing-stats">
          {tiles.map(t => (
            <div className="dash-tile" key={t.id}>
              <div className="dash-tile-label">{t.label}</div>
              <div className="dash-tile-value">{t.value}</div>
            </div>
          ))}
        </div>
      )}
      {!compact && view.charts && <Suspense fallback={null}><BriefingCharts charts={view.charts} /></Suspense>}

      {workedShown.length > 0 && (
        <div className="briefing-group">
          <div className="briefing-group-label">Worked on</div>
          <div className="briefing-worked">
            {workedShown.map((g, gi) => {
              const href = sessionHref(g.projectId, g.workstream, view.projects, linkMode);
              return (
                <div className="briefing-worked-group" key={gi}>
                  {g.label && (href ? <Link className="attn-project" to={href}>{g.label}</Link> : <span className="attn-project">{g.label}</span>)}
                  <ul className="briefing-bullets">
                    {g.items.map((it, i) => (
                      <li key={i}>
                        {it.text}
                        {it.prs.map(pr => <React.Fragment key={pr}> <PrLink pr={pr} /></React.Fragment>)}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {openShown.length > 0 && (
        <div className="briefing-group">
          <div className="briefing-group-label">Left open</div>
          <ol className="attn-list briefing-list">
            {openShown.map((it, i) => {
              const w = where(it.projectId, it.workstream);
              return (
                <li key={`${it.key ?? 'x'}-${i}`} className="briefing-row">
                  <ItemLink href={sessionHref(it.projectId, it.workstream, view.projects, linkMode)}>
                    <span className={`attn-chip briefing-kind briefing-kind--${it.kind}`}>{KIND_LABEL[it.kind]}</span>
                    <span className="attn-body">
                      <span className="attn-title">
                        {w && <span className="attn-project">{w}</span>}
                        {it.title}
                      </span>
                      {it.detail && <span className="attn-detail">{it.detail}</span>}
                    </span>
                  </ItemLink>
                  <RowSide itemKey={it.key} pr={it.pr} onMark={onMark} />
                </li>
              );
            })}
          </ol>
          {compact && open.shown.length > openShown.length && (
            <div className="usage-dim">and {open.shown.length - openShown.length} more</div>
          )}
        </div>
      )}

      {betterShown.length > 0 && (
        <div className="briefing-group">
          <div className="briefing-group-label">Work better</div>
          <ul className="attn-list briefing-list">
            {betterShown.map(it => (
              <li key={it.key} className="briefing-row briefing-row--plain">
                <ItemLink href={sessionHref(it.projectId, it.workstream, view.projects, linkMode)}>
                  <span className="attn-body">
                    <span className="attn-title">{it.text}</span>
                    {it.why && <span className="attn-detail">{it.why}</span>}
                  </span>
                </ItemLink>
                <RowSide itemKey={it.key} onMark={onMark} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {hidden.length > 0 && onRestore && (
        <details className="briefing-hidden">
          <summary className="usage-dim">Done or deferred ({hidden.length})</summary>
          <ul className="briefing-bullets">
            {hidden.map(h => (
              <li key={h.key}>
                <span className="usage-dim">{h.text} · {markLabel(h.mark)}</span>
                <button type="button" className="briefing-mark" onClick={() => onRestore(h.key)}>Bring back</button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {c && worked.length === 0 && open.shown.length === 0 && better.shown.length === 0 && !c.headline && (
        <div className="usage-dim">Nothing was left open.</div>
      )}
    </div>
  );
}
