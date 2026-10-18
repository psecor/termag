// One session as a chat: the agent pane captured and
// parsed into turns, a key bar for the things a CLI wants pressed, and a
// native composer that types into the pane through send-keys.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useProjects } from '../../contexts/ProjectContext';
import { activityApi, projectsApi, reviewApi, sessionsApi, visitsApi, workstreamsApi } from '../../services/api';
import { PROVIDERS } from '../../providers/registry';
import { sessionName } from '../../utils/sessionName';
import { statusKey } from '../../utils/statusKey';
import { contextLevel } from '../../utils/thresholds';
import { parsePane } from '../../chat/paneChat';
import { BlockView, DraftView, firstTurnIndex } from '../../chat/Blocks';
import { flattenForSend, MAX_KEYS, sendErrorText } from '../../chat/compose';
import { useFollowBottom } from '../../chat/useFollowBottom';
import { quickKeys, QuickKey } from '../../chat/quickKeys';
import { paneKey, useCapture } from '../../chat/useCapture';
import { providerFor, STATUS_GLYPH, waitingLabel } from '../../mobile/inbox';
import { useReview } from '../../mobile/useReview';
import { PaneRole, reviewKeyLabel, reviewPollStatus, reviewStopCopy, reviewTabLabel, roleFromParam } from '../../mobile/review';
import { reviewStateLabel, reviewStateText } from '../../utils/review';
import { ringStateFor } from '../../utils/reviewRing';
import { writeOptOut } from '../../mobile/redirect';
import { ActionSheet, ConfirmSheet, Sheet, apiError } from './Sheet';
import { HeaderPrPills } from './HeaderPrPills';
import { ReviewSheet } from './ReviewSheet';
import { HandoffSheet } from './HandoffSheet';
import { FLAGS, useFlag } from '../../flags';
import { canHandOff, handoffStateLabel, showHandoffStrip } from '../../utils/handoff';

// Remembered across conversations in this tab so visits carry a previous id,
// like the desktop's project switcher does.
let lastVisitedProjectId: string | null = null;

