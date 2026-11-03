// One automation in the simple UI, at /chat/automations/:id (the
// automation's or its project's id; behind simple-ui-automations-enabled and
// automations-enabled): its name and state, Run now, a ⋮ with Pause/Enable,
// Resume, Open in Lab and Archive, what it runs and when in words, the model
// its next run starts on (the owner changes it here, AutomationModelSelect.tsx),
// and its run history (RunHistory.tsx). Editing the schedule and prompt is the
// full UI's page for now (the simple UI's form comes next). There is no list
// of automations: each is in its space's explorer, with the space's agents
// and files (or under No space), and its row there opens this page, with that
// explorer beside it in the side panel (ExplorerTree.tsx, ChatApp.tsx).
//
// The header, facts and actions come from the automation's detail fetch, or
// from the shared list until that answers or when it fails, so a failed
// detail or run-history load is an inline error beside the runs rather than
// a blank page. The route remounts this per id (AutomationDetailRoute) and
// useAutomation drops answers for an id no longer on screen, so a slow
// fetch or a reload after an action on the previous automation never
// overwrites this one.
import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '@launchpad-ui/components';
import { LP_THEME } from '../../../launchpad/theme';
import { automationsApi, type AutomationRunView } from '../../../services/api';
import { automationState, errorText, isLiveRun, shownAutomation } from '../../../chat/automationsView';
import { useAutomation } from '../../../chat/useAutomation';
import { useAutomations, useAutomationsEnabled } from '../../../chat/useAutomations';
import { repoSlug } from '../../../chat/simpleChat';
import { agoLabel, boxStartFailuresLabel, describeSchedule, occurrenceShort, RUN_STATE_LABEL, untilLabel } from '../../../utils/automationSchedule';
import { runNowRefusal } from '../../../utils/automationRunNow';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import type { MenuAction } from '../ContextMenu';
import { ChatHistoryButton, ChatMoreButton, SidePanelButton } from '../chatChrome';
import { ChatError } from '../TranscriptNotices';
import { automationModelBody, automationModelId } from '../../../utils/automationModel';
import { chatModelLabel } from '../../../chat/composer';
import { AutomationModelSelect } from './AutomationModelSelect';
import { RunHistory } from './RunHistory';
import { StateChip } from './StateChip';
import './automations.css';

export function ClockIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.6V8l2.4 1.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The route: one AutomationDetail per id, so nothing of the previous automation's page carries over. */
export function AutomationDetailRoute() {
  const { id = '' } = useParams();
  return <AutomationDetail key={id} id={id} />;
}

