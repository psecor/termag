import React, { useEffect, useState } from 'react';
import { prsApi, type PrMergeMethod, type PrMergeRequest, type PrOverview, type PrRerunResult, type PrReviewEvent, type PrRow } from '../../services/api';
import { Dialog } from '../../components/Dialog';
import { fmtAge } from '../../utils/format';
import { MERGE_METHOD_LABEL, REVIEW_EVENTS, canSubmitReview, checksSummary, mergeReadiness, pingText, reviewStateLabel, reviewerRoster, rowLabel } from '../../utils/prPipeline';

/**
 * A pull request up close (PrDetail), in the PR overlay's detail pane or the
 * phone's sheet (PrOverviewDialog): what it is (title,
 * author, branches, size, checks, who has reviewed it, the description and
 * the files), Open on GitHub, and, when the viewer may review it, a review
 * form that submits on GitHub as them (POST /api/prs/:owner/:repo/:n/review);
 * on the viewer's own PR, a merge panel instead (POST …/merge): merge now,
 * confirmed in a second click and pinned to the head commit shown, or turn
 * auto-merge on or off. When the head commit has failed checks, a checks
 * panel re-runs the failed GitHub Actions jobs (POST …/rerun-failed). On the
 * viewer's own PR a reviewers panel re-requests reviews (POST …/reviewers) and
 * posts a ping comment the user has read and can edit (POST …/comment).
 * The description is shown as its raw text: termag renders no GitHub HTML.
 */

function apiErrorText(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return typeof msg === 'string' ? msg : fallback;
}

function ago(at: string | null | undefined, now: number): string {
  if (!at) return '';
  const t = Date.parse(at);
  return Number.isFinite(t) ? `${fmtAge(Math.max(0, now - t))} ago` : '';
}

const CHANGE_GLYPH: Record<string, string> = { ADDED: 'A', DELETED: 'D', RENAMED: 'R', COPIED: 'C', CHANGED: 'M', MODIFIED: 'M' };

