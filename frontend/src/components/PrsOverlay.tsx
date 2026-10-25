import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { prsApi, reviewApi, type PrLaneId, type PrReviewGroup, type PrRow } from '../services/api';
import { usePolled } from '../pages/dashboard/useDashboardData';
import { PrDetail } from '../pages/dashboard/PrOverviewDialog';
import { projectHref } from '../pages/dashboard/AttentionSection';
import { ConfirmDialog } from './ConfirmDialog';
import { PrWorkstreamPicker } from './PrWorkstreamPicker';
import { AddToGroup, ClosedGroups, ReviewGroupCard, SuggestionCard } from './ReviewGroupCard';
import { FLAGS, useFlag } from '../flags';
import {
  closedGroups, groupKey, groupPill, groupPlaces, groupReviewBody, groupReviewPlan, isCardView, memberLabel, memberRows, nextMember, openGroups, suggestionsOf,
} from '../utils/prReviewGroups';
import { SharePrPreview } from './SharePrPreview';
import { linkedByText } from '../utils/workstreamChoices';
import { Dialog } from './Dialog';
import { fmtAge } from '../utils/format';
import { currentSearchShortcut } from '../utils/workspaceTarget';
import { OPEN_PALETTE_EVENT, type OpenPaletteDetail } from '../utils/searchPalette';
import {
  LANE_HINT, PRS_CHANGED_EVENT, PRS_PARAM, PRS_REPO_PARAM, PR_PARAM, bakePending, boxesBehindText, compareUrl, deferrals, deferredText, deployStage, inRepo, isPrsView, laneTabLabel, lanesOf,
  isReviewLane, myReviewCount, needsYouRows, prsRepoSearch, prsSearch, rowDetail, rowLabel, rowParam, splitDeferred, viewEntries, apiErrorText, type PrsView } from '../utils/prPipeline';

/**
 * The PR overlay: every pull request
 * and what to do about it, over whatever page opened it, so acting on PRs does
 * not leave the workspace. Opened by `?prs=<view>` (the status strip's PRs
 * tile, the dashboard's Attention items), with `&pr=<owner/name#n>` selecting
 * a row and `&prs_repo=<owner/name>` keeping every view to one repository
 * (every repository without it; a link that names one shows it as a chip
 * that clears it); closing drops all three and leaves the page's own
 * parameters alone.
 *
 * Two panes: the view's rows on the left (Needs you first: what the tile
 * counts, with why), the selected row on the right (PrDetail: review, merge,
 * re-run, ping; for a branch, Open a PR). Arrow keys or j/k move through the
 * rows when the focus is not in a text field; Esc closes (from a text field
 * it only leaves the field, so a draft review is not lost to one key).
 *
 * Search is the ⌘K palette (Search… in the header, ⌘K, or `/`): it finds
 * PRs in every lane beside sessions and pane text, and picking one comes back
 * here on its lane with the row selected. Both pages that mount the overlay
 * (the workspace, the dashboard) carry the palette.
 *
 * Defer (or `d`) puts the shown row off for a day: it leaves the view, the
 * Needs you count and the tile, and waits under "Deferred" at the foot of the
 * list until then.
 *
 * Review groups (pr-review-groups-enabled):
 *  the user's own ordered lists of PRs reviewed together, one card
 * each at the top of Needs you and Needs my review. A grouped row shows only
 * in its card there, and with a "Desktop bridge 2/5" pill in other lanes; the
 * counts are unchanged. Add to group… in the detail header puts the shown PR
 * in one.
 */
export function PrsOverlay() {
  const location = useLocation();
  const q = new URLSearchParams(location.search);
  const view = q.get(PRS_PARAM);
  if (!isPrsView(view)) return null;
  return createPortal(<Panel view={view} selectedKey={q.get(PR_PARAM)} repo={q.get(PRS_REPO_PARAM) || null} />, document.body);
}

