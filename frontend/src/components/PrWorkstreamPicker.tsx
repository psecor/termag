import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { prsApi, projectsApi, instancesApi, type PrCheckout, type PrRow } from '../services/api';
import type { Project } from '../types';
import { boxFeed } from '../services/boxFeed';
import { apiErrorText } from '../utils/prPipeline';
import { WAKE_READ_TIMEOUT_MS, WAKE_START_TIMEOUT_MS, wakeBox, wakeNote, wakeStep, type WakeResult } from '../utils/boxWake';
import { useProjects } from '../contexts/ProjectContext';
import { projectHref } from '../pages/dashboard/AttentionSection';
import { filterChoices, isWorkstreamName, scopedProjects, suggestPrPrompt, suggestWorkstreamName, workstreamChoices } from '../utils/workstreamChoices';

/**
 * The PR overlay's "Attach…" control: put a PR on one of the user's workstreams by hand, so
 * its pill shows there, or drop a link made by hand. Opens a small search
 * over the workstreams of the projects that are a checkout of the PR's
 * repository (all of them when no box has said); type to narrow, arrow keys
 * and Enter to pick, Esc to close. The project list is read when the picker
 * opens: the overlay also opens on the dashboard, which has no project context.
 *
 * "New workstream for #N…" at the foot of the list makes one on the PR's own
 * branch (POST /api/prs/…/workstream: the box fetches pull/<n>/head, or adopts
 * an agent-made worktree already on it), attaches the PR and opens it. The
 * name defaults to the repository's, the PR's number and the branch's
 * (termag-pr359-pr-defer), the project to the most recently active checkout of
 * the PR's repository. The agent starts on a prompt about the PR, which the
 * form shows and the user can change or clear. With no checkout of the
 * repository known, the form warns: the box refuses a project whose origin is
 * another repository. A stopped or hibernated box is started first and waited
 * for (utils/boxWake): the checkout runs on the box, so it has to be up before
 * the workstream is asked for.
 */
