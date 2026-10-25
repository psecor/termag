import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { automationsApi, type AutomationRunView, type AutomationView } from '../services/api';
import { AutomationFields, draftBody, draftCron, draftFrom, type AutomationDraft } from '../components/AutomationFields';
import { runConversationHref } from '../chat/simpleChat';
import { FLAGS, useFlag } from '../flags';
import { RUN_STATE_LABEL, agoLabel, automationSubtitle, describeSchedule, occurrenceShort, untilLabel } from '../utils/automationSchedule';
import { runNowRefusal } from '../utils/automationRunNow';
import { fmtDurationShort } from '../utils/format';

/**
 * Automations: `/automations` lists the user's own and
 * shared ones; `/automations/:id` (an automation's or its project's id) is
 * one automation with its schedule and prompt editable in place, Enabled,
 * Run now, the run table and the notes file the runs share. A run's
 * conversation opens in the simple UI (in the workspace without
 * simple-ui-enabled). Mounted like the dashboard, no status WebSocket and
 * no human heartbeat, so reading it is not working time; inside
 * FeatureFlagsProvider (App.tsx) so that flag is read, not its fallback.
 */
const POLL_MS = 10_000;

function errorText(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

export default function Automations() {
  const { id } = useParams();
  return (
    <div className="dash-root">
      <div className="dash-page automations-page">
        <header className="dash-header">
          <h1>{id ? 'Automation' : 'Automations'}</h1>
          <Link to="/">← workspace</Link>
          {id && <Link to="/automations">all automations</Link>}
          <Link to="/dashboard">dashboard</Link>
        </header>
        {id ? <AutomationDetail id={id} /> : <AutomationIndex />}
      </div>
    </div>
  );
}

function AutomationIndex() {
  const [list, setList] = useState<AutomationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => automationsApi.list().then(l => { if (!cancelled) { setList(l); setError(null); } }).catch(err => { if (!cancelled) setError(errorText(err, 'Could not load automations')); });
    load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, []);
  return (
    <section className="dash-card">
      <div className="dash-card-head"><span>Your automations</span></div>
      {error && <p className="error-text">{error}</p>}
      {list && list.length === 0 && (
        <p className="usage-dim">None yet. In the workspace, hold Shift over <strong>New project</strong> (or use its ⏱ button) to make one: a prompt an agent runs on a schedule, each run its own branch.</p>
      )}
      {list && list.length > 0 && (
        <ul className="auto-list">
          {list.map(a => (
            <li key={a.id}>
              <Link className="auto-row" to={`/automations/${encodeURIComponent(a.projectId)}`}>
                <span aria-hidden>⏱</span>
                <span className="auto-name">{a.projectName}{!a.owner && <span className="usage-dim"> (shared)</span>}</span>
                <span className="auto-sub">{describeSchedule(a.schedule, a.timezone)}</span>
                <span className="auto-sub">{automationSubtitle(a, a.timezone)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function AutomationDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  // A run's conversation is the simple UI's when this user has it; /chat redirects to / otherwise.
  const simpleUi = useFlag(FLAGS.simpleUi, false);
  const [view, setView] = useState<(AutomationView & { runs: AutomationRunView[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<AutomationDraft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fullTierTicked, setFullTierTicked] = useState(false);
  const [memory, setMemory] = useState<{ path: string; content: string | null } | null | 'error'>(null);
  const [showMemory, setShowMemory] = useState(false);
  // The page's own load failure, apart from `error`, which an action set and
  // the next successful poll must not clear before it is read.
  const [loadError, setLoadError] = useState<string | null>(null);
  const viewRef = useRef<AutomationView | null>(null);
  // `dirty` as of the moment a response lands, not as of the render that
  // started the request: a GET that began while the form was clean must not
  // replace a draft the owner has typed into since. Newer requests win.
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const v = await automationsApi.get(id);
      if (seq !== loadSeq.current) return; // a newer load answered first
      const prev = viewRef.current;
      viewRef.current = v;
      setView(v);
      // A dirty draft keeps its edits, but `enabled` follows the server when
      // the form did not touch it: Pause/Enable/Resume (here or elsewhere)
      // must not be undone by the next Save.
      setDraft(d => {
        if (!d || !dirtyRef.current) return draftFrom(v);
        const formTouchedEnabled = prev ? d.enabled !== prev.enabled : false;
        return formTouchedEnabled || d.enabled === v.enabled ? d : { ...d, enabled: v.enabled };
      });
      setLoadError(null);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setLoadError(errorText(err, 'Could not load this automation'));
    }
  }, [id]);
  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (!showMemory || !view?.owner) return;
    let cancelled = false;
    automationsApi.memory(view.id)
      .then(m => { if (!cancelled) setMemory(m); })
      .catch(() => { if (!cancelled) setMemory('error'); });
    return () => { cancelled = true; };
  }, [showMemory, view?.id, view?.owner, view?.runs.length]);

  /** Run one action and reload; true when it worked (a failure shows and leaves the caller's state alone). */
  const act = async (fn: () => Promise<unknown>, done: string): Promise<boolean> => {
    setNotice(null);
    setError(null);
    try { await fn(); setNotice(done); await load(); return true; } catch (err) { setError(errorText(err, 'That did not work')); return false; }
  };

  if (loadError && !view) return <section className="dash-card"><p className="error-text">{loadError}</p></section>;
  if (!view || !draft) return <section className="dash-card"><p className="usage-dim">Loading…</p></section>;
  const owner = view.owner;
  const live = view.runs.find(r => r.state === 'running' || r.state === 'pending') ?? null;
  // Raising a read-only automation to full is the trust tick (it stamps chatTrustedAt): Save waits for the checkbox, as Create does.
  const raisingToFull = draft.tier === 'full' && view.tier !== 'full';
  const canSave = owner && dirty && !saving && !!draft.prompt.trim() && draftCron(draft) !== null && (!raisingToFull || fullTierTicked);

  return (
    <>
      <section className="dash-card">
        <div className="dash-card-head">
          <span>⏱ {view.projectName}{!owner && <span className="usage-dim"> · shared by its owner</span>}</span>
          <span className="usage-dim">{automationSubtitle(view, view.timezone)}</span>
        </div>
        <div className="auto-actions">
          {owner && (
            <button type="button" className="btn-primary" disabled={!!live} title={live ? 'A run is already live' : undefined}
              onClick={() => act(async () => {
                // 409 (skipped, with why) and 502 (failed on the box) are rejections: say the reason, not "did not work".
                try { await automationsApi.runNow(view.id); } catch (err) {
                  const refusal = runNowRefusal(err);
                  if (refusal) throw { response: { data: { error: refusal } } };
                  throw err;
                }
              }, 'Run started')}>Run now</button>
          )}
          {owner && (
            <button type="button" className="btn-ghost" onClick={() => act(() => automationsApi.update(view.id, { enabled: !view.enabled }), view.enabled ? 'Paused' : 'Enabled')}>
              {view.enabled ? 'Pause schedule' : 'Enable schedule'}
            </button>
          )}
          {view.pausedReason && owner && (
            <button type="button" className="btn-ghost" onClick={() => act(() => automationsApi.update(view.id, {}), 'Resumed')}>Resume (clear the pause)</button>
          )}
          <button type="button" className="btn-ghost" onClick={() => navigate(`/?project=${encodeURIComponent(view.projectId)}`)}>Open in workspace</button>
          {view.lastRun?.workstream && (
            <Link className="btn-ghost" to={runConversationHref(view.projectId, view.lastRun.workstream, simpleUi)}>Latest run's conversation</Link>
          )}
          {owner && (
            <button type="button" className="btn-ghost menu-danger" onClick={() => { if (window.confirm(`Archive ${view.projectName}? Its runs stop; the project and its branches stay archived.`)) void act(() => automationsApi.remove(view.id).then(() => navigate('/automations')), 'Archived'); }}>Archive</button>
          )}
        </div>
        {notice && <p className="usage-dim">{notice}</p>}
        {error && <p className="error-text">{error} <button type="button" className="btn-tiny" onClick={() => setError(null)}>dismiss</button></p>}
        {loadError && view && <p className="error-text">{loadError}</p>}
        <dl className="auto-facts usage-dim">
          <div><dt>Schedule</dt><dd>{describeSchedule(view.schedule, view.timezone)}{view.next[0] && <> · next {occurrenceShort(view.next[0], view.timezone)} ({untilLabel(view.next[0])})</>}</dd></div>
          <div><dt>Repository</dt><dd>{view.repoUrl ?? 'none'}{view.defaultBranch && <> · base {view.defaultBranch}</>}</dd></div>
          {view.spaceName && <div><dt>Notes</dt><dd>mirrored to space <code>{view.spaceName}</code> at <code>automations/{view.projectId}/memory/MEMORY.md</code></dd></div>}
          <div><dt>Permissions</dt><dd>{view.tier === 'read' ? 'read-only' : 'full, Claude in auto mode'}{view.prOnChange && view.tier !== 'read' && ' · opens a draft PR when a run committed'}</dd></div>
        </dl>
      </section>

      <section className="dash-card">
        <div className="dash-card-head"><span>Runs</span><span className="usage-dim">{view.runs.length} shown · keeping {view.keepRuns} worktrees</span></div>
        {view.runs.length === 0 ? <p className="usage-dim">No runs yet.</p> : (
          <table className="auto-table">
            <thead><tr><th>Occurrence</th><th>Trigger</th><th>State</th><th>Took</th><th>Changes</th><th>Summary</th><th>Branch</th><th></th></tr></thead>
            <tbody>
              {view.runs.map(r => (
                <tr key={r.id}>
                  <td title={r.scheduledFor}>{occurrenceShort(r.scheduledFor, view.timezone)}</td>
                  <td>{r.trigger}</td>
                  <td><span className={`run-state run-${r.state}`}>{RUN_STATE_LABEL[r.state] ?? r.state}</span>{r.reasonLabel && <div className="usage-dim">{r.reasonLabel}</div>}</td>
                  <td>{r.durationSec !== null ? fmtDurationShort(r.durationSec * 1000) : r.finishedAt ? agoLabel(r.finishedAt) : ''}{r.costUsd !== null && <div className="usage-dim">${r.costUsd.toFixed(2)}</div>}</td>
                  <td>{r.changesLabel ?? ''}</td>
                  <td className="auto-summary" title={r.summary ?? undefined}>{r.summary ?? ''}</td>
                  <td>{r.prUrl ? <a href={r.prUrl} target="_blank" rel="noreferrer">PR</a> : r.branch ? <code>{r.branch.split('/').pop()}</code> : ''}</td>
                  <td className="auto-actions">
                    {r.workstream && <Link to={runConversationHref(view.projectId, r.workstream, simpleUi)} title={simpleUi ? "The run's conversation in the simple UI" : "The run's conversation in the workspace"}>💬</Link>}
                    {owner && (r.state === 'running' || r.state === 'pending') && (
                      <button type="button" className="btn-tiny" onClick={() => act(() => automationsApi.stopRun(view.id, r.id), 'Run stopped')}>Stop</button>
                    )}
                    {owner && r.workstream && r.state !== 'running' && r.state !== 'pending' && (
                      <button type="button" className="btn-tiny" title="Remove the run's worktree and branch; the row stays" onClick={() => act(() => automationsApi.retireRun(view.id, r.id), 'Worktree removed')}>Retire</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {owner && (
        <section className="dash-card auto-edit">
          <div className="dash-card-head"><span>Schedule and prompt</span></div>
          <AutomationFields draft={draft} onChange={d => { setDraft(d); setDirty(true); }} showEnabled idPrefix={`auto-${view.id}`} onFullTierTick={view.tier !== 'full' ? setFullTierTicked : undefined} />
          <div className="auto-actions">
            <button type="button" className="btn-primary" disabled={!canSave} onClick={async () => {
              setSaving(true);
              // Only a saved draft is clean: a refused PATCH keeps the edits (and the
              // poll from replacing them with the server copy) so they can be fixed.
              const saved = await act(() => automationsApi.update(view.id, draftBody(draft)), 'Saved');
              if (saved) setDirty(false);
              setSaving(false);
            }}>{saving ? 'Saving…' : 'Save'}</button>
            {dirty && <button type="button" className="btn-ghost" onClick={() => { setDraft(draftFrom(view)); setDirty(false); }}>Discard</button>}
          </div>
        </section>
      )}

      {owner && (
        <section className="dash-card">
          <div className="dash-card-head">
            <span>Notes between runs</span>
            <button type="button" className="btn-ghost btn-select-toggle" onClick={() => setShowMemory(s => !s)}>{showMemory ? 'Hide' : 'Show'}</button>
          </div>
          {showMemory && (
            memory === 'error' ? <p className="error-text">Could not read the notes file (is the box up?).</p>
              : memory === null ? <p className="usage-dim">Loading…</p>
                : <>
                  <p className="usage-dim"><code>{memory.path}</code> · what runs leave for each other; the brief tells them it is notes, not instructions.</p>
                  <pre className="auto-memory">{memory.content ?? '(no notes yet)'}</pre>
                </>
          )}
        </section>
      )}
      {!owner && user && <p className="usage-dim">Shared with you: you can read the runs and open their conversations; the owner edits the schedule.</p>}
    </>
  );
}
