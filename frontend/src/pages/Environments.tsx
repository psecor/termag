import React, { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useEnvironmentSelection } from '../hooks/useEnvironments';
import { environmentsApi, type EnvironmentEventView, type EnvironmentResolvedView, type EnvironmentView, type EnvironmentVisibility } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { useDefinitionCheck } from '../hooks/useDefinitionCheck';
import { useEnvironmentPool } from '../hooks/useEnvironmentPool';
import { poolFailureLine, poolLine, refreshLine } from '../utils/environmentPool';
import {
  ACTION_LABEL, DEFAULT_ENVIRONMENT_FILE, ENVIRONMENTS_DOCS_URL, describeEvent, draftFromEnvironment, draftInput,
  emptyEnvironmentDraft, environmentCommands, environmentError, personLabel, pointerLabel, repoLabel, shareBlocker, visibilityGroups,
  whenLabel, VISIBILITY_HINT, VISIBILITY_LABEL, type EnvironmentDraft,
} from '../utils/environments';

/**
 * Environments in the full UI, on the Automations
 * page's structure and classes (pages/Automations.tsx): `/environments` lists
 * every one, `/environments/new` makes one, `/environments/:id` is one
 * environment, editable in place, and `/environments/:id/history` is that
 * environment's history. An environment is an inline definition (checked on
 * blur and on save, never while typing) or a pointer to a file (repo : branch
 * : path), personal (its owner's alone) or shared (anyone's to see, use, edit
 * and delete, from a file on its repository's default branch): the list has
 * the caller's personal ones first, a new one is personal unless the form says
 * shared, and its owner switches it, the server's refusal saying the rule
 * when it can't be shared. Mounted
 * like Automations (no status socket, no heartbeat). The simple UI's section
 * is pages/chat/EnvironmentsPage.tsx, on the same API.
 */
export default function Environments({ history = false }: { history?: boolean }) {
  const { id } = useParams();
  const environmentsOn = useEnvironmentSelection();
  // environment-selection-enabled off: no Environments page, so a bookmark lands on the workspace.
  if (!environmentsOn) return <Navigate to="/" replace />;
  const title = id === 'new' ? 'New environment' : history ? 'Environment history' : id ? 'Environment' : 'Environments';
  return (
    <div className="dash-root">
      <div className="dash-page automations-page environments-page">
        <header className="dash-header">
          <h1>{title}</h1>
          <Link to="/">← workspace</Link>
          {id && <Link to="/environments">all environments</Link>}
          {id && history && <Link to={`/environments/${encodeURIComponent(id)}`}>this environment</Link>}
          {ENVIRONMENTS_DOCS_URL && <a href={ENVIRONMENTS_DOCS_URL} target="_blank" rel="noopener noreferrer">about</a>}
        </header>
        {id === 'new' ? <EnvironmentNew /> : id && history ? <EnvironmentHistory id={id} /> : id ? <EnvironmentDetail id={id} /> : <EnvironmentIndex />}
      </div>
    </div>
  );
}