export function PrWorkstreamPicker({ row, checkouts, onChanged, onError }: {
  row: PrRow; checkouts?: PrCheckout[]; onChanged: () => void; onError: (msg: string) => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [busy, setBusy] = useState(false);
  // What the box the workstream will be made on is doing, while the picker waits for it.
  const [waiting, setWaiting] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  // The "New workstream" form: where, under what name, and what its agent is asked first.
  const [creating, setCreating] = useState<{ projectId: string; name: string; prompt: string } | null>(null);
  const navigate = useNavigate();
  // A no-op outside the workspace (the dashboard): the workspace loads afresh when the link opens it.
  const { reloadProjects, setActiveWorkstream } = useProjects();
  // The caller's own boxes, to find the one the chosen project lives on and start it if it is down.
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const list = useRef<HTMLUListElement | null>(null);
  // Whether this picker is still on screen. A box can take minutes to come up,
  // and the overlay can be closed while it does: the workstream is still made,
  // but the user who left is not pulled to it when it lands.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // Keep the highlighted row in view as the arrow keys move it, as a native select would.
  useEffect(() => {
    list.current?.querySelector('li.active')?.scrollIntoView({ block: 'nearest' });
  }, [hi, query, projects]);
  if (row.kind !== 'pr' || !row.repo || row.number == null) return null;
  const { repo, number } = row;

  const close = () => { setProjects(null); setQuery(''); setHi(0); setCreating(null); setWaiting(null); };
  const open = async () => {
    setBusy(true);
    // Fresh box states too: the projects list only says which box each one is on.
    void boxFeed.reload();
    try { setProjects(await projectsApi.list()); } catch (err) { onError(apiErrorText(err, 'Could not list your workstreams.')); }
    finally { setBusy(false); }
  };
  const run = async (fn: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try { await fn(); close(); onChanged(); } catch (err) { onError(apiErrorText(err, failure)); }
    finally { setBusy(false); }
  };

  const trigger = (
    <>
      <button type="button" className="btn-ghost btn-tiny" disabled={busy} onClick={() => { if (projects) close(); else void open(); }}
        title="Show this PR's pill on a workstream of your choice" aria-expanded={!!projects}>
        {row.workstream ? 'Move…' : 'Attach to a workstream…'}
      </button>
      {row.linkedBy === 'manual' && !projects && (
        <button type="button" className="btn-ghost btn-tiny" disabled={busy}
          onClick={() => { void run(() => prsApi.unlink(repo, number), 'Could not detach it.'); }}>Detach</button>
      )}
    </>
  );
  if (!projects) return <span className="prs-ws-pick">{trigger}</span>;

  const { choices, sameRepo } = workstreamChoices(projects, row.workstream, repo, checkouts);
  const targets = scopedProjects(projects, repo, checkouts);
  const startNew = () => {
    if (targets.length === 0) { onError('No project of yours to make it in.'); return; }
    setCreating({ projectId: targets[0].id, name: suggestWorkstreamName(repo, number, row.headRefName), prompt: suggestPrPrompt(repo, number) });
  };
  const createNew = async () => {
    if (!creating || busy || !isWorkstreamName(creating.name)) return;
    const { projectId, name, prompt } = creating;
    setBusy(true);
    try {
      // The checkout runs on the project's box, so a parked box is started and
      // waited for rather than answered with "start it from the Boxes list".
      const project = projects?.find(p => p.id === projectId);
      let box = (project?.instanceId ? boxes.find(b => b.id === project.instanceId) : undefined) ?? null;
      // The box list may not have loaded yet (the overlay also opens on the dashboard).
      if (project?.instanceId && !box) {
        await boxFeed.reload();
        box = boxFeed.getSnapshot().find(b => b.id === project.instanceId) ?? null;
      }
      // Decide on a read taken now, not on the feed's snapshot: it stops
      // polling once every box settles, so a box started (or stopped) from
      // another tab still reads as it did when the list last loaded. A stale
      // "stopped" would ask to start a box that is already up, and a stale
      // "ready" would skip the wake and hit the parked-box refusal.
      if (box) {
        const known = box;
        box = await instancesApi.get(known.id, WAKE_READ_TIMEOUT_MS).catch(() => known);
      }
      // Only an EC2 box can be started from here; an external box's agent
      // comes back with its machine, so its own error stands.
      if (box && box.kind === 'ec2' && wakeStep(box.status) !== 'ready') {
        setWaiting(wakeNote(box.name, box.status));
        // Show the box going up in the sidebar's Boxes list at once, then once
        // per status change.
        void boxFeed.reload();
        // Reflect the box's progress in the sidebar's Boxes list once per
        // change: the feed polls through a transitional status by itself, so
        // a reload every 3 s would only repeat its own requests.
        let shown = box.status;
        let woken: WakeResult;
        try {
          woken = await wakeBox(box, {
            get: id => instancesApi.get(id, WAKE_READ_TIMEOUT_MS),
            start: id => instancesApi.start(id, WAKE_START_TIMEOUT_MS),
            onWait: b => {
              setWaiting(wakeNote(b.name, b.status));
              if (b.status !== shown) { shown = b.status; void boxFeed.reload(); }
            },
          });
        } catch (err) {
          // A start the backend refused: its message, not the checkout one.
          onError(apiErrorText(err, `Could not start ${box.name}. Start it from the Boxes list and try again.`));
          return;
        }
        if (!woken.ok) { onError(woken.error); return; }
        void boxFeed.reload();
      }
      const ws = await prsApi.newWorkstream(repo, number, projectId, name, prompt);
      // Still on screen? A closed overlay keeps the workstream it asked for
      // (its checkout is in flight, like any slow one), but does not navigate.
      if (!mounted.current) return;
      close();
      await reloadProjects().catch(() => undefined);
      setActiveWorkstream(projectId, ws.name);
      navigate(projectHref(projectId, ws.name));
      onChanged();
    } catch (err) {
      // A gateway timeout has no JSON error: the box may still be checking a big repository out.
      onError(apiErrorText(err, 'No answer in time: if the box was slow, the workstream still appears in the sidebar when its checkout finishes.'));
    } finally {
      setBusy(false);
      setWaiting(null);
    }
  };
  if (creating) {
    const valid = isWorkstreamName(creating.name);
    return (
      <span className="prs-ws-pick">
        {trigger}
        <div className="prs-ws-popover" role="dialog" aria-label={`New workstream for #${number}`}>
          <div className="prs-ws-new-title">New workstream on <code>{row.headRefName}</code></div>
          {targets.length > 1 && (
            <select className="prs-ws-project" value={creating.projectId} disabled={busy} aria-label="Project"
              onChange={e => setCreating({ ...creating, projectId: e.target.value })}>
              {targets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          {targets.length === 1 && <div className="usage-dim prs-ws-scope">in {targets[0].name}</div>}
          {/* The box refuses a project on another repository (routes/workstreams.ts): say so before it is picked. */}
          {!sameRepo && (
            <div className="error-text prs-ws-scope" role="note">
              No checkout of {repo} known: pick a project on {repo}, or make one (or un-archive it) first.
            </div>
          )}
          <input
            autoFocus
            className="prs-ws-search"
            aria-label="Workstream name"
            value={creating.name}
            disabled={busy}
            onChange={e => setCreating({ ...creating, name: e.target.value.trim() })}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.stopPropagation(); setCreating(null); }
              else if (e.key === 'Enter') { e.preventDefault(); void createNew(); }
            }}
          />
          {!valid && <div className="error-text prs-ws-scope">Letters, digits, dashes and underscores; not "main".</div>}
          <textarea
            className="prs-ws-search prs-ws-prompt"
            aria-label="First prompt for the agent"
            placeholder="First prompt for the agent (optional)"
            rows={3}
            value={creating.prompt}
            disabled={busy}
            onChange={e => setCreating({ ...creating, prompt: e.target.value })}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.stopPropagation(); setCreating(null); }
              else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void createNew(); }
            }}
          />
          <div className="usage-dim prs-ws-scope">
            {waiting
              ? waiting
              : busy
                ? 'Checking the branch out on the box…'
                : 'Checks out the PR\'s branch (or adopts a worktree already on it), attaches the PR and opens the workstream; its agent starts on the prompt. A stopped box is started first.'}
          </div>
          <div className="prs-ws-actions">
            <button type="button" className="btn-primary btn-tiny" disabled={busy || !valid} onClick={() => { void createNew(); }}>Create</button>
            <button type="button" className="btn-ghost btn-tiny" disabled={busy} onClick={() => setCreating(null)}>Back</button>
          </div>
        </div>
      </span>
    );
  }
  const shown = filterChoices(choices, query);
  const at = Math.min(hi, Math.max(0, shown.length - 1));
  const pick = (i: number) => {
    const c = shown[i];
    if (c && !busy) void run(() => prsApi.link(repo, number, c.projectId, c.workstream), 'Could not attach it.');
  };
  return (
    <span className="prs-ws-pick">
      {trigger}
      <div className="prs-ws-popover" role="dialog" aria-label="Attach to a workstream">
        <input
          autoFocus
          className="prs-ws-search"
          placeholder="Type to filter…"
          value={query}
          disabled={busy}
          aria-controls="prs-ws-options"
          aria-activedescendant={shown[at] ? `prs-ws-opt-${at}` : undefined}
          onChange={e => { setQuery(e.target.value); setHi(0); }}
          onKeyDown={e => {
            if (e.key === 'Escape') { e.stopPropagation(); close(); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); setHi(Math.min(at + 1, shown.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math.max(at - 1, 0)); }
            else if (e.key === 'Enter') { e.preventDefault(); pick(at); }
          }}
        />
        <div className="usage-dim prs-ws-scope">
          {sameRepo ? `Checkouts of ${repo}` : `No checkout of ${repo} known: all your workstreams`}
        </div>
        <ul className="prs-ws-options" id="prs-ws-options" role="listbox" ref={list}>
          {shown.map((c, i) => (
            <li
              key={c.value}
              id={`prs-ws-opt-${i}`}
              role="option"
              aria-selected={i === at}
              className={i === at ? 'active' : ''}
              onMouseEnter={() => setHi(i)}
              onMouseDown={e => { e.preventDefault(); pick(i); }}
            >{c.label}</li>
          ))}
          {shown.length === 0 && <li className="usage-dim prs-ws-none">{choices.length ? 'Nothing matches.' : 'No other workstreams.'}</li>}
        </ul>
        <button type="button" className="btn-ghost btn-tiny prs-ws-new" onClick={startNew}>+ New workstream for #{number}…</button>
      </div>
    </span>
  );
}
