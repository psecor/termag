// The phone's PR screen: the pipeline's lanes as the
// inbox's segmented tabs, ordered by what can be done from a phone, opening on
// the first non-empty one. Tapping a PR opens its overview (the dashboard's
// PrOverviewDialog, full screen), as the conversation header's PR pill does;
// its ⋯ (and a tap on a pushed branch, which has no overview) opens the action
// sheet: the overview again (named by what the lane needs next: Review, Merge,
// Re-run checks, Ping reviewers), Open on GitHub (or Open a PR for a pushed
// branch), Open conversation (the linked workstream), and for review requests
// Review with Devin, which starts the review pane and lands on its tab. The Not deployed lane carries the dashboard's bake stage and Bake &
// deploy now. Defer a day puts a row off as the overlay's does: it sinks to
// the foot of its lane, marked, and leaves the inbox's PR count.
//
// Review groups (pr-review-groups-enabled):
//  each open group is a folded card at the top of My review, whose
// grouped rows then show only in it; elsewhere a grouped row's line names its
// place ("Desktop bridge 2/5"). A row's ⋯ offers Add to group…, and the card
// Review next and Review all with Devin.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { prsApi, reviewApi, type PrGroupMember, type PrGroupSuggestion, type PrLaneId, type PrReviewGroup, type PrRow, type PrWorkstreamLink } from '../../services/api';
import { FLAGS, useFlag } from '../../flags';
import { groupKey, groupPill, groupPlaces, groupReviewBody, groupReviewPlan, memberInputs, memberLabel, openGroups, suggestionsOf } from '../../utils/prReviewGroups';
import { AddToGroupSheet, MobileGroupCard, MobileSuggestionRow, SuggestionSheet } from './PrGroups';
import { usePolled } from '../dashboard/useDashboardData';
import { fmtAge } from '../../utils/format';
import {
  ACTIONABLE, PHONE_LANE_ORDER, bakePending, compareUrl, hasOverview, deferrals, deferredText, deployStage, firstNonEmpty, laneTabLabel, lanesOf, rowAction,
  isReviewLane, rowDetail, rowKey, rowLabel, rowParam,
} from '../../utils/prPipeline';
import { PrOverviewDialog } from '../dashboard/PrOverviewDialog';
import { ActionSheet, ConfirmSheet, apiError, type SheetAction } from './Sheet';
import { PullScroll } from './PullScroll';

// Geometric Shapes only: phone fonts lack the rarer symbols (⧗ drew as tofu).
const LANE_GLYPH: Record<PrLaneId, string> = {
  in_progress: '◇', needs_pr: '△', checks: '◌', needs_approval: '○', needs_my_review: '◉', team_review: '◎',
  ready_to_merge: '✓', merged_not_deployed: '▷', deployed: '●', merged: '●',
};

// The overview's name in the action sheet, by rowAction's label: the verbs read better with their object here.
const SHEET_LABEL: Record<string, string> = { Review: 'Review…', Merge: 'Merge…', 'Re-run': 'Re-run checks…', Ping: 'Ping reviewers…', Overview: 'Overview…' };

function isLane(v: string | null): v is PrLaneId {
  return v !== null && (PHONE_LANE_ORDER as string[]).includes(v);
}

function conversationHref(w: PrWorkstreamLink, role?: 'review'): string {
  const q = new URLSearchParams();
  if (w.workstream !== 'main') q.set('ws', w.workstream);
  if (role) q.set('role', role);
  const qs = q.toString();
  return `/m/p/${encodeURIComponent(w.projectId)}${qs ? `?${qs}` : ''}`;
}

function wsLabel(w: PrWorkstreamLink): string {
  return `${w.projectName}${w.workstream !== 'main' ? ` · ${w.workstream}` : ''}`;
}