function EnvironmentIndex() {
  const [list, setList] = useState<EnvironmentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    environmentsApi.list()
      .then(l => { if (!cancelled) setList(l); })
      .catch(err => { if (!cancelled) setError(environmentError(err, 'Could not load environments')); });
    return () => { cancelled = true; };
  }, []);
  return (
    <>
      <section className="dash-card">
        <div className="auto-actions"><Link className="btn-primary" to="/environments/new">New environment</Link></div>
        {error && <p className="error-text">{error}</p>}
        {list && list.length === 0 && <p className="usage-dim">No environments yet.</p>}
      </section>
      {list && visibilityGroups(list).map(g => (
        <section key={g.visibility} className="dash-card" aria-label={g.label}>
          <div className="dash-card-head"><span>{g.label}</span><span className="usage-dim">{VISIBILITY_HINT[g.visibility]}</span></div>
          <ul className="auto-list">
            {g.items.map(e => (
              <li key={e.id}>
                <Link className="auto-row" to={`/environments/${encodeURIComponent(e.id)}`}>
                  <span className="auto-name">{e.name}</span>
                  <span className="auto-sub">{e.kind === 'pointer' ? pointerLabel(e.file) : 'inline'}</span>
                  <span className="auto-sub">{whenLabel(e.updatedAt)} · {personLabel(e.updatedBy)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function EnvironmentNew() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<EnvironmentDraft>(emptyEnvironmentDraft);
  const [visibility, setVisibility] = useState<EnvironmentVisibility>('personal');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useDefinitionCheck(draft.definition, draft.kind === 'inline');
  const blocked = visibility === 'shared' ? shareBlocker(draft) : null;
  const save = async () => {
    setError(null);
    if (!draft.name.trim()) { setError('Give it a name'); return; }
    if (blocked) { setError(blocked); return; }
    // Busy from the click, so a second one while the definition is checked doesn't write twice.
    setBusy(true);
    if (!await check.check()) { setBusy(false); return; }
    try {
      const created = await environmentsApi.create(draftInput(draft), visibility);
      navigate(`/environments/${encodeURIComponent(created.id)}`, { replace: true });
    } catch (err) {
      setError(environmentError(err, 'Could not create the environment'));
      setBusy(false);
    }
  };
  return (
    <section className="dash-card auto-edit">
      <EnvironmentForm draft={draft} onChange={setDraft} check={check} />
      <div className="npf-field">
        <label>Who can use it</label>
        {(['personal', 'shared'] as const).map(v => (
          <label key={v} className="npf-check">
            <input type="radio" name="env-visibility" checked={visibility === v} onChange={() => setVisibility(v)} /> {VISIBILITY_LABEL[v]}: {VISIBILITY_HINT[v]}
          </label>
        ))}
        {blocked && <div className="error-text">{blocked}</div>}
      </div>
      {error && error !== blocked && <p className="error-text">{error}</p>}
      <div className="auto-actions">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Creating…' : 'Create environment'}</button>
        <Link className="btn-ghost" to="/environments">Cancel</Link>
      </div>
    </section>
  );
}

function EnvironmentDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [env, setEnv] = useState<EnvironmentView | null>(null);
  const [resolved, setResolved] = useState<EnvironmentResolvedView | null>(null);
  const pool = useEnvironmentPool(id);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<EnvironmentDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useDefinitionCheck(draft?.definition ?? '', draft?.kind === 'inline');

  const load = useCallback(async () => {
    try {
      setEnv(await environmentsApi.get(id));
      setLoadError(null);
      environmentsApi.resolved(id).then(setResolved).catch(() => setResolved(null));
    } catch (err) {
      setLoadError(environmentError(err, 'Could not load this environment'));
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (loadError && !env) return <section className="dash-card"><p className="error-text">{loadError}</p></section>;
  if (!env) return <section className="dash-card"><p className="usage-dim">Loading…</p></section>;

  const save = async () => {
    if (!draft) return;
    setError(null);
    if (!draft.name.trim()) { setError('Give it a name'); return; }
    setBusy(true);
    if (!await check.check()) { setBusy(false); return; }
    try {
      await environmentsApi.update(env.id, draftInput(draft), env.updatedAt);
      setDraft(null);
      await load();
    } catch (err) {
      setError(environmentError(err, 'Could not save the environment'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const gone = env.visibility === 'shared' ? 'It is gone for everyone; projects' : 'Projects';
    if (!window.confirm(`Delete ${env.name}? ${gone} made from it keep their repositories.`)) return;
    setBusy(true); setError(null);
    try {
      await environmentsApi.remove(env.id, env.updatedAt);
      navigate('/environments');
    } catch (err) {
      setError(environmentError(err, 'Could not delete the environment'));
      setBusy(false);
    }
  };

  // The owner's switch. Sharing asks the server, whose refusal says the rule (a file on the repository's default branch).
  const switchTo = async (to: EnvironmentVisibility) => {
    setBusy(true); setError(null);
    try {
      setEnv(await environmentsApi.setVisibility(env.id, to, env.updatedAt));
    } catch (err) {
      setError(environmentError(err, to === 'shared' ? 'Could not share the environment' : 'Could not make the environment personal'));
    } finally {
      setBusy(false);
    }
  };
  const isOwner = !!user && env.owner?.id === user.id;

  return (
    <section className="dash-card">
      <div className="dash-card-head">
        <span>{env.name}</span>
        <span className="usage-dim">{VISIBILITY_LABEL[env.visibility].toLowerCase()}, {isOwner ? 'yours' : `${personLabel(env.owner)}'s`} · {env.kind === 'pointer' ? 'file' : 'inline'} · edited {whenLabel(env.updatedAt)} by {personLabel(env.updatedBy)}</span>
      </div>
      {draft ? (
        <div className="auto-edit">
          <EnvironmentForm draft={draft} onChange={setDraft} check={check} />
          <div className="auto-actions">
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => { setDraft(null); setError(null); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          <div className="auto-actions">
            <button type="button" className="btn-primary" onClick={() => setDraft(draftFromEnvironment(env))}>Edit</button>
            <Link className="btn-ghost" to={`/environments/${encodeURIComponent(env.id)}/history`}>History</Link>
            {isOwner && (env.visibility === 'personal'
              ? <button type="button" className="btn-ghost" disabled={busy} title="Runs from a file on its repository's default branch" onClick={() => void switchTo('shared')}>Share with everyone</button>
              : <button type="button" className="btn-ghost" disabled={busy} title="Only you see it and use it" onClick={() => void switchTo('personal')}>Make personal</button>)}
            <button type="button" className="btn-ghost menu-danger" disabled={busy} onClick={() => void remove()}>Delete</button>
          </div>
          <dl className="auto-facts usage-dim">
            {env.kind === 'pointer'
              ? <div><dt>File</dt><dd><code>{pointerLabel(env.file)}</code></dd></div>
              : <div><dt>Definition</dt><dd><pre className="auto-memory">{JSON.stringify(env.definition, null, 2)}</pre></dd></div>}
            {resolved && (
              <div><dt>Repositories</dt><dd>{resolved.repos.map(r => <div key={r.repo}><code>{repoLabel(r)}</code></div>)}
                {resolved.warnings.map((w, i) => <div key={i} className="error-text">{w}</div>)}</dd></div>
            )}
            {pool && (
              <div><dt>Pool</dt><dd>
                {poolLine(pool).text}{poolLine(pool).commit && <> <code>{poolLine(pool).commit}</code></>}
                {refreshLine(pool) && <div className="usage-dim">{refreshLine(pool)}</div>}
                {pool.lastFailure && <div className="error-text">{poolFailureLine(pool.lastFailure.at)}</div>}
                {pool.lastFailure?.log && <pre className="auto-memory">{pool.lastFailure.log}</pre>}
              </dd></div>
            )}
            <div><dt>CLI</dt><dd>{environmentCommands(env.name).map(c => <div key={c}><code>{c}</code></div>)}</dd></div>
          </dl>
        </>
      )}
      {error && <p className="error-text">{error}</p>}
    </section>
  );
}

/** One environment's history, newest first, in the automation page's table. */
function EnvironmentHistory({ id }: { id: string }) {
  const [events, setEvents] = useState<EnvironmentEventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    environmentsApi.events(id)
      .then(l => { if (!cancelled) setEvents(l); })
      .catch(err => { if (!cancelled) setError(environmentError(err, 'Could not load its history')); });
    return () => { cancelled = true; };
  }, [id]);
  return (
    <section className="dash-card">
      <div className="dash-card-head"><span>{events?.[0]?.environmentName ?? 'History'}</span><span className="usage-dim">every change, newest first</span></div>
      {error && <p className="error-text">{error}</p>}
      {events && events.length === 0 && <p className="usage-dim">No changes yet.</p>}
      {events && events.length > 0 && (
        <table className="auto-table">
          <thead><tr><th>When</th><th>Who</th><th>What</th><th>Changes</th></tr></thead>
          <tbody>
            {events.map(e => (
              <tr key={e.id}>
                <td>{whenLabel(e.at)}</td>
                <td>{personLabel(e.actor)}</td>
                <td>{ACTION_LABEL[e.action]}</td>
                <td>{describeEvent(e).map((line, i) => <div key={i}>{line}</div>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The name, then an inline definition (JSON) or a pointer (repo, branch, path), as the app's plain fields. */
function EnvironmentForm({ draft, onChange, check }: { draft: EnvironmentDraft; onChange: (d: EnvironmentDraft) => void; check: ReturnType<typeof useDefinitionCheck> }) {
  return (
    <>
      <div className="npf-field">
        <label htmlFor="env-name">Name</label>
        <input id="env-name" value={draft.name} onChange={e => onChange({ ...draft, name: e.target.value })} placeholder="full-stack" />
      </div>
      <div className="npf-field">
        <label>Definition</label>
        <label className="npf-check"><input type="radio" name="env-kind" checked={draft.kind === 'inline'} onChange={() => onChange({ ...draft, kind: 'inline', definition: draft.definition || emptyEnvironmentDraft().definition })} /> Inline JSON</label>
        <label className="npf-check"><input type="radio" name="env-kind" checked={draft.kind === 'pointer'} onChange={() => onChange({ ...draft, kind: 'pointer' })} /> File in a repository</label>
      </div>
      {draft.kind === 'inline' ? (
        <div className="npf-field af-prompt">
          <label htmlFor="env-definition">environment.json</label>
          <textarea id="env-definition" rows={14} spellCheck={false} value={draft.definition} onChange={e => onChange({ ...draft, definition: e.target.value })} onBlur={check.onBlur} />
          {check.errors.map((e, i) => <div key={i} className="error-text">{e}</div>)}
        </div>
      ) : (
        <>
          <div className="npf-field"><label htmlFor="env-file-repo">Repository</label><input id="env-file-repo" value={draft.fileRepo} onChange={e => onChange({ ...draft, fileRepo: e.target.value })} placeholder="owner/name" /></div>
          <div className="npf-field"><label htmlFor="env-file-branch">Branch</label><input id="env-file-branch" value={draft.fileBranch} onChange={e => onChange({ ...draft, fileBranch: e.target.value })} placeholder="default branch" /></div>
          <div className="npf-field"><label htmlFor="env-file-path">Path</label><input id="env-file-path" value={draft.filePath} onChange={e => onChange({ ...draft, filePath: e.target.value })} placeholder={DEFAULT_ENVIRONMENT_FILE} /></div>
        </>
      )}
    </>
  );
}