function Panel({ view, selectedKey, repo }: { view: PrsView; selectedKey: string | null; repo: string | null }) {
  const navigate = useNavigate();
  const location = useLocation();
  const prs = usePolled(() => prsApi.list(), 60_000);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const root = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [confirmReview, setConfirmReview] = useState<PrRow | null>(null);
  // Review all with Devin, waiting on its confirm: by id, so each new answer's group is the one confirmed.
  const [confirmGroupId, setConfirmGroupId] = useState<string | null>(null);
  const [confirmBake, setConfirmBake] = useState(false);
  const [actionError, setActionError] = useState('');
  const [bakeState, setBakeState] = useState<{ busy: boolean; startedAt: number | null }>({ busy: false, startedAt: null });
  const [showDeferred, setShowDeferred] = useState(false);
  const [deferBusy, setDeferBusy] = useState(false);
  const groupsOn = useFlag(FLAGS.prReviewGroups, false);

  const go = useCallback((next: PrsView | null, pr?: string | null) => {
    navigate({ search: prsSearch(window.location.search, next, pr) }, { replace: next !== null });
  }, [navigate]);
  const close = useCallback(() => go(null), [go]);
  const clearRepo = () => navigate({ search: prsRepoSearch(window.location.search, null) }, { replace: true });
  const openSearch = () => window.dispatchEvent(new CustomEvent<OpenPaletteDetail>(OPEN_PALETTE_EVENT, { detail: { via: 'prs-overlay' } }));
  // A write on GitHub: re-read the lanes here, and tell the tile.
  const changed = useCallback(() => { prs.refresh(); window.dispatchEvent(new Event(PRS_CHANGED_EVENT)); }, [prs]);

  const res = prs.data;
  // Review groups: their cards head Needs you and Needs my review, whose lists then leave grouped rows to the cards.
  const places = useMemo(() => (groupsOn ? groupPlaces(res) : new Map<string, never>()), [groupsOn, res]);
  const cardView = groupsOn && isCardView(view);
  const cards = useMemo(() => (cardView
    ? openGroups(res).filter(g => !repo || g.members.some(m => m.repo.toLowerCase() === repo.toLowerCase()))
    : []), [cardView, res, repo]);
  const split = useMemo(() => splitDeferred(viewEntries(view, res, now)
    .filter(e => inRepo(e.row, repo))
    .filter(e => !cardView || !places.has(groupKey(e.row) ?? '')), res, now), [view, res, now, repo, cardView, places]);
  // Suggested groups head the same views (phase 3).
  const suggested = useMemo(() => (cardView
    ? suggestionsOf(res).filter(sg => !repo || sg.members.some(m => m.repo.toLowerCase() === repo.toLowerCase()))
    : []), [cardView, res, repo]);
  // The cards' members (folded, done cards' too), for j/k ahead of the list.
  const cardEntries = useMemo(() => cards.flatMap(g => g.members.flatMap(m => (m.row ? [{ row: m.row, why: '' }] : []))), [cards]);
  // What j/k walks: the cards' members, the shown rows, then the deferred ones while their list is open.
  const entries = useMemo(() => [...cardEntries, ...(showDeferred ? [...split.shown, ...split.deferred] : split.shown)], [cardEntries, split, showDeferred]);
  // A member no lane lists has a row built for its card: it can be picked too.
  const all = useMemo(() => [...lanesOf(res).flatMap(l => l.rows), ...(groupsOn ? memberRows(res) : [])], [res, groupsOn]);
  // The selected row: the one the URL names (wherever it is now: a review moves
  // it out of Needs you), else the view's first. One acted on and gone from
  // every lane stays shown until another is picked.
  const lastShown = useRef<PrRow | null>(null);
  const selected = (selectedKey ? all.find(r => rowParam(r) === selectedKey) ?? (lastShown.current && rowParam(lastShown.current) === selectedKey ? lastShown.current : null) : null)
    ?? split.shown[0]?.row ?? (cards.map(g => nextMember(g, res?.connected ? res.viewer : null)).find(m => m?.row)?.row ?? null);
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

  // A deferred row opened by name (⌘K, a link) opens the
  // Deferred list, so it shows where it sits, even when it is already the
  // selected row (picked again after the list was folded). Keyed on each
  // navigation and the first answer, not the deferrals: deferring the shown
  // row with d moves on to a shown row, or stays put, and leaves the list as
  // it was.
  const loaded = !!res;
  useEffect(() => {
    if (selectedParam && split.deferred.some(e => rowParam(e.row) === selectedParam)) setShowDeferred(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, selectedParam, view, loaded]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedParam, showDeferred]);

  const deferredUntil = selectedParam ? deferrals(res, now).get(selectedParam) ?? null : null;
  // A card's member is not in the list a deferral hides it from, so it is not deferred from here (Devin, #667).
  const inCard = !!selected && cardView && places.has(groupKey(selected) ?? '');
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
    if (confirmReview || confirmBake || confirmGroupId) {
      if (e.key === 'Escape') { e.preventDefault(); setConfirmReview(null); setConfirmBake(false); setConfirmGroupId(null); }
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
    if (e.key === 'd' && selected && !deferBusy && !inCard) { e.preventDefault(); void defer(selected); }
    if (e.key === '/') { e.preventDefault(); openSearch(); }
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

  // One Devin session over the group's members left to review, in order.
  const viewer = res?.connected ? res.viewer : null;
  const startGroupReview = async (g: PrReviewGroup) => {
    setConfirmGroupId(null);
    const plan = groupReviewPlan(g, viewer);
    if ('reason' in plan) { setActionError(plan.reason); return; }
    const [first] = plan.members;
    setActionError('');
    try {
      await reviewApi.start(plan.target.projectId, { workstream: plan.target.workstream, pr: first.number, url: first.url, group: groupReviewBody(g, plan.members) });
      navigate(projectHref(plan.target.projectId, plan.target.workstream));
    } catch (err) {
      setActionError(apiErrorText(err, 'Could not start the review.'));
    }
  };
  const confirmGroup = confirmGroupId ? openGroups(res).find(g => g.id === confirmGroupId) ?? null : null;
  const groupPlan = confirmGroup ? groupReviewPlan(confirmGroup, viewer) : confirmGroupId ? { reason: 'The group is gone' } : null;
  // A refresh that leaves nothing to start: drop the confirm and say why, rather than a dialog that never shows (Devin, #668).
  const groupPlanReason = groupPlan && 'reason' in groupPlan ? groupPlan.reason : null;
  useEffect(() => {
    if (groupPlanReason) { setConfirmGroupId(null); setActionError(groupPlanReason); }
  }, [groupPlanReason]);

  const lanes = lanesOf(res);
  // The tab's number is reviews asked of you by name, like the tile; its list is everything that needs you.
  const needsCount = myReviewCount(res, now, r => inRepo(r, repo));
  const deferredKeys = deferrals(res, now);
  const tabs: { id: PrsView; label: string; count: number }[] = [
    { id: 'needs_you', label: 'Needs you', count: needsCount },
    ...lanes.map(l => ({
      id: l.id as PrsView, label: laneTabLabel(l.id as PrLaneId, res), count: l.rows.filter(r => inRepo(r, repo) && !deferredKeys.has(rowParam(r))).length,
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
        {groupsOn && !cardView && groupPill(places.get(groupKey(row) ?? '')) && (
          <span className="prg-pill" title="In one of your review groups">{groupPill(places.get(groupKey(row) ?? ''))}</span>
        )}
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
        {repo && (
          <span className="prso-repo-chip">
            only {repo.split('/')[1] ?? repo}
            <button type="button" className="btn-ghost btn-tiny" onClick={clearRepo} aria-label={`Show every repository, not only ${repo}`} title="Show every repository">✕</button>
          </span>
        )}
        <button
          type="button"
          className="search-trigger prso-search"
          title={`Search pull requests, sessions and pane text (${currentSearchShortcut()} or /)`}
          onClick={openSearch}
        >
          <span>⌕ Search…</span><kbd>{currentSearchShortcut()}</kbd>
        </button>
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
                title={t.id === 'needs_you' ? 'The number counts reviews asked of you by name; the list also has team review requests and your own PRs to merge or fix' : LANE_HINT[t.id]}
                onClick={() => go(t.id)}
              >
                <span className="prs-lane-count" data-zero={t.count === 0 || undefined}>{t.count}</span>
                <span className="prs-lane-label">{t.label}</span>
              </button>
            ))}
          </nav>
          {prs.error != null && <div className="error-text">{apiErrorText(prs.error, 'Could not read your pull requests from GitHub.')}{res ? ' Showing the last answer.' : ''}</div>}
          {actionError && <div className="error-text" role="alert">{actionError}</div>}
          {groupsOn && res?.connected && res.groupsError && <div className="error-text">{res.groupsError}</div>}

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
              {suggested.map(sg => <SuggestionCard key={sg.key} suggestion={sg} groups={openGroups(res)} onChanged={changed} onError={setActionError} />)}
              {cards.map(g => (
                <ReviewGroupCard key={g.id} group={g} viewer={res?.connected ? res.viewer : null} now={now} selectedKey={selectedParam}
                  knownRepos={[...new Set(all.map(r => r.repo).filter((r): r is string => !!r))]}
                  onPick={pick} onChanged={changed} onError={setActionError} onReviewAll={g => setConfirmGroupId(g.id)} />
              ))}
              {res && split.shown.length === 0 && cards.length === 0 && suggested.length === 0 && (
                <div className="usage-dim prso-empty">
                  {view === 'needs_you'
                    ? `Nothing${repo ? ` in ${repo}` : ''} needs you right now.`
                    : `Nothing${repo ? ` from ${repo}` : ''} in ${lanes.find(l => l.id === view)?.label ?? 'this lane'}.`}
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
              {groupsOn && view === 'needs_you' && (
                <ClosedGroups groups={closedGroups(res)} now={now} onChanged={changed} onError={setActionError} />
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
                    <SharePrPreview key={`share:${selectedParam ?? ''}`} row={selected} />
                    {groupsOn && selected.kind === 'pr' && (
                      <AddToGroup key={`group:${selectedParam ?? ''}`} row={selected} groups={openGroups(res)} onChanged={changed} onError={setActionError} />
                    )}
                    {isReviewLane(selected.lane) && selected.reviewTarget && (
                      <button type="button" className="btn-ghost btn-tiny prs-review" onClick={() => setConfirmReview(selected)}>Review with Devin</button>
                    )}
                    {!inCard && <span className="prso-defer">
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
                    </span>}
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
      {confirmGroup && groupPlan && 'members' in groupPlan && (
        <ConfirmDialog
          message={<>Start one Devin review of the {groupPlan.members.length} PR{groupPlan.members.length === 1 ? '' : 's'} left in <strong>{confirmGroup.name}</strong>
            {' '}({groupPlan.members.map(memberLabel).join(', ')}), in order, in{' '}
            <strong>{groupPlan.target.projectName}{groupPlan.target.workstream !== 'main' ? ` · ${groupPlan.target.workstream}` : ''}</strong>?
            {' '}It reviews each, then what spans them. A review already running there is replaced.</>}
          confirmLabel="Start review"
          tone="primary"
          onConfirm={() => { void startGroupReview(confirmGroup); }}
          onCancel={() => setConfirmGroupId(null)}
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