function ReviewForm({ pr, onSubmitted }: { pr: PrOverview; onSubmitted: (event: PrReviewEvent) => void }) {
  const [event, setEvent] = useState<PrReviewEvent>('COMMENT');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ok = canSubmitReview(event, body) && !busy;

  const submit = async () => {
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      await prsApi.review(pr.repo, pr.number, event, body);
      onSubmitted(event);
    } catch (err) {
      setError(apiErrorText(err, 'GitHub did not take the review.'));
      setBusy(false);
    }
  };

  if (pr.viewerReview?.state === 'PENDING') {
    return <div className="usage-dim pro-note">You have a pending review draft on GitHub. Finish it there: GitHub allows one pending review per PR.</div>;
  }
  return (
    <div className="pro-review">
      <textarea
        className="pro-review-body"
        placeholder={event === 'APPROVE' ? 'Optional note with the approval' : event === 'COMMENT' ? 'Your comment' : 'What needs to change'}
        value={body}
        rows={5}
        disabled={busy}
        onChange={e => setBody(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
      />
      <div className="pro-review-bar">
        <div className="pro-events" role="radiogroup" aria-label="Review type">
          {REVIEW_EVENTS.map(ev => (
            <button
              key={ev.id}
              type="button"
              role="radio"
              aria-checked={event === ev.id}
              className={`pro-event pro-event--${ev.id} ${event === ev.id ? 'active' : ''}`}
              disabled={busy}
              onClick={() => setEvent(ev.id)}
            >{ev.label}</button>
          ))}
        </div>
        <button type="button" className="btn-primary pro-submit" disabled={!ok} onClick={() => void submit()} title="Ctrl/⌘+Enter">
          {busy ? 'Submitting…' : 'Submit review'}
        </button>
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
    </div>
  );
}

function rerunText(r: PrRerunResult): string {
  const parts: string[] = [];
  if (r.rerun.length) parts.push(`Re-running ${r.rerun.map(x => x.workflow).join(', ')}.`);
  if (r.refused.length) parts.push(`GitHub refused ${r.refused.map(x => `${x.workflow} (${x.error})`).join(', ')}.`);
  return parts.join(' ');
}

function ChecksPanel({ pr, onDone }: { pr: PrOverview; onDone: () => void }) {
  const { runs, other } = pr.failedSuites;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PrRerunResult | null>(null);
  const [error, setError] = useState('');

  const rerun = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await prsApi.rerunFailed(pr.repo, pr.number);
      setResult(r);
      onDone();
    } catch (err) {
      setError(apiErrorText(err, 'GitHub did not re-run the checks.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pro-merge pro-checks-panel">
      {runs.length > 0 && (
        <div className="pro-merge-bar">
          <span className="pro-merge-confirm">Failed GitHub Actions: {runs.map(r => r.workflow).join(', ')}</span>
          {result
            ? <span className="pro-done" role="status">{rerunText(result)}</span>
            : <button type="button" className="btn-primary pro-submit" disabled={busy} onClick={() => void rerun()}>{busy ? 'Re-running…' : 'Re-run failed jobs'}</button>}
        </div>
      )}
      {other.length > 0 && (
        <div className="usage-dim pro-note">
          Also failing: {other.join(', ')}. Not GitHub Actions, so termag cannot restart {other.length === 1 ? 'it' : 'them'};{' '}
          {pr.url ? <a href={`${pr.url}/checks`} target="_blank" rel="noreferrer">re-run on GitHub</a> : 're-run on GitHub'}.
        </div>
      )}
      {error && <div className="error-text" role="alert">{error}</div>}
    </div>
  );
}

const LOGIN_INPUT = /^@?[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

function ReviewersPanel({ pr, onChanged }: { pr: PrOverview; onChanged: () => void }) {
  const roster = reviewerRoster(pr);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(roster.filter(e => e.pick).map(e => e.name)));
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState<'request' | 'ping' | null>(null);
  const [error, setError] = useState('');
  const [requested, setRequested] = useState<string[] | null>(null);
  const [ping, setPing] = useState<string | null>(null);
  const [pinged, setPinged] = useState<string | null | undefined>(undefined);

  const extraNames = extra.split(/[\s,]+/).filter(Boolean);
  const extraOk = extraNames.every(n => LOGIN_INPUT.test(n));
  const users = [...new Set([...roster.filter(e => e.kind === 'user' && picked.has(e.name)).map(e => e.name), ...extraNames.map(n => n.replace(/^@/, ''))])];
  const toggle = (name: string) => setPicked(p => { const n = new Set(p); if (n.has(name)) n.delete(name); else n.add(name); return n; });

  const request = async () => {
    setBusy('request');
    setError('');
    try {
      // GitHub answers with everyone now requested; say who this click asked.
      await prsApi.requestReviewers(pr.repo, pr.number, users, []);
      setRequested(users);
      setExtra('');
      onChanged();
    } catch (err) {
      setError(apiErrorText(err, 'GitHub did not take the review request.'));
    } finally {
      setBusy(null);
    }
  };

  const post = async () => {
    if (!ping?.trim()) return;
    setBusy('ping');
    setError('');
    try {
      const r = await prsApi.comment(pr.repo, pr.number, ping);
      setPinged(r.url);
      setPing(null);
    } catch (err) {
      setError(apiErrorText(err, 'GitHub did not take the comment.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pro-merge pro-reviewers">
      <div className="pro-merge-confirm">Reviewers</div>
      {roster.length === 0 && <div className="usage-dim pro-note">Nobody has been asked yet.</div>}
      <ul className="pro-roster">
        {roster.map(e => (
          <li key={`${e.kind}:${e.name}`}>
            <label title={e.pending ? 'Already asked and not answered: GitHub would not notify them again. Ping them in a comment.' : undefined}>
              <input type="checkbox" disabled={e.pending || e.kind === 'team' || !!busy} checked={!e.pending && picked.has(e.name)} onChange={() => toggle(e.name)} />
              <span className={`pro-reviewer pro-reviewer--${e.state.toLowerCase()}`}>{e.kind === 'team' ? `team ${e.name}` : e.name}</span>
              <span className="usage-dim">{e.pending ? 'asked, not answered' : reviewStateLabel(e.state)}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="pro-merge-bar">
        <input className="pro-add-reviewer" placeholder="add reviewers: login, login" value={extra} disabled={!!busy} onChange={e => setExtra(e.target.value)} aria-label="Add reviewers" />
        <button type="button" className="btn-primary pro-submit" disabled={!!busy || users.length === 0 || !extraOk} onClick={() => void request()}>
          {busy === 'request' ? 'Requesting…' : 'Re-request review'}
        </button>
        {ping === null && pinged === undefined && (
          <button type="button" className="btn-ghost pro-gh" disabled={!!busy} onClick={() => setPing(pingText(roster, picked, pr.repo))}>Ping in a comment…</button>
        )}
      </div>
      {!extraOk && <div className="error-text">Not a GitHub login: {extraNames.filter(n => !LOGIN_INPUT.test(n)).join(', ')}</div>}
      {requested && <div className="pro-done" role="status">Review requested from {requested.join(', ')}; GitHub notifies {requested.length === 1 ? 'them' : 'each'}.</div>}
      {ping !== null && (
        <div className="pro-review">
          <textarea className="pro-review-body" rows={3} value={ping} disabled={!!busy} autoFocus onChange={e => setPing(e.target.value)}
            placeholder="@reviewer …" aria-label="Ping comment" />
          <div className="pro-merge-bar">
            <button type="button" className="btn-primary pro-submit" disabled={!!busy || !ping.trim()} onClick={() => void post()}>
              {busy === 'ping' ? 'Posting…' : 'Post comment'}
            </button>
            <button type="button" className="confirm-btn confirm-btn-cancel" disabled={!!busy} onClick={() => setPing(null)}>Cancel</button>
            <span className="usage-dim">Posted on the PR as you.</span>
          </div>
        </div>
      )}
      {pinged !== undefined && (
        <div className="pro-done" role="status">Comment posted. {pinged && <a href={pinged} target="_blank" rel="noreferrer">Open it</a>}</div>
      )}
      {error && <div className="error-text" role="alert">{error}</div>}
    </div>
  );
}

type MergeDone = { kind: 'merged'; sha: string | null } | { kind: 'auto_on'; method: PrMergeMethod } | { kind: 'auto_off' };

function MergePanel({ pr, onDone }: { pr: PrOverview; onDone: (d: MergeDone) => void }) {
  const { methods, defaultMethod } = pr.mergeSettings;
  const [method, setMethod] = useState<PrMergeMethod | null>(pr.autoMergeMethod ?? defaultMethod);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ready = mergeReadiness(pr);

  const run = async (req: PrMergeRequest, done: MergeDone) => {
    setBusy(true);
    setError('');
    try {
      await prsApi.merge(pr.repo, pr.number, req);
      onDone(done);
    } catch (err) {
      setError(apiErrorText(err, 'GitHub did not take that.'));
      setBusy(false);
      setArmed(false);
    }
  };

  return (
    <div className="pro-merge">
      <div className="pro-merge-status">
        {pr.autoMerge
          ? <span className="pro-checks pro-checks--good">auto-merge on{pr.autoMergeMethod ? ` (${MERGE_METHOD_LABEL[pr.autoMergeMethod].toLowerCase()})` : ''}</span>
          : ready.canMergeNow && !ready.note ? <span className="pro-checks pro-checks--good">ready to merge</span> : null}
        {ready.note && <span className="usage-dim">{ready.note}</span>}
      </div>
      {methods.length > 1 && (
        <div className="pro-events" role="radiogroup" aria-label="Merge method">
          {methods.map(m => (
            <button key={m} type="button" role="radio" aria-checked={method === m} disabled={busy || armed}
              className={`pro-event ${method === m ? 'active' : ''}`} onClick={() => setMethod(m)}>{MERGE_METHOD_LABEL[m]}</button>
          ))}
        </div>
      )}
      <div className="pro-merge-bar">
        {armed && method && pr.headSha ? (
          <>
            <span className="pro-merge-confirm">{MERGE_METHOD_LABEL[method]} into <code>{pr.baseRefName}</code> at <code>{pr.headSha.slice(0, 7)}</code>?</span>
            <button type="button" className="btn-primary pro-submit pro-merge-go" disabled={busy} autoFocus
              onClick={() => void run({ mode: 'now', method, sha: pr.headSha! }, { kind: 'merged', sha: null })}>{busy ? 'Merging…' : 'Confirm merge'}</button>
            <button type="button" className="confirm-btn confirm-btn-cancel" disabled={busy} onClick={() => setArmed(false)}>Cancel</button>
          </>
        ) : (
          <>
            {ready.canMergeNow && method && pr.headSha && (
              <button type="button" className="btn-primary pro-submit" disabled={busy} onClick={() => setArmed(true)}>{MERGE_METHOD_LABEL[method]}…</button>
            )}
            {ready.canEnableAuto && method && (
              <button type="button" className="btn-ghost pro-gh" disabled={busy}
                onClick={() => void run({ mode: 'auto', method }, { kind: 'auto_on', method })}>{busy ? 'Working…' : 'Enable auto-merge'}</button>
            )}
            {pr.autoMerge && (
              <button type="button" className="btn-ghost pro-gh" disabled={busy}
                onClick={() => void run({ mode: 'cancel_auto' }, { kind: 'auto_off' })}>{busy ? 'Working…' : 'Disable auto-merge'}</button>
            )}
          </>
        )}
      </div>
      {error && <div className="error-text" role="alert">{error}</div>}
    </div>
  );
}

function mergeDoneText(d: MergeDone): string {
  if (d.kind === 'merged') return 'Merged on GitHub.';
  if (d.kind === 'auto_on') return `Auto-merge on (${MERGE_METHOD_LABEL[d.method].toLowerCase()}): GitHub merges it once it can.`;
  return 'Auto-merge off.';
}

/**
 * The body of a PR up close, without a frame: title, meta, description, files,
 * and the panels that act on it. The dialog below wraps it for the phone; the
 * PR overlay (PrsOverlay) shows it in its detail pane. Give it a `key` per PR:
 * its state (a submitted review, a merge) belongs to one PR.
 */
export function PrDetail({ row, now, onChanged, footer }: {
  row: PrRow;
  now: number;
  /** After a review or merge action lands: the caller refreshes the lanes. */
  onChanged: () => void;
  /** Extra buttons beside the GitHub links (the dialog's Close). */
  footer?: React.ReactNode;
}) {
  const [pr, setPr] = useState<PrOverview | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<PrReviewEvent | null>(null);
  const [merged, setMerged] = useState<MergeDone | null>(null);

  useEffect(() => {
    if (!row.repo || row.number == null) return;
    let live = true;
    prsApi.overview(row.repo, row.number)
      .then(p => { if (live) setPr(p); })
      .catch(err => { if (live) setError(apiErrorText(err, 'Could not read the pull request from GitHub.')); });
    return () => { live = false; };
  }, [row.repo, row.number]);

  const url = pr?.url ?? row.url;
  const checks = pr ? checksSummary(pr.checks) : null;

  return (
    <>
      <div className="pro-title" id="pro-title">
        {url ? <a href={url} target="_blank" rel="noreferrer" title="Open on GitHub">{pr?.title ?? row.title}</a> : (pr?.title ?? row.title)}
        {pr?.isDraft && <span className="prs-badge">draft</span>}
        {pr && pr.state !== 'OPEN' && <span className="prs-badge">{pr.state.toLowerCase()}</span>}
      </div>

      {error && <div className="error-text" role="alert">{error}</div>}
      {!pr && !error && <div className="usage-dim pro-note">Reading from GitHub…</div>}

      {pr && (
        <>
          <div className="pro-meta">
            <span>by <strong>{pr.author ?? 'someone'}</strong>{pr.createdAt ? `, opened ${ago(pr.createdAt, now)}` : ''}</span>
            <span className="pro-branches"><code>{pr.headRefName}</code> → <code>{pr.baseRefName}</code></span>
            <span><span className="pro-add">+{pr.additions}</span> <span className="pro-del">−{pr.deletions}</span> in {pr.changedFiles} file{pr.changedFiles === 1 ? '' : 's'}</span>
          </div>
          <div className="pro-meta">
            {checks && <span className={`pro-checks pro-checks--${checks.tone}`}>{checks.text}</span>}
            {pr.mergeable === 'CONFLICTING' && <span className="pro-checks pro-checks--bad">merge conflict</span>}
            {pr.reviews.length === 0
              ? <span className="usage-dim">no reviews yet</span>
              : pr.reviews.map(r => (
                <span key={`${r.author}-${r.submittedAt}`} className={`pro-reviewer pro-reviewer--${r.state.toLowerCase()}`} title={r.submittedAt ? new Date(r.submittedAt).toLocaleString() : undefined}>
                  {r.author ?? 'someone'} {reviewStateLabel(r.state)}
                </span>
              ))}
            {pr.requestedReviewers.length > 0 && <span className="usage-dim">waiting on {pr.requestedReviewers.join(', ')}</span>}
          </div>

          <div className="pro-body">{pr.body.trim() ? pr.body : <span className="usage-dim">No description.</span>}</div>

          <details className="pro-files">
            <summary>Files ({pr.changedFiles})</summary>
            <ul>
              {pr.files.map(f => (
                <li key={f.path}>
                  <span className="pro-file-kind">{CHANGE_GLYPH[f.changeType] ?? 'M'}</span>
                  <span className="pro-file-path">{f.path}</span>
                  <span className="pro-add">+{f.additions}</span> <span className="pro-del">−{f.deletions}</span>
                </li>
              ))}
              {pr.filesTruncated && <li className="usage-dim">…and more; see GitHub.</li>}
            </ul>
          </details>

          {pr.state === 'OPEN' && (pr.failedSuites.runs.length > 0 || pr.failedSuites.other.length > 0) && (
            <ChecksPanel pr={pr} onDone={onChanged} />
          )}

          {done ? (
            <div className="pro-done" role="status">
              {REVIEW_EVENTS.find(e => e.id === done)?.done} on GitHub.{' '}
              {url && <a href={url} target="_blank" rel="noreferrer">Open the PR</a>}
            </div>
          ) : pr.viewerCanReview ? (
            <>
              {pr.viewerReview && <div className="usage-dim pro-note">You {reviewStateLabel(pr.viewerReview.state)} {ago(pr.viewerReview.submittedAt, now)}.</div>}
              <ReviewForm pr={pr} onSubmitted={ev => { setDone(ev); onChanged(); }} />
            </>
          ) : merged ? (
            <div className="pro-done" role="status">{mergeDoneText(merged)}</div>
          ) : pr.viewerCanMerge ? (
            <MergePanel pr={pr} onDone={d => { setMerged(d); onChanged(); }} />
          ) : null}

          {/* Only a merge ends the review: an auto-merge toggle is exactly when a ping is still due. */}
          {pr.viewerCanMerge && merged?.kind !== 'merged' && <ReviewersPanel pr={pr} onChanged={onChanged} />}
        </>
      )}

      <div className="confirm-actions pro-actions">
        {url && <a className="btn-ghost pro-gh" href={url} target="_blank" rel="noreferrer">Open on GitHub ↗</a>}
        {url && pr && <a className="btn-ghost pro-gh" href={`${url}/files`} target="_blank" rel="noreferrer">Files on GitHub ↗</a>}
        {footer}
      </div>
    </>
  );
}

/** PrDetail in a modal: the phone's full-screen sheet on /m/prs. */
export function PrOverviewDialog({ row, now, onClose, onChanged, layout = 'dialog' }: {
  row: PrRow;
  now: number;
  onClose: () => void;
  /** After a review or merge action lands: the caller refreshes the lanes. */
  onChanged: () => void;
  /** `sheet`: full screen, for the phone's /m/prs. */
  layout?: 'dialog' | 'sheet';
}) {
  return (
    <Dialog labelledBy="pro-title" className={`pro-dialog${layout === 'sheet' ? ' pro-dialog--sheet' : ''}`} onClose={onClose}>
      <div className="pro-head">
        <span className="pro-label">{rowLabel(row)}</span>
        <button type="button" className="btn-ghost btn-tiny pro-close" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <PrDetail row={row} now={now} onChanged={onChanged}
        footer={<button type="button" className="confirm-btn confirm-btn-cancel" onClick={onClose}>Close</button>} />
    </Dialog>
  );
}
