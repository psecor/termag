import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { prsApi, reviewApi, type PrLaneId, type PrRow } from '../services/api';
import { usePolled } from '../pages/dashboard/useDashboardData';
import { PrDetail } from '../pages/dashboard/PrOverviewDialog';
import { projectHref } from '../pages/dashboard/AttentionSection';
import { ConfirmDialog } from './ConfirmDialog';
import { PrWorkstreamPicker } from './PrWorkstreamPicker';
import { linkedByText } from '../utils/workstreamChoices';
import { Dialog } from './Dialog';
import { fmtAge } from '../utils/format';
import {
  LANE_HINT, PRS_CHANGED_EVENT, PRS_PARAM, PR_PARAM, bakePending, boxesBehindText, compareUrl, deferrals, deferredText, deployStage, isPrsView, laneTabLabel, lanesOf,
  needsYouRows, prsSearch, rowDetail, rowLabel, rowParam, splitDeferred, viewEntries, apiErrorText, type PrsView } from '../utils/prPipeline';

/**
 * The PR overlay: every pull request
 * and what to do about it, over whatever page opened it, so acting on PRs does
 * not leave the workspace. Opened by `?prs=<view>` (the status strip's PRs
 * tile, the dashboard's Attention items), with `&pr=<owner/name#n>` selecting
 * a row; closing drops both and leaves the page's own parameters alone.
 *
 * Two panes: the view's rows on the left (Needs you first: what the tile
 * counts, with why), the selected row on the right (PrDetail: review, merge,
 * re-run, ping; for a branch, Open a PR). Arrow keys or j/k move through the
 * rows when the focus is not in a text field; Esc closes (from a text field
 * it only leaves the field, so a draft review is not lost to one key).
 *
 * Defer (or `d`) puts the shown row off for a day: it leaves the view, the
 * Needs you count and the tile, and waits under "Deferred" at the foot of the
 * list until then.
 */
export function PrsOverlay() {
  const location = useLocation();
  const q = new URLSearchParams(location.search);
  const view = q.get(PRS_PARAM);
  if (!isPrsView(view)) return null;
  return createPortal(<Panel view={view} selectedKey={q.get(PR_PARAM)} />, document.body);
}

