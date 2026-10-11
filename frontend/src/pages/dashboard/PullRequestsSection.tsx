import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { reviewApi, type PrLaneId, type PrPipelineResponse, type PrRow } from '../../services/api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { fmtAge } from '../../utils/format';
import { ACTIONABLE, LANE_SHORT, rowDetail, rowKey, rowLabel } from '../../utils/prPipeline';
import { projectHref } from './AttentionSection';

/**
 * "Pull requests" on the dashboard: the lanes as a strip
 * of counts read left to right, the selected lane's rows below. Read-only:
 * Open on GitHub, Open workstream, and for review requests Review with Devin,
 * which starts the #205 review pane in the PR's workstream (or the main
 * workstream of a project on the PR's repo) and opens it. With no GitHub token
 * the section is one line pointing at Settings.
 */
const SHOW = 12;

function apiErrorText(err: unknown): string {
  const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return typeof msg === 'string' ? msg : 'Could not read your pull requests from GitHub.';
}

function Row({ r, now, onReview }: { r: PrRow; now: number; onReview: (r: PrRow) => void }) {
  const label = rowLabel(r);
  const at = r.requestedAt ?? r.at;
  return (
    <div className={`prs-row prs-row--${r.lane}`}>
      <span className="prs-label">
        {r.url ? <a href={r.url} target="_blank" rel="noreferrer" title="Open on GitHub">{label}</a> : label}
      </span>
      <span className="prs-body">
        <span className="prs-title">
          {r.kind === 'pr' ? r.title : 'no pull request yet'}
          {r.badges.filter(b => b !== 'dirty').map(b => <span key={b} className={`prs-badge prs-badge--${b}`}>{b}</span>)}
        </span>
        <span className="prs-detail">{rowDetail(r, now)}</span>
      </span>
      <span className="prs-actions">
        {r.workstream && (
          <Link className="prs-ws" to={projectHref(r.workstream.projectId, r.workstream.workstream)} title="Open workstream">
            {r.workstream.projectName}{r.workstream.workstream !== 'main' ? ` · ${r.workstream.workstream}` : ''}
          </Link>
        )}
        {r.lane === 'needs_my_review' && r.reviewTarget && (
          <button type="button" className="btn-ghost btn-tiny prs-review" onClick={() => onReview(r)}>Review with Devin</button>
        )}
        {at && <span className="usage-dim" title={new Date(at).toLocaleString()}>{fmtAge(Math.max(0, now - Date.parse(at)))}</span>}
      </span>
    </div>
  );
}

export function PullRequestsSection({ prs, error, now }: { prs: PrPipelineResponse | null; error: unknown; now: number }) {
  const navigate = useNavigate();
  const [picked, setPicked] = useState<PrLaneId | null>(null);
  const [all, setAll] = useState(false);
  const [confirm, setConfirm] = useState<PrRow | null>(null);
  const [reviewError, setReviewError] = useState('');

  if (prs && !prs.connected) {
    return (
      <section className="dash-section" aria-labelledby="prs-h">
        <div className="dash-section-title" id="prs-h"><span>Pull requests</span></div>
        <div className="usage-dim prs-note"><Link to="/settings">Connect GitHub in Settings</Link> to see where your pull requests stand.</div>
      </section>
    );
  }

  const lanes = prs?.lanes ?? [];
  // Open on what can be acted on, else the first lane with anything in it.
  const fallback = lanes.find(l => ACTIONABLE.includes(l.id) && l.rows.length)?.id ?? lanes.find(l => l.rows.length)?.id ?? 'checks';
  const selected = picked ?? fallback;
  const lane = lanes.find(l => l.id === selected);
  const rows = lane?.rows ?? [];
  const visible = all ? rows : rows.slice(0, SHOW);

  const startReview = async (r: PrRow) => {
    const t = r.reviewTarget;
    if (!t || r.number == null) return;
    setReviewError('');
    try {
      await reviewApi.start(t.projectId, { workstream: t.workstream, pr: r.number, url: r.url });
      navigate(projectHref(t.projectId, t.workstream));
    } catch (err) {
      setReviewError(apiErrorText(err));
    }
  };

  return (
    <section className="dash-section" id="prs" aria-labelledby="prs-h">
      <div className="dash-section-title" id="prs-h">
        <span>Pull requests</span>
        <span className="usage-dim">
          {prs ? `as ${prs.viewer} · ${fmtAge(Math.max(0, now - Date.parse(prs.fetchedAt)))} ago` : error ? '' : 'loading…'}
        </span>
      </div>
      {error != null ? <div className="error-text">{apiErrorText(error)}{prs ? ' Showing the last answer.' : ''}</div> : null}
      {prs && (
        <>
          <div className="prs-strip" role="tablist" aria-label="PR lanes">
            {lanes.map(l => (
              <button
                key={l.id}
                type="button"
                role="tab"
                aria-selected={l.id === selected}
                className={`prs-lane ${l.id === selected ? 'active' : ''} ${ACTIONABLE.includes(l.id) && l.rows.length ? 'prs-lane--act' : ''}`}
                title={l.label}
                onClick={() => { setPicked(l.id); setAll(false); }}
              >
                <span className="prs-lane-count" data-zero={l.rows.length === 0 || undefined}>{l.rows.length}</span>
                <span className="prs-lane-label">{LANE_SHORT[l.id]}</span>
              </button>
            ))}
          </div>
          {reviewError && <div className="error-text" role="alert">{reviewError}</div>}
          {rows.length === 0
            ? <div className="usage-dim prs-note">Nothing in {lane?.label ?? 'this lane'}.</div>
            : <div className="prs-list">{visible.map(r => <Row key={rowKey(r)} r={r} now={now} onReview={setConfirm} />)}</div>}
          <div className="attn-foot">
            {rows.length > SHOW && (
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setAll(a => !a)}>
                {all ? 'show fewer' : `+${rows.length - SHOW} more`}
              </button>
            )}
            {prs.notes.map(n => <span key={n} className="usage-dim">{n}</span>)}
          </div>
        </>
      )}
      {confirm?.reviewTarget && (
        <ConfirmDialog
          message={<>Start a Devin review of <strong>{rowLabel(confirm)}</strong> in{' '}
            <strong>{confirm.reviewTarget.projectName}{confirm.reviewTarget.workstream !== 'main' ? ` · ${confirm.reviewTarget.workstream}` : ''}</strong>?
            {' '}A review already running there is replaced.</>}
          onConfirm={() => { const r = confirm; setConfirm(null); void startReview(r); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </section>
  );
}