export function Prs() {
  const navigate = useNavigate();
  const prs = usePolled(() => prsApi.list(), 60_000);
  const [params, setParams] = useSearchParams();
  const [menu, setMenu] = useState<PrRow | null>(null);
  const [confirm, setConfirm] = useState<PrRow | null>(null);
  const [actionError, setActionError] = useState('');
  const [overview, setOverview] = useState<PrRow | null>(null);
  const [confirmBake, setConfirmBake] = useState(false);
  const [bakeStartedAt, setBakeStartedAt] = useState<number | null>(null);
  const closeOverview = useCallback(() => setOverview(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeConfirm = useCallback(() => setConfirm(null), []);
  const groupsOn = useFlag(FLAGS.prReviewGroups, false);
  const [addTo, setAddTo] = useState<PrRow | null>(null);
  // By id: the confirm reads the group from each new answer, so a refresh that checks its last member off is seen.
  const [confirmGroupId, setConfirmGroupId] = useState<string | null>(null);
  // The ⋯ of a member GitHub could not read (no row, so no row action sheet).
  const [bareMenu, setBareMenu] = useState<{ group: PrReviewGroup; member: PrGroupMember } | null>(null);
  const closeBareMenu = useCallback(() => setBareMenu(null), []);
  const [suggestion, setSuggestion] = useState<PrGroupSuggestion | null>(null);
  const closeSuggestion = useCallback(() => setSuggestion(null), []);
  const closeAddTo = useCallback(() => setAddTo(null), []);
  const closeConfirmGroup = useCallback(() => setConfirmGroupId(null), []);
  const now = Date.now();

  const lanes = lanesOf(prs.data);
  const fromUrl = params.get('lane');
  const deferred = deferrals(prs.data, now);
  // Open on the first lane with something not deferred: a lane of deferred rows only counts 0.
  const live = lanes.map(l => ({ ...l, rows: l.rows.filter(r => !deferred.has(rowParam(r))) }));
  const selected: PrLaneId = isLane(fromUrl) ? fromUrl : firstNonEmpty(live, PHONE_LANE_ORDER);
  const pick = (id: PrLaneId) => {
    const next = new URLSearchParams(params);
    next.set('lane', id);
    setParams(next, { replace: true });
  };
  // Review groups: their cards head My review, which then leaves grouped rows to them.
  const places = groupsOn ? groupPlaces(prs.data) : new Map<string, never>();
  const cards = groupsOn && selected === 'needs_my_review' ? openGroups(prs.data) : [];
  const suggested = groupsOn && selected === 'needs_my_review' ? suggestionsOf(prs.data) : [];
  const viewer = prs.data?.connected ? prs.data.viewer : null;
  const laneRows = (lanes.find(l => l.id === selected)?.rows ?? []).filter(r => cards.length === 0 || !places.has(groupKey(r) ?? ''));
  // Deferred rows last, in their own order.
  const rows = [...laneRows.filter(r => !deferred.has(rowParam(r))), ...laneRows.filter(r => deferred.has(rowParam(r)))];
  // Nine tabs overflow a phone: keep the selected one on screen.
  const activeTab = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { activeTab.current?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' }); }, [selected, lanes.length]);

  const startReview = async (r: PrRow) => {
    const t = r.reviewTarget;
    if (!t || r.number == null) return;
    try {
      await reviewApi.start(t.projectId, { workstream: t.workstream, pr: r.number, url: r.url });
      navigate(conversationHref(t, 'review'));
    } catch (err) {
      setActionError(apiError(err, 'Could not start the review'));
    }
  };

  const openMember = (m: PrGroupMember) => {
    if (m.row && hasOverview(m.row)) setOverview(m.row);
    else window.open(m.url, '_blank', 'noopener');
  };
  // One Devin session over the members left to review, in order, landing on its review tab.
  const startGroupReview = async (g: PrReviewGroup) => {
    const plan = groupReviewPlan(g, viewer);
    if ('reason' in plan) { setActionError(plan.reason); return; }
    const [first] = plan.members;
    setActionError('');
    try {
      await reviewApi.start(plan.target.projectId, { workstream: plan.target.workstream, pr: first.number, url: first.url, group: groupReviewBody(g, plan.members) });
      navigate(conversationHref(plan.target, 'review'));
    } catch (err) {
      setActionError(apiError(err, 'Could not start the review'));
    }
  };
  const confirmGroup = confirmGroupId ? openGroups(prs.data).find(g => g.id === confirmGroupId) ?? null : null;
  const confirmPlan = confirmGroup ? groupReviewPlan(confirmGroup, viewer) : confirmGroupId ? { reason: 'The group is gone' } : null;
  // A refresh that leaves nothing to start (the last member checked off): drop the confirm and say why, not a sheet that never shows (Devin, #668).
  const planReason = confirmPlan && 'reason' in confirmPlan ? confirmPlan.reason : null;
  useEffect(() => {
    if (planReason) { setConfirmGroupId(null); setActionError(planReason); }
  }, [planReason]);
  const takeOut = async (g: PrReviewGroup, m: PrGroupMember) => {
    try {
      await prsApi.setGroupMembers(g.id, memberInputs(g.members.filter(x => x !== m)));
      prs.refresh();
    } catch (err) {
      setActionError(apiError(err, 'Could not take it out of the group'));
    }
  };

  const startBake = async () => {
    setConfirmBake(false);
    try {
      await prsApi.bake();
      setBakeStartedAt(Date.now());
      prs.refresh();
    } catch (err) {
      setActionError(apiError(err, 'Could not start the bake'));
    }
  };
  const defer = async (r: PrRow, back: boolean) => {
    try {
      if (back) await prsApi.undefer(rowParam(r)); else await prsApi.defer(rowParam(r));
      prs.refresh();
    } catch (err) {
      setActionError(apiError(err, back ? 'Could not bring it back' : 'Could not defer it'));
    }
  };
  const stage = prs.data?.connected && selected === 'merged_not_deployed' && rows.length > 0 ? deployStage(rows, prs.data.deploy, now) : null;
  const baking = bakePending(bakeStartedAt, !!(prs.data?.connected && prs.data.deploy?.bakes?.length), now);
  // Forget a started bake once its run is listed (or it never showed), as the dashboard does.
  useEffect(() => { if (bakeStartedAt !== null && !baking) setBakeStartedAt(null); }, [baking, bakeStartedAt]);

  const actionsFor = (r: PrRow): SheetAction[] => {
    const out: SheetAction[] = [];
    if (hasOverview(r)) out.push({ label: SHEET_LABEL[rowAction(r).label] ?? 'Overview…', onClick: () => setOverview(r) });
    const compare = compareUrl(r);
    if (compare) out.push({ label: 'Open a PR on GitHub', onClick: () => { window.open(compare, '_blank', 'noopener'); } });
    if (r.url) out.push({ label: 'Open on GitHub', onClick: () => { window.open(r.url!, '_blank', 'noopener'); } });
    if (r.workstream) out.push({ label: `Open conversation · ${wsLabel(r.workstream)}`, onClick: () => navigate(conversationHref(r.workstream!)) });
    if (isReviewLane(r.lane) && r.reviewTarget) out.push({ label: 'Review with Devin…', onClick: () => setConfirm(r) });
    if (groupsOn && r.kind === 'pr') {
      const place = places.get(groupKey(r) ?? '');
      out.push({ label: place ? `Review group: ${groupPill(place)}…` : 'Add to group…', onClick: () => setAddTo(r) });
    }
    const isDeferred = deferred.has(rowParam(r));
    out.push({ label: isDeferred ? 'Defer another day' : 'Defer a day', onClick: () => { void defer(r, false); } });
    if (isDeferred) out.push({ label: 'Bring back', onClick: () => { void defer(r, true); } });
    return out;
  };

  const notConnected = prs.data !== null && !prs.data.connected;

  return (
    <div className="m-screen">
      <header className="m-header m-header-conv">
        <Link className="m-link m-back" to="/m" aria-label="Back to inbox">‹</Link>
        <span className="m-conv-title">
          <span className="m-conv-name">Pull requests</span>
          <span className="m-conv-sub">
            {prs.data?.connected ? `as ${prs.data.viewer} · ${fmtAge(Math.max(0, now - Date.parse(prs.data.fetchedAt)))} ago` : prs.loading ? 'loading…' : ''}
          </span>
        </span>
      </header>
      {prs.error != null && (
        <div className="m-banner" data-connection="offline" role="alert">
          {apiError(prs.error, 'Could not read your pull requests from GitHub')}{prs.data ? ' · showing the last answer' : ''}
        </div>
      )}
      {actionError && <div className="m-banner" data-connection="offline" role="alert" onClick={() => setActionError('')}>{actionError} · tap to dismiss</div>}
      {!notConnected && lanes.length > 0 && (
        <nav className="m-segments" role="tablist" aria-label="PR lanes">
          {PHONE_LANE_ORDER.map(id => {
            const n = live.find(l => l.id === id)?.rows.length ?? 0;
            return (
              <button
                key={id}
                ref={selected === id ? activeTab : undefined}
                role="tab"
                aria-selected={selected === id}
                className={`m-segment ${selected === id ? 'active' : ''}`}
                data-lane={id}
                data-act={(ACTIONABLE.includes(id) && n > 0) || undefined}
                onClick={() => pick(id)}
              >
                <span className="m-segment-label">{laneTabLabel(id, prs.data)}</span>
                <span className="m-segment-count" data-zero={n === 0 || undefined}>{n}</span>
              </button>
            );
          })}
        </nav>
      )}
      <PullScroll role="tabpanel" onRefresh={prs.refresh}>
        {notConnected && (
          <div className="m-empty">Connect GitHub in <Link className="m-link" to="/settings">Settings</Link> to list your pull requests.</div>
        )}
        {stage && (
          <div className="m-form-note m-pr-note m-pr-deploy">
            {stage.text}
            {stage.runUrl && <> <a className="m-link" href={stage.runUrl} target="_blank" rel="noreferrer">Open the run</a></>}
            {stage.offerBake && !baking && <> <button type="button" className="m-link m-pr-bake" onClick={() => setConfirmBake(true)}>Bake &amp; deploy now</button></>}
            {baking && ' Bake started; it shows here within a minute.'}
          </div>
        )}
        {suggested.length > 0 && (
          <ul className="m-list">
            {suggested.map(sg => <MobileSuggestionRow key={sg.key} suggestion={sg} onOpen={setSuggestion} />)}
          </ul>
        )}
        {cards.length > 0 && (
          <ul className="m-list">
            {cards.map(g => <MobileGroupCard key={g.id} group={g} viewer={viewer} now={now} onOpen={openMember} onMenu={setMenu}
              onBareMenu={(group, member) => setBareMenu({ group, member })} onReviewAll={g => setConfirmGroupId(g.id)} />)}
          </ul>
        )}
        {!notConnected && prs.data && rows.length === 0 && cards.length === 0 && suggested.length === 0 && (
          <div className="m-empty">Nothing in {lanes.find(l => l.id === selected)?.label ?? 'this lane'}.</div>
        )}
        {rows.length > 0 && (
          <ul className="m-list">
            {rows.map(r => {
              const at = r.requestedAt ?? r.at;
              const until = deferred.get(rowParam(r));
              return (
                <li key={rowKey(r)} className="m-row-wrap">
                  <button className="m-row m-pr-row" data-lane={r.lane} data-deferred={until !== undefined || undefined} onClick={() => (hasOverview(r) ? setOverview(r) : setMenu(r))}>
                    <span className="m-glyph m-pr-glyph" data-lane={r.lane} aria-hidden>{LANE_GLYPH[r.lane]}</span>
                    <span className="m-row-main">
                      <span className="m-row-title">{r.kind === 'pr' ? r.title : r.headRefName}</span>
                      <span className="m-row-preview">
                        {rowLabel(r)} · {until !== undefined ? deferredText(until, now) : rowDetail(r, now)}
                        {groupPill(places.get(groupKey(r) ?? '')) && <span className="m-prg-pill"> · {groupPill(places.get(groupKey(r) ?? ''))}</span>}
                      </span>
                    </span>
                    <span className="m-row-side">
                      <span className="m-row-badges">
                        {r.badges.filter(b => b !== 'dirty').map(b => <span key={b} className={`m-badge ${b === 'conflict' ? 'm-badge-danger' : ''}`}>{b}</span>)}
                      </span>
                      <span className="m-row-clock">{at ? fmtAge(Math.max(0, now - Date.parse(at))) : ''}</span>
                    </span>
                  </button>
                  <button className="m-more" aria-label={`Actions for ${rowLabel(r)}`} onClick={() => setMenu(r)}>⋯</button>
                </li>
              );
            })}
          </ul>
        )}
        {prs.data?.connected && prs.data.notes.map(n => <div key={n} className="m-form-note m-pr-note">{n}</div>)}
      </PullScroll>
      {menu && (
        <ActionSheet title={`${rowLabel(menu)}${menu.kind === 'pr' ? ` · ${menu.title}` : ''}`} actions={actionsFor(menu)} onClose={closeMenu} />
      )}
      {suggestion && (
        <SuggestionSheet suggestion={suggestion} groups={openGroups(prs.data)} onClose={closeSuggestion} onChanged={prs.refresh} onError={setActionError} />
      )}
      {bareMenu && (
        <ActionSheet title={`${memberLabel(bareMenu.member)} · ${bareMenu.member.title || 'not read from GitHub'}`} onClose={closeBareMenu} actions={[
          { label: 'Open on GitHub', onClick: () => { window.open(bareMenu.member.url, '_blank', 'noopener'); } },
          { label: `Take it out of ${bareMenu.group.name}`, danger: true, onClick: () => { void takeOut(bareMenu.group, bareMenu.member); } },
        ]} />
      )}
      {addTo && (
        <AddToGroupSheet row={addTo} groups={openGroups(prs.data)} onClose={closeAddTo} onChanged={prs.refresh} onError={setActionError} />
      )}
      {confirmGroup && confirmPlan && 'members' in confirmPlan && (
        <ConfirmSheet
          message={<>Start one Devin review of the {confirmPlan.members.length} PR{confirmPlan.members.length === 1 ? '' : 's'} left in <strong>{confirmGroup.name}</strong> ({confirmPlan.members.map(memberLabel).join(', ')}), in order, in <strong>{wsLabel(confirmPlan.target)}</strong>? It reviews each, then what spans them. A review already running there is replaced.</>}
          confirmLabel="Start review"
          onConfirm={() => { void startGroupReview(confirmGroup); }}
          onClose={closeConfirmGroup}
        />
      )}
      {overview && <PrOverviewDialog row={overview} now={now} layout="sheet" onClose={closeOverview} onChanged={prs.refresh} />}
      {confirmBake && (
        <ConfirmSheet
          message={<>Bake <strong>main</strong> into an orchestrator image and deploy it? About 20 minutes to bake, then an instance refresh moves every termag user to a new host. It ships everything merged to main, not only your pull requests.</>}
          confirmLabel="Bake & deploy"
          onConfirm={() => { void startBake(); }}
          onClose={() => setConfirmBake(false)}
        />
      )}
      {confirm?.reviewTarget && (
        <ConfirmSheet
          message={<>Start a Devin review of <strong>{rowLabel(confirm)}</strong> in <strong>{wsLabel(confirm.reviewTarget)}</strong>? A review already running there is replaced.</>}
          confirmLabel="Start review"
          onConfirm={() => { void startReview(confirm); }}
          onClose={closeConfirm}
        />
      )}
    </div>
  );
}
