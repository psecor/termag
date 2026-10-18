import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { prsApi, projectsApi, type PrCheckout, type PrRow } from '../services/api';
import type { Project } from '../types';
import { apiErrorText } from '../utils/prPipeline';
import { useProjects } from '../contexts/ProjectContext';
import { projectHref } from '../pages/dashboard/AttentionSection';
import { filterChoices, isWorkstreamName, scopedProjects, suggestWorkstreamName, workstreamChoices } from '../utils/workstreamChoices';

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
 * name defaults to the repository's plus the branch's (termag-pr-defer), the
 * project to the most recently active checkout of the PR's repository.
 */
export function PrWorkstreamPicker({ row, checkouts, onChanged, onError }: {
  row: PrRow; checkouts?: PrCheckout[]; onChanged: () => void; onError: (msg: string) => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  // The "New workstream" form: where, and under what name.
  const [creating, setCreating] = useState<{ projectId: string; name: string } | null>(null);
  const navigate = useNavigate();
  // A no-op outside the workspace (the dashboard): the workspace loads afresh when the link opens it.
  const { reloadProjects, setActiveWorkstream } = useProjects();
  const list = useRef<HTMLUListElement | null>(null);
  // Keep the highlighted row in view as the arrow keys move it, as a native select would.
  useEffect(() => {
    list.current?.querySelector('li.active')?.scrollIntoView({ block: 'nearest' });
  }, [hi, query, projects]);
  if (row.kind !== 'pr' || !row.repo || row.number == null) return null;
  const { repo, number } = row;

  const close = () => { setProjects(null); setQuery(''); setHi(0); setCreating(null); };
  const open = async () => {
    setBusy(true);
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
    setCreating({ projectId: targets[0].id, name: suggestWorkstreamName(repo, row.headRefName) });
  };
  const createNew = () => {
    if (!creating || busy || !isWorkstreamName(creating.name)) return;
    const { projectId, name } = creating;
    void run(async () => {
      const ws = await prsApi.newWorkstream(repo, number, projectId, name);
      await reloadProjects().catch(() => undefined);
      setActiveWorkstream(projectId, ws.name);
      navigate(projectHref(projectId, ws.name));
    // A gateway timeout has no JSON error: the box may still be checking a big repository out.
    }, 'No answer in time: if the box was slow, the workstream still appears in the sidebar when its checkout finishes.');
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
          <input
            autoFocus
            className="prs-ws-search"
            aria-label="Workstream name"
            value={creating.name}
            disabled={busy}
            onChange={e => setCreating({ ...creating, name: e.target.value.trim() })}
            onKeyDown={e => {
              if (e.key === 'Escape') { e.stopPropagation(); setCreating(null); }
              else if (e.key === 'Enter') { e.preventDefault(); createNew(); }
            }}
          />
          {!valid && <div className="error-text prs-ws-scope">Letters, digits, dashes and underscores; not "main".</div>}
          <div className="usage-dim prs-ws-scope">
            {busy ? 'Checking the branch out on the box…' : 'Checks out the PR\'s branch (or adopts a worktree already on it), attaches the PR and opens the workstream.'}
          </div>
          <div className="prs-ws-actions">
            <button type="button" className="btn-primary btn-tiny" disabled={busy || !valid} onClick={createNew}>Create</button>
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