export function AutomationDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const enabled = useAutomationsEnabled();
  const { list, reload: reloadList } = useAutomations();
  const { detail, error: loadError, reload } = useAutomation(id, enabled);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  if (!enabled) return <div className="chat-home"><p>Automations are not on in this UI for you yet.</p></div>;
  const view = shownAutomation(id, detail, list);
  if (!view) {
    if (loadError) {
      return (
        <div className="chat-home">
          <ChatError text={loadError} onRetry={() => { void reload(); }} />
          <p><Link to="/chat">Back to your sessions</Link></p>
        </div>
      );
    }
    return <div className="chat-home"><p>Loading…</p></div>;
  }

  /** Runs one action, then reloads this page and the list; true when it worked. */
  const act = async (fn: () => Promise<unknown>, done: string): Promise<boolean> => {
    setNotice(null); setError(null); setBusy(true);
    try {
      await fn();
      if (!mounted.current) return true;
      setNotice(done);
      await Promise.all([reload(), reloadList()]);
      return true;
    } catch (err) {
      if (mounted.current) setError(errorText(err, 'That did not work'));
      return false;
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const owner = view.owner && !view.archived;
  const runs: AutomationRunView[] | null = detail ? detail.runs : null;
  const live = (runs ?? []).some(isLiveRun) || isLiveRun(view.lastRun);
  const state = automationState(view);
  const repo = repoSlug(view.repoUrl);
  const next = view.enabled && !view.pausedReason ? view.next[0] ?? view.nextRunAt : null;
  const last = view.lastRun;
  const model = automationModelId(view);

  const runNow = () => act(async () => {
    // 409 (skipped, with why) and 502 (failed on the box) are refusals: say the reason.
    try { await automationsApi.runNow(view.id); } catch (err) {
      const refusal = runNowRefusal(err);
      if (refusal) throw { response: { data: { error: refusal } } };
      throw err;
    }
  }, 'Run started; it shows in the runs below');

  // Archive leaves the page for Home; the shared list reloads, so its row leaves its space's explorer.
  const archive = async () => {
    setNotice(null); setError(null); setBusy(true);
    try {
      await automationsApi.remove(view.id);
      await reloadList();
      if (mounted.current) navigate('/chat');
    } catch (err) {
      if (mounted.current) { setError(errorText(err, 'Could not archive it')); setBusy(false); }
    }
  };

  const menu: MenuAction[] = [];
  if (owner) {
    menu.push({ label: 'Run now', onSelect: () => { void runNow(); }, disabled: busy || live });
    menu.push(view.enabled
      ? { label: 'Pause schedule', hint: 'Run now still works', onSelect: () => { void act(() => automationsApi.update(view.id, { enabled: false }), 'Schedule paused'); }, disabled: busy }
      : { label: 'Enable schedule', onSelect: () => { void act(() => automationsApi.update(view.id, { enabled: true }), 'Schedule on'); }, disabled: busy });
    if (view.pausedReason) menu.push({ label: 'Resume', hint: "Clear the scheduler's pause", onSelect: () => { void act(() => automationsApi.update(view.id, {}), 'Resumed'); }, disabled: busy });
  }
  menu.push({ label: 'Open in Lab', hint: 'Edit the schedule and prompt, read the notes', onSelect: () => navigate(`/automations/${encodeURIComponent(view.projectId)}`) });
  if (owner) menu.push({ label: 'Archive…', onSelect: () => setConfirmArchive(true), disabled: busy });

  return (
    <div className={`chat-view ${LP_THEME}`}>
      <section className="chat-conv">
        <header className="chat-header">
          <ChatHistoryButton />
          <div className="chat-title">
            <span className="chat-glyph" aria-hidden="true"><ClockIcon size={14} /></span>
            <span className="chat-title-name">{view.projectName}</span>
            <StateChip automation={view} />
            {repo && <span className="chat-title-repo" title={view.repoUrl ?? undefined}>{repo}</span>}
          </div>
          <div className="chat-header-actions">
            {owner && (
              <Button variant="primary" size="small" className="chat-auto-run" isDisabled={busy || live}
                aria-description={live ? 'A run is already live' : 'Start a run now, outside the schedule'} onPress={() => { void runNow(); }}>Run now</Button>
            )}
            <ChatMoreButton label={`${view.projectName}: actions`} actions={menu} />
            <SidePanelButton />
          </div>
        </header>
        <div className="chat-auto-page">
          <div className="chat-auto-card">
            {notice && <p className="chat-auto-notice" role="status">{notice}</p>}
            {error && <ChatError text={error} />}
            <dl className="chat-auto-facts">
              <div><dt>Runs</dt><dd>{describeSchedule(view.schedule, view.timezone)}</dd></div>
              {boxStartFailuresLabel(view.boxStartFailures) && <div><dt>Box</dt><dd className="chat-auto-warn">{boxStartFailuresLabel(view.boxStartFailures)}</dd></div>}
              <div><dt>Next</dt><dd>{next ? <>{occurrenceShort(next, view.timezone)} <span className="chat-auto-dim">({untilLabel(next)})</span></> : <span className="chat-auto-dim">{state.title}</span>}</dd></div>
              <div><dt>Last</dt><dd>{last ? <>{last.state === 'skipped' && last.reasonLabel ? `skipped: ${last.reasonLabel}` : RUN_STATE_LABEL[last.state] ?? last.state}{(last.finishedAt ?? last.startedAt) && <span className="chat-auto-dim"> {agoLabel((last.finishedAt ?? last.startedAt)!)}</span>}</> : <span className="chat-auto-dim">no runs yet</span>}</dd></div>
              <div><dt>Model</dt><dd>{owner
                ? <AutomationModelSelect value={model} disabled={busy}
                    onPick={(id, label) => { void act(() => automationsApi.update(view.id, automationModelBody(id)), `The next run starts on ${label}`); }} />
                : chatModelLabel(model)}</dd></div>
              <div><dt>Permissions</dt><dd>{view.tier === 'read' ? 'read-only' : 'full, Claude in auto mode'}{view.prOnChange && view.tier !== 'read' && ' · opens a draft PR when a run committed'}</dd></div>
              {view.spaceName && <div><dt>Space</dt><dd>{view.spaceName}{view.spaceFolder ? <span className="chat-auto-dim"> · {view.spaceFolder}</span> : null}</dd></div>}
            </dl>
            {!view.owner && <p className="chat-auto-dim">Shared with you: you can open its runs; its owner changes the schedule.</p>}
          </div>

          <RunHistory
            runs={runs}
            error={loadError}
            onRetry={() => { void reload(); }}
            projectId={view.projectId}
            timezone={view.timezone}
            owner={owner}
            busy={busy}
            open={href => navigate(href)}
            actions={{
              stop: r => { void act(() => automationsApi.stopRun(view.id, r.id), 'Run stopped'); },
              retire: r => { void act(() => automationsApi.retireRun(view.id, r.id), 'Worktree removed'); },
            }}
          />

          <div className="chat-auto-card">
            <h2>Prompt</h2>
            <pre className="chat-auto-prompt">{view.prompt}</pre>
          </div>
        </div>
      </section>
      {confirmArchive && (
        <ConfirmDialog
          message={`Archive ${view.projectName}? Its runs stop; the project and its branches stay archived.`}
          confirmLabel="Archive"
          onCancel={() => setConfirmArchive(false)}
          onConfirm={() => {
            setConfirmArchive(false);
            void archive();
          }}
        />
      )}
    </div>
  );
}
