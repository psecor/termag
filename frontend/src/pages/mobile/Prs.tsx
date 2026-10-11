// The phone's PR screen: the pipeline's lanes as the
// inbox's segmented tabs, ordered by what can be done from a phone, opening on
// the first non-empty one. A row opens an action sheet: Open on GitHub, Open
// conversation (the linked workstream), and for review requests Review with
// Devin, which starts the review pane and lands on its tab.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { prsApi, reviewApi, type PrLaneId, type PrRow, type PrWorkstreamLink } from '../../services/api';
import { usePolled } from '../dashboard/useDashboardData';
import { fmtAge } from '../../utils/format';
import { ACTIONABLE, LANE_SHORT, PHONE_LANE_ORDER, firstNonEmpty, lanesOf, rowDetail, rowKey, rowLabel } from '../../utils/prPipeline';
import { ActionSheet, ConfirmSheet, apiError, type SheetAction } from './Sheet';

// Geometric Shapes only: phone fonts lack the rarer symbols (⧗ drew as tofu).
const LANE_GLYPH: Record<PrLaneId, string> = {
  in_progress: '◇', needs_pr: '△', checks: '◌', needs_approval: '○', needs_my_review: '◉',
  ready_to_merge: '✓', merged_not_deployed: '▷', deployed: '●', merged: '●',
};

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
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeConfirm = useCallback(() => setConfirm(null), []);
  const now = Date.now();

  const lanes = lanesOf(prs.data);
  const fromUrl = params.get('lane');
  const selected: PrLaneId = isLane(fromUrl) ? fromUrl : firstNonEmpty(lanes, PHONE_LANE_ORDER);
  const pick = (id: PrLaneId) => {
    const next = new URLSearchParams(params);
    next.set('lane', id);
    setParams(next, { replace: true });
  };
  const rows = lanes.find(l => l.id === selected)?.rows ?? [];
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

  const actionsFor = (r: PrRow): SheetAction[] => {
    const out: SheetAction[] = [];
    if (r.url) out.push({ label: 'Open on GitHub', onClick: () => { window.open(r.url!, '_blank', 'noopener'); } });
    if (r.workstream) out.push({ label: `Open conversation · ${wsLabel(r.workstream)}`, onClick: () => navigate(conversationHref(r.workstream!)) });
    if (r.lane === 'needs_my_review' && r.reviewTarget) out.push({ label: 'Review with Devin…', onClick: () => setConfirm(r) });
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
            const n = lanes.find(l => l.id === id)?.rows.length ?? 0;
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
                <span className="m-segment-label">{LANE_SHORT[id]}</span>
                <span className="m-segment-count" data-zero={n === 0 || undefined}>{n}</span>
              </button>
            );
          })}
        </nav>
      )}
      <main className="m-scroll" role="tabpanel">
        {notConnected && (
          <div className="m-empty">Connect GitHub in <Link className="m-link" to="/settings">Settings</Link> to see your pull requests.</div>
        )}
        {!notConnected && prs.data && rows.length === 0 && (
          <div className="m-empty">Nothing in {lanes.find(l => l.id === selected)?.label ?? 'this lane'}.</div>
        )}
        {rows.length > 0 && (
          <ul className="m-list">
            {rows.map(r => {
              const at = r.requestedAt ?? r.at;
              return (
                <li key={rowKey(r)} className="m-row-wrap">
                  <button className="m-row m-pr-row" data-lane={r.lane} onClick={() => setMenu(r)}>
                    <span className="m-glyph m-pr-glyph" data-lane={r.lane} aria-hidden>{LANE_GLYPH[r.lane]}</span>
                    <span className="m-row-main">
                      <span className="m-row-title">{r.kind === 'pr' ? r.title : r.headRefName}</span>
                      <span className="m-row-preview">{rowLabel(r)} · {rowDetail(r, now)}</span>
                    </span>
                    <span className="m-row-side">
                      <span className="m-row-badges">
                        {r.badges.filter(b => b !== 'dirty').map(b => <span key={b} className={`m-badge ${b === 'conflict' ? 'm-badge-danger' : ''}`}>{b}</span>)}
                      </span>
                      <span className="m-row-clock">{at ? fmtAge(Math.max(0, now - Date.parse(at))) : ''}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {prs.data?.connected && prs.data.notes.map(n => <div key={n} className="m-form-note m-pr-note">{n}</div>)}
      </main>
      {menu && (
        <ActionSheet title={`${rowLabel(menu)}${menu.kind === 'pr' ? ` · ${menu.title}` : ''}`} actions={actionsFor(menu)} onClose={closeMenu} />
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