function Panel({ view, selectedKey }: { view: PrsView; selectedKey: string | null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const prs = usePolled(() => prsApi.list(), 60_000);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const root = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [confirmReview, setConfirmReview] = useState<PrRow | null>(null);
  const [confirmBake, setConfirmBake] = useState(false);
  const [actionError, setActionError] = useState('');
  const [bakeState, setBakeState] = useState<{ busy: boolean; startedAt: number | null }>({ busy: false, startedAt: null });
  const [showDeferred, setShowDeferred] = useState(false);
  const [deferBusy, setDeferBusy] = useState(false);

  const go = useCallback((next: PrsView | null, pr?: string | null) => {
    navigate({ search: prsSearch(window.location.search, next, pr) }, { replace: next !== null });
  }, [navigate]);
  const close = useCallback(() => go(null), [go]);
  // A write on GitHub: re-read the lanes here, and tell the tile.
  const changed = useCallback(() => { prs.refresh(); window.dispatchEvent(new Event(PRS_CHANGED_EVENT)); }, [prs]);

  const res = prs.data;
  const split = useMemo(() => splitDeferred(viewEntries(view, res, now), res, now), [view, res, now]);
  // What j/k walks: the shown rows, then the deferred ones while their list is open.
  const entries = useMemo(() => (showDeferred ? [...split.shown, ...split.deferred] : split.shown), [split, showDeferred]);
  const all = useMemo(() => lanesOf(res).flatMap(l => l.rows), [res]);
  // The selected row: the one the URL names (wherever it is now: a review moves
  // it out of Needs you), else the view's first. One acted on and gone from
  // every lane stays shown until another is picked.
  const lastShown = useRef<PrRow | null>(null);
  const selected = (selectedKey ? all.find(r => rowParam(r) === selectedKey) ?? (lastShown.current && rowParam(lastShown.current) === selectedKey ? lastShown.current : null) : null)
    ?? split.shown[0]?.row ?? null;
  lastShown.current = selected;
  const selectedParam = selected ? rowParam(selected) : null;
  const index = entries.findIndex(e => rowParam(e.row) === selectedParam);

  const pick = (r: PrRow) => go(view, rowParam(r));
  const move = (d: number) => {
    if (entries.length === 0) return;
    const i = Math.max(0, Math.min(entries.length - 1, (index < 0 ? -1 : index) + d));
    pick(entries[i].row);
  };

  // Pin the row on show: with no `pr` the first row is shown, and acting on it
  // (a review moves it out of Needs you) must not switch the pane to the next one.
  useEffect(() => {
    if (!selectedKey && selectedParam) go(view, selectedParam);
  }, [selectedKey, selectedParam, view, go]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedParam]);

  const deferredUntil = selectedParam ? deferrals(res, now).get(selectedParam) ?? null : null;
  // Defer the shown row (again: one more day) and, like archiving a mail, move on to the next shown row.
  const defer = async (r: PrRow) => {
    const key = rowParam(r);
    const wasDeferred = deferrals(res, now).has(key);
    const i = split.shown.findIndex(e => rowParam(e.row) === key);
    const next = wasDeferred || i < 0 ? null : split.shown[i + 1]?.row ?? split.shown[i - 1]?.row ?? null;
    setDeferBusy(true);
    setActionError('');
    try {
      await prsApi.defer(key);
      if (next) pick(next);
      changed();
    } catch (err) {
      setActionError(apiErrorText(err, 'Could not defer it.'));
    } finally {
      setDeferBusy(false);
    }
  };
  const undefer = async (r: PrRow) => {
    setDeferBusy(true);
    setActionError('');
    try {
      await prsApi.undefer(rowParam(r));
      changed();
    } catch (err) {
      setActionError(apiErrorText(err, 'Could not bring it back.'));
    } finally {
      setDeferBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    // A confirm whose own panel doesn't have focus: Escape cancels it, not the overlay.
    if (confirmReview || confirmBake) {
      if (e.key === 'Escape') { e.preventDefault(); setConfirmReview(null); setConfirmBake(false); }
      return;
    }
    const t = e.target as HTMLElement;
    const typing = t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable;
    if (e.key === 'Escape') {
      e.preventDefault();
      if (typing) { t.blur(); root.current?.focus(); } else close();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); move(1); }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); move(-1); }
    if (e.key === 'd' && selected && !deferBusy) { e.preventDefault(); void defer(selected); }
  };

  // Not deployed: how far its merges are, and Bake & deploy now.
  const runListed = !!(res?.connected && res.deploy?.bakes?.length);
  const baking = bakePending(bakeState.startedAt, runListed, now);
  useEffect(() => {
    if (bakeState.startedAt !== null && !baking) setBakeState(s => ({ ...s, startedAt: null }));
  }, [baking, bakeState.startedAt]);
  // Deferred merges still wait on the deploy: the stage counts them, as the phone's does.
  const laneRows = [...split.shown, ...split.deferred].map(e => e.row);
  const stage = res?.connected && view === 'merged_not_deployed' && laneRows.length > 0 ? deployStage(laneRows, res.deploy, now) : null;
  const startBake = async () => {
    setConfirmBake(false);
    setBakeState({ busy: true, startedAt: null });
    setActionError('');
    try {
      await prsApi.bake();
      setBakeState({ busy: false, startedAt: Date.now() });
      changed();
    } catch (err) {
      setBakeState({ busy: false, startedAt: null });
      setActionError(apiErrorText(err, 'Could not start the bake.'));
    }
  };

  const startDevinReview = async (r: PrRow) => {
    const t = r.reviewTarget;
    setConfirmReview(null);
    if (!t || r.number == null) return;
    setActionError('');
    try {
      await reviewApi.start(t.projectId, { workstream: t.workstream, pr: r.number, url: r.url });
      navigate(projectHref(t.projectId, t.workstream));
    } catch (err) {
      setActionError(apiErrorText(err, 'Could not start the review.'));
    }
  };

  const lanes = lanesOf(res);
  const needsCount = needsYouRows(res, now).length;
  const deferredKeys = deferrals(res, now);
  const tabs: { id: PrsView; label: string; count: number }[] = [
    { id: 'needs_you', label: 'Needs you', count: needsCount },
    ...lanes.map(l => ({
      id: l.id as PrsView, label: laneTabLabel(l.id as PrLaneId, res), count: l.rows.filter(r => !deferredKeys.has(rowParam(r))).length,
    })),
  ];
  const renderRow = ({ row, why }: { row: PrRow; why: string }, until?: number) => {
    const key = rowParam(row);
    const at = row.requestedAt ?? row.at;
    return (
      <button
        key={key}
        type="button"
        role="option"
        aria-selected={key === selectedParam}
        className={`prso-row ${key === selectedParam ? 'active' : ''} ${until !== undefined ? 'prso-row--deferred' : ''}`}
        onClick={() => pick(row)}
      >
        <span className="prso-row-top">
          <span className="prso-label">{rowLabel(row)}</span>
          {at && <span className="usage-dim">{fmtAge(Math.max(0, now - Date.parse(at)))}</span>}
        </span>
        <span className="prso-row-title">{row.kind === 'pr' ? row.title : 'no pull request yet'}</span>
        <span className={`prso-row-why${boxesBehindText(row) ? ' is-boxes-behind' : ''}`}>{until !== undefined ? `${why} · ${deferredText(until, now)}` : why}</span>
      </button>
    );
  };

  return (
    <Dialog ariaLabel="Pull requests" className="prso" backdropClassName="confirm-backdrop--under" panelRef={root} onKeyDown={onKey} onClose={close}>
      <header className="prso-head">
        <span className="prso-title">Pull requests</span>
        <span className="usage-dim">
          {res?.connected ? `as ${res.viewer} · ${fmtAge(Math.max(0, now - Date.parse(res.fetchedAt)))} ago` : prs.loading ? 'loading…' : ''}
        </span>
        <span className="prso-keys usage-dim">↑↓ / j k to move · d to defer a day · Esc to close</span>
        <button type="button" className="btn-ghost btn-tiny pro-close" onClick={close} aria-label="Close">✕</button>
      </header>

      {res && !res.connected ? (
        <div className="prso-empty"><Link to="/settings">Connect GitHub in Settings</Link> to see where your pull requests stand.</div>
      ) : (
        <>
          <nav className="prs-strip prso-tabs" role="tablist" aria-label="PR views">
            {tabs.map(t => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={t.id === view}
                className={`prs-lane ${t.id === view ? 'active' : ''} ${t.id === 'needs_you' && t.count > 0 ? 'prs-lane--act' : ''}`}
                title={t.id === 'needs_you' ? undefined : LANE_HINT[t.id]}
                onClick={() => go(t.id)}
              >
                <span className="prs-lane-count" data-zero={t.count === 0 || undefined}>{t.count}</span>
                <span className="prs-lane-label">{t.label}</span>
              </button>
            ))}
          </nav>
          {prs.error != null && <div className="error-text">{apiErrorText(prs.error, 'Could not read your pull requests from GitHub.')}{res ? ' Showing the last answer.' : ''}</div>}
          {actionError && <div className="error-text" role="alert">{actionError}</div>}

          <div className="prso-body">
            <div className="prso-list" ref={listRef} role="listbox" aria-label="Pull requests in this view">
              {stage && (
                <div className="prs-deploy">
                  <span className="usage-dim">{stage.text}</span>
                  {stage.runUrl && <a href={stage.runUrl} target="_blank" rel="noreferrer">Open the run ↗</a>}
                  {stage.offerBake && !baking && (
                    <button type="button" className="btn-ghost btn-tiny prs-review" disabled={bakeState.busy} onClick={() => setConfirmBake(true)}>
                      {bakeState.busy ? 'Starting…' : 'Bake & deploy now'}
                    </button>
                  )}
                  {baking && <span className="pro-done">Bake started; it shows here within a minute.</span>}
                  {res?.connected && res.deploy && <a href={res.deploy.workflowUrl} target="_blank" rel="noreferrer">Publish AMI runs ↗</a>}
                </div>
              )}
              {!res && !prs.error && <div className="usage-dim prso-empty">Reading from GitHub…</div>}
              {res && split.shown.length === 0 && (
                <div className="usage-dim prso-empty">
                  {view === 'needs_you' ? 'Nothing needs you right now.' : `Nothing in ${lanes.find(l => l.id === view)?.label ?? 'this lane'}.`}
                  {split.deferred.length > 0 && ' Deferred ones are below.'}
                </div>
              )}
              {split.shown.map(e => renderRow(e))}
              {split.deferred.length > 0 && (
                <>
                  <button type="button" className="prso-deferred-toggle" aria-expanded={showDeferred} onClick={() => setShowDeferred(v => !v)}>
                    {showDeferred ? '▾' : '▸'} Deferred ({split.deferred.length})
                  </button>
                  {showDeferred && split.deferred.map(e => renderRow(e, e.until))}
                </>
              )}
              {res?.connected && res.notes.map(n => <div key={n} className="usage-dim prso-note">{n}</div>)}
            </div>

            <div className="prso-detail">
              {!selected ? (
                <div className="usage-dim prso-empty">Pick a pull request.</div>
              ) : (
                <>
                  <div className="prso-detail-head">
                    <span className="pro-label">{rowLabel(selected)}</span>
                    {selected.workstream && (
                      <Link className="prs-ws" to={projectHref(selected.workstream.projectId, selected.workstream.workstream)}
                        title={`Open workstream${linkedByText(selected.linkedBy) ? ` (${linkedByText(selected.linkedBy)})` : ''}`}>
                        {selected.workstream.projectName}{selected.workstream.workstream !== 'main' ? ` · ${selected.workstream.workstream}` : ''} →
                      </Link>
                    )}
                    <PrWorkstreamPicker key={selectedParam ?? ''} row={selected} checkouts={res?.connected ? res.checkouts : undefined} onChanged={changed} onError={setActionError} />
                    {selected.lane === 'needs_my_review' && selected.reviewTarget && (
                      <button type="button" className="btn-ghost btn-tiny prs-review" onClick={() => setConfirmReview(selected)}>Review with Devin</button>
                    )}
                    <span className="prso-defer">
                      {deferredUntil !== null && <span className="usage-dim">{deferredText(deferredUntil, now)}</span>}
                      <button
                        type="button"
                        className="btn-ghost btn-tiny"
                        disabled={deferBusy}
                        title={deferredUntil !== null ? 'Keep it out of Needs you for one more day' : 'Hide it from Needs you and the PRs tile for a day (d)'}
                        onClick={() => { void defer(selected); }}
                      >
                        {deferredUntil !== null ? 'Another day' : 'Defer a day'}
                      </button>
                      {deferredUntil !== null && (
                        <button type="button" className="btn-ghost btn-tiny" disabled={deferBusy} onClick={() => { void undefer(selected); }}>Bring back</button>
                      )}
                    </span>
                  </div>
                  {selected.kind === 'pr' && selected.repo && selected.number != null
                    ? <PrDetail key={rowParam(selected)} row={selected} now={now} onChanged={changed} />
                    : <BranchDetail row={selected} now={now} />}
                </>
              )}
            </div>
          </div>
        </>
      )}

      {confirmReview?.reviewTarget && (
        <ConfirmDialog
          message={<>Start a Devin review of <strong>{rowLabel(confirmReview)}</strong> in{' '}
            <strong>{confirmReview.reviewTarget.projectName}{confirmReview.reviewTarget.workstream !== 'main' ? ` · ${confirmReview.reviewTarget.workstream}` : ''}</strong>?
            {' '}A review already running there is replaced.</>}
          confirmLabel="Start review"
          tone="primary"
          onConfirm={() => { void startDevinReview(confirmReview); }}
          onCancel={() => setConfirmReview(null)}
        />
      )}
      {confirmBake && (
        <ConfirmDialog
          message={<>Bake <strong>main</strong> into an orchestrator image and deploy it?
            {' '}About 20 minutes to bake, then an instance refresh moves every termag user to a new host.
            {' '}It ships everything merged to main, not only your pull requests.</>}
          confirmLabel="Bake & deploy"
          tone="primary"
          onConfirm={() => { void startBake(); }}
          onCancel={() => setConfirmBake(false)}
        />
      )}
    </Dialog>
  );
}

/** A branch with no PR: where it is, and the way to open one. */
function BranchDetail({ row, now }: { row: PrRow; now: number }) {
  const compare = compareUrl(row);
  return (
    <>
      <div className="pro-title">{row.headRefName}</div>
      <div className="pro-meta">
        <span>{row.repo}</span>
        <span className="pro-branches"><code>{row.headRefName}</code> → <code>{row.baseRefName}</code></span>
        {row.badges.includes('dirty') && <span className="pro-checks pro-checks--wait">uncommitted changes</span>}
      </div>
      <div className="usage-dim pro-note">{rowDetail(row, now)}</div>
      <div className="confirm-actions pro-actions">
        {compare
          ? <a className="btn-primary pro-gh" href={compare} target="_blank" rel="noreferrer">Open a PR on GitHub ↗</a>
          : <span className="usage-dim">Push the branch to open a pull request from it.</span>}
      </div>
    </>
  );
}