export function Conversation() {
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { projects, statusMap, reloadProjects } = useProjects();

  const ws = params.get('ws') || 'main';
  const role: PaneRole = roleFromParam(params.get('role'));
  const project = projects.find(p => p.id === projectId);
  const owner = project?.ownerUsername ?? user?.unixUsername ?? '';
  const workstream = project?.workstreams.find(w => w.name === ws);
  const agentSession = project ? sessionName(owner, project.name, 'agent', ws) : '';
  const reviewPaneSession = project ? sessionName(owner, project.name, 'review', ws) : '';
  const status = project ? statusMap[statusKey(project.instanceId, agentSession)] : undefined;
  // The provider actually running in the pane (from its status source), else the configured one.
  const provider = project ? providerFor(project, workstream?.id, status?.source) : null;
  const hasAgent = Boolean(project?.workflows.some(w => w.type === 'agent'));
  // The Devin review pane (the desktop's Review button + dock), derived from
  // the status channel. Its tab exists while a pane is
  // alive per the backend's review sweep.
  const review = useReview({
    projectId: project?.id ?? null,
    instanceId: project?.instanceId,
    workstream: ws,
    agentSession: agentSession || undefined,
    reviewSession: reviewPaneSession || undefined,
    enabled: Boolean(project && hasAgent),
  });
  const reviewAlive = Boolean(review.status?.alive);
  const reviewDock = reviewStateLabel({ alive: reviewAlive, state: review.status?.state ?? null });
  const reviewKey = reviewKeyLabel(reviewDock);
  const stopCopy = reviewStopCopy(reviewDock);
  // The ctrl shell exists for every project; the agent pane needs an agent
  // workflow; the review pane needs a running review.
  const paneAvailable = role === 'ctrl' || (role === 'review' ? reviewAlive : hasAgent);

  const capture = useCapture({
    projectId: project?.id ?? null,
    role,
    workstream: ws,
    status: role === 'review' ? reviewPollStatus(review.status) : status?.status,
    statusUpdatedAt: role === 'review' ? review.status?.state ?? undefined : status?.updatedAt,
    enabled: Boolean(project && paneAvailable),
  });
  // Reading a finished review on the phone is what focusing the Devin pane is
  // on the desktop (ReviewDock): post seen, so the row leaves the home list's
  // needs-you band. Only once the pane has rendered (an offline agent must
  // not clear the ring unread), and keyed on doneAt so a follow-up done
  // rings again.
  const reviewRing = ringStateFor(status?.review);
  const reviewDoneAt = status?.review?.doneAt ?? null;
  // capture.pane, not just content: on the render that switches tab,
  // project or workstream, content still holds the previous pane's text.
  const reviewShown = role === 'review' && project != null && capture.content != null
    && capture.pane === paneKey(project.id, 'review', ws);
  useEffect(() => {
    if (!reviewShown || reviewRing !== 'done' || !project) return;
    reviewApi.seen(project.id, ws).catch(() => {});
  }, [reviewShown, reviewRing, reviewDoneAt, project?.id, ws]);

  // The review pane always runs Devin, whatever the project's agent is.
  const paneProvider = role === 'review' ? 'devin' : provider;
  const parsed = useMemo(
    () => (capture.content != null ? parsePane(capture.content, { provider: paneProvider, role }) : null),
    [capture.content, paneProvider, role],
  );
  const agentLabel = paneProvider ? PROVIDERS[paneProvider]?.displayName ?? paneProvider : 'agent';
  const firstTurn = parsed ? firstTurnIndex(parsed.blocks) : -1;

  // Record the visit (the Recents list is shared with the desktop).
  useEffect(() => {
    if (!project) return;
    visitsApi.record({ projectId: project.id, previousProjectId: lastVisitedProjectId, workstream: ws });
    lastVisitedProjectId = project.id;
  }, [project?.id, ws]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the bottom unless the reader has scrolled up.
  const { scroller, onScroll, unseen, jumpToBottom } = useFollowBottom(parsed, `${projectId}|${ws}|${role}`);

  // Composer + key bar.
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // A draft belongs to the pane it was typed for; never carry it to another.
  useEffect(() => { setText(''); setSendError(null); }, [projectId, ws, role]);
  const offline = capture.error === 'offline';
  const send = useCallback(async (body: { keys: string; enter: boolean; literal: boolean }, clear: boolean) => {
    if (!project || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await sessionsApi.sendKeys(project.id, role, { workstream: ws, ...body });
      if (clear) setText('');
      activityApi.heartbeat(project.name, project.instanceId ?? null).catch(() => {});
      setTimeout(capture.refresh, 500);
    } catch (err) {
      setSendError(sendErrorText(err));
    } finally {
      setSending(false);
    }
  }, [project, role, ws, sending, capture.refresh]);

  const onSend = (withEnter: boolean) => {
    const keys = flattenForSend(text);
    if (!keys) return;
    void send({ keys, enter: withEnter, literal: true }, true);
  };
  const onQuick = (k: QuickKey) => { void send({ keys: k.keys, enter: k.enter, literal: k.literal }, false); };
  // Only the last block can be a live question: an answered one stays in
  // scrollback as a dialog block too, and must not keep its digit chips.
  const lastBlock = parsed?.blocks[parsed.blocks.length - 1];
  const dialogOptions = lastBlock?.kind === 'dialog' ? lastBlock.options ?? 0 : 0;
  const keys = role === 'agent' ? quickKeys(provider, status?.status, status?.waitingReason, dialogOptions)
    // The review pane is Devin: while it waits on its approval list, offer the digits.
    : role === 'review' ? quickKeys('devin', reviewPollStatus(review.status), null)
    : quickKeys(null, undefined, null);

  const setRole = (r: PaneRole) => {
    const next = new URLSearchParams(params);
    if (r === 'agent') next.delete('role'); else next.set('role', r);
    setParams(next, { replace: true });
  };
  const setWs = (name: string) => {
    const next = new URLSearchParams(params);
    if (name === 'main') next.delete('ws'); else next.set('ws', name);
    setParams(next, { replace: true });
  };

  // Header menu: branch off, pin, archive, open in full UI.
  const [menuOpen, setMenuOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [branchName, setBranchName] = useState('');
  const [baseRef, setBaseRef] = useState('');
  const [branchBusy, setBranchBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [stopReviewOpen, setStopReviewOpen] = useState(false);
  // Hand off: owner only, behind agent-handoff-enabled,
  // for an agent that can write its own handoff.
  const handoffOn = useFlag(FLAGS.agentHandoff, false);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const handoff = status?.handoff ?? null;
  useEffect(() => {
    if (!handoff) return;
    const t = setInterval(() => setNowTick(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [handoff]);
  const [actionError, setActionError] = useState('');
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeBranch = useCallback(() => { setBranchOpen(false); setActionError(''); }, []);
  const closeArchive = useCallback(() => setArchiveOpen(false), []);
  const openFull = () => {
    writeOptOut(typeof localStorage !== 'undefined' ? localStorage : null, true);
    navigate(`/?project=${encodeURIComponent(projectId)}${ws !== 'main' ? `&ws=${encodeURIComponent(ws)}` : ''}`);
  };
  const togglePin = async () => {
    if (!project) return;
    try { await projectsApi.togglePin(project.id); await reloadProjects(); }
    catch (err) { setActionError(apiError(err, 'Could not change the pin')); }
  };
  const archive = async () => {
    if (!project) return;
    try { await projectsApi.archive(project.id); await reloadProjects(); navigate('/m', { replace: true }); }
    catch (err) { setActionError(apiError(err, 'Could not archive the project')); }
  };
  // The key bar's Review button always asks for the PR, like the desktop's:
  // the sheet names the running review (if any) and starting replaces it.
  const onReviewButton = () => setReviewOpen(true);
  const onReviewStarted = (r: { pr: number; url: string | null; session: string }) => { review.markStarted(r); setRole('review'); };
  const stopReview = async () => {
    if (!project) return;
    try {
      await reviewApi.stop(project.id, ws);
      review.markStopped();
      if (role === 'review') setRole('agent');
    } catch (err) {
      setActionError(apiError(err, 'Could not stop the review'));
      review.refresh();
    }
  };
  const branchOff = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = branchName.trim();
    if (!project || !name || branchBusy) return;
    setBranchBusy(true); setActionError('');
    try {
      const created = await workstreamsApi.create(project.id, { name, ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}) });
      await reloadProjects();
      setBranchOpen(false); setBranchName(''); setBaseRef('');
      setWs(created.name);
    } catch (err) {
      setActionError(apiError(err, 'Could not branch off'));
    } finally {
      setBranchBusy(false);
    }
  };

  if (projects.length > 0 && !project) {
    return (
      <div className="m-screen">
        <header className="m-header"><Link className="m-link" to="/m">‹ Inbox</Link></header>
        <div className="m-empty">Project not found.</div>
      </div>
    );
  }

  const ctx = status?.contextTokens;
  const ctxLevel = contextLevel(ctx);
  const liveWorkstreams = project?.workstreams.filter(w => !w.archived) ?? [];

  return (
    <div className="m-screen">
      <header className="m-header m-header-conv">
        <Link className="m-link m-back" to="/m" aria-label="Back to inbox">‹</Link>
        <div className="m-conv-title">
          <span className="m-conv-name">
            {project?.name ?? '…'}
            {liveWorkstreams.length > 1 ? (
              <select className="m-ws-select" value={ws} onChange={e => setWs(e.target.value)} aria-label="Workstream">
                {liveWorkstreams.map(w => <option key={w.id} value={w.name}>{w.name}</option>)}
              </select>
            ) : ws !== 'main' ? <span className="m-ws"> · {ws}</span> : null}
          </span>
          <span className="m-conv-sub">
            <span className="m-conv-state">
              <span className="m-glyph" data-status={status?.status ?? 'not_running'}>{STATUS_GLYPH[status?.status ?? 'not_running']}</span>
              {' '}
              {role === 'review'
                ? (reviewAlive ? reviewStateText(reviewDock, review.status?.reviewer) : 'no review running')
                : status?.status === 'waiting' ? waitingLabel(status.waitingReason) : status?.status?.replace('_', ' ') ?? 'not running'}
              {parsed?.spinner && role === 'agent' && <span className="m-spinner"> · {parsed.spinner.replace(/^[✻✶✳✢·]\s*/, '')}</span>}
            </span>
            {project && <HeaderPrPills projectId={project.id} workstream={ws} milestone={status?.milestone} />}
          </span>
        </div>
        <div className="m-conv-right">
          {status?.rateLimited ? <span className="m-badge m-badge-danger" title={status.rateLimited}>RATE</span>
            : ctx != null && ctxLevel !== 'ok' ? <span className={`m-badge m-badge-${ctxLevel}`}>{ctx >= 1_000_000 ? `${(ctx / 1_000_000).toFixed(1)}M` : `${Math.round(ctx / 1000)}K`}</span>
            : null}
          <button className="m-more" onClick={() => setMenuOpen(true)} aria-label="Project actions">⋯</button>
        </div>
      </header>
      {actionError && !branchOpen && <div className="m-banner" data-connection="offline" role="alert" onClick={() => setActionError('')}>{actionError} · tap to dismiss</div>}
      {handoff && showHandoffStrip(handoff, nowTick) && (
        <div className="m-banner" data-connection={handoff.state === 'failed' || handoff.state === 'aborted' ? 'offline' : undefined} role="status">
          {handoffStateLabel(handoff)}
        </div>
      )}
      {menuOpen && project && (
        <ActionSheet
          title={`${project.name}${ws !== 'main' ? ` · ${ws}` : ''}`}
          onClose={closeMenu}
          actions={[
            { label: 'Branch off a workstream…', onClick: () => setBranchOpen(true), disabled: project.kind === 'metaterm' || project.role === 'collaborator' },
            { label: reviewAlive ? 'Review another PR with Devin…' : 'Review a PR with Devin…', onClick: () => setReviewOpen(true), disabled: !hasAgent || project.kind === 'metaterm' },
            ...(reviewAlive ? [{ label: 'Stop the review…', onClick: () => setStopReviewOpen(true), danger: true }] : []),
            ...(handoffOn && workstream && project.kind !== 'metaterm' && project.role !== 'collaborator' && canHandOff(provider)
              ? [{ label: 'Hand off…', onClick: () => setHandoffOpen(true), disabled: !hasAgent }]
              : []),
            { label: project.pinned ? 'Unpin project' : 'Pin project', onClick: () => { void togglePin(); }, disabled: project.role === 'collaborator' },
            { label: 'Archive project…', onClick: () => setArchiveOpen(true), danger: true, disabled: project.kind === 'metaterm' || project.role === 'collaborator' },
            { label: 'Open in full UI', onClick: openFull },
          ]}
        />
      )}
      {branchOpen && project && (
        <Sheet title={`Branch off from ${project.name} · ${ws}`} onClose={closeBranch}>
          <form className="m-form" onSubmit={branchOff}>
            <label className="m-field">
              <span className="m-field-label">Workstream name</span>
              <input className="m-text" autoFocus required autoCapitalize="off" autoCorrect="off" spellCheck={false}
                pattern="[A-Za-z0-9_-]+" title="letters, digits, dashes and underscores"
                placeholder="feature-x" value={branchName} onChange={e => setBranchName(e.target.value)} />
            </label>
            <label className="m-field">
              <span className="m-field-label">Base ref (optional)</span>
              <input className="m-text" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                placeholder="HEAD of the main worktree" value={baseRef} onChange={e => setBaseRef(e.target.value)} />
            </label>
            {actionError && <div className="m-form-error" role="alert">{actionError}</div>}
            <button type="submit" className="m-primary" disabled={!branchName.trim() || branchBusy}>{branchBusy ? 'Creating…' : 'Create and open'}</button>
            <p className="m-form-note">A git worktree and a branch named after the workstream, with their own agent and ctrl sessions.</p>
          </form>
        </Sheet>
      )}
      {reviewOpen && project && (
        <ReviewSheet
          projectId={project.id}
          projectName={project.name}
          workstream={ws}
          hasReview={reviewAlive}
          currentPr={reviewAlive ? review.status?.pr ?? null : null}
          onOpenCurrent={() => { setReviewOpen(false); setRole('review'); }}
          onStarted={onReviewStarted}
          onClose={() => setReviewOpen(false)}
        />
      )}
      {handoffOpen && project && workstream && (
        <HandoffSheet
          projectId={project.id}
          workstreamId={workstream.id}
          title={`${project.name}${ws !== 'main' ? ` · ${ws}` : ''}`}
          current={provider}
          onStarted={() => setHandoffOpen(false)}
          onClose={() => setHandoffOpen(false)}
        />
      )}
      {stopReviewOpen && project && (
        <ConfirmSheet
          message={<>{stopCopy.verb} the review{review.status?.pr != null ? <> of <strong>PR #{review.status.pr}</strong></> : null}? Devin's pane is closed and its output goes with it.</>}
          confirmLabel={stopCopy.confirmLabel}
          danger
          onConfirm={() => { void stopReview(); }}
          onClose={() => setStopReviewOpen(false)}
        />
      )}
      {archiveOpen && project && (
        <ConfirmSheet
          message={<>Archive <strong>{project.name}</strong>? This kills every tmux session of the project, all workstreams included.</>}
          confirmLabel="Archive"
          danger
          onConfirm={() => { void archive(); }}
          onClose={closeArchive}
        />
      )}
      <div className="m-tabs" role="tablist">
        <button role="tab" aria-selected={role === 'agent'} className={role === 'agent' ? 'active' : ''} onClick={() => setRole('agent')}>agent</button>
        <button role="tab" aria-selected={role === 'ctrl'} className={role === 'ctrl' ? 'active' : ''} onClick={() => setRole('ctrl')}>ctrl</button>
        {(reviewAlive || role === 'review') && (
          <button role="tab" aria-selected={role === 'review'} className={role === 'review' ? 'active' : ''} onClick={() => setRole('review')}>
            <span className="m-tab-dot" data-state={reviewDock} aria-hidden="true" />{reviewTabLabel(review.status)}
          </button>
        )}
      </div>

      <div className="m-transcript" ref={scroller} onScroll={onScroll}>
        {!paneAvailable && project && (
          role === 'review'
            ? <div className="m-empty">No review is running for this workstream.</div>
            : <div className="m-empty">This project has no agent workflow. The ctrl tab still works.</div>
        )}
        {paneAvailable && parsed == null && !capture.error && <div className="m-empty">Loading…</div>}
        {capture.error === 'offline' && <div className="m-notice m-notice-warn">The box's agent is offline. Showing the last capture.</div>}
        {capture.error === 'denied' && <div className="m-notice m-notice-warn">This session is not reachable.</div>}
        {capture.error === 'failed' && <div className="m-notice">Capture failed · retrying</div>}
        {parsed?.blocks.map((b, i) => <BlockView key={i} block={b} agentLabel={agentLabel} banner={b.kind === 'system' && firstTurn !== -1 && i < firstTurn} />)}
        {parsed && parsed.blocks.length === 0 && !capture.error && <div className="m-empty">Nothing on screen yet.</div>}
        {parsed?.draft ? <DraftView draft={parsed.draft} /> : null}
      </div>
      {unseen && <button className="m-jump" onClick={jumpToBottom}>↓ new output</button>}

      <div className="m-keybar" role="toolbar" aria-label="Keys">
        {keys.map(k => (
          <button key={k.label} className="m-key" onClick={() => onQuick(k)} disabled={sending || offline || !project} title={k.title}>{k.label}</button>
        ))}
        <span className="m-keybar-spacer" aria-hidden="true" />
        {role === 'review' && reviewAlive ? (
          // "Close" once Devin is finished (or gone), "Stop" while it is still at work; both kill the pane.
          // A review tab whose pane died shows the Review button instead, so it is never a dead end.
          <button className="m-key m-key-stop" onClick={() => setStopReviewOpen(true)}
            title={reviewKey === 'Close' ? 'Close the review pane' : 'Stop the review and close its pane'}>
            {reviewKey}
          </button>
        ) : (
          <button className="m-key m-key-review" onClick={onReviewButton} disabled={!project || !hasAgent || project.kind === 'metaterm'}
            title={reviewAlive ? 'Review another PR with Devin (replaces the running review)' : 'Review the PR being worked on with Devin'}>
            Review
          </button>
        )}
      </div>
      <form
        className="m-composer"
        onSubmit={e => { e.preventDefault(); onSend(true); }}
      >
        <textarea
          className="m-input"
          value={text}
          onChange={e => setText(e.target.value.slice(0, MAX_KEYS))}
          onKeyDown={e => {
            // Enter sends. No newline shortcut: newlines cannot be sent (see onSend).
            if (e.key === 'Enter') { e.preventDefault(); onSend(true); }
          }}
          placeholder={offline ? 'Agent offline' : role === 'ctrl' ? 'Shell command…' : role === 'review' ? 'Guide Devin…' : status?.status === 'working' ? 'Reply… (queues while the agent works)' : 'Reply…'}
          rows={1}
          enterKeyHint="send"
          autoCapitalize="off"
          autoCorrect="on"
          spellCheck
          disabled={offline || !project || !paneAvailable}
        />
        <button type="submit" className="m-send" disabled={sending || offline || !text.trim()} aria-label="Send">➤</button>
      </form>
      {(sendError || text.length > MAX_KEYS - 500) && (
        <div className="m-composer-note" data-error={sendError ? '' : undefined}>
          {sendError ?? `${text.length} / ${MAX_KEYS}`}
        </div>
      )}
    </div>
  );
}
