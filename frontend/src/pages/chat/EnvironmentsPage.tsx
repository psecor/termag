// Environments in the simple UI, laid out as the
// automation page is (pages/chat/automations/AutomationDetail.tsx): the chat
// header with its title, one primary action and the ⋮ menu, then cards on the
// transcript's width. /chat/environments lists every one,
// /chat/environments/new makes one, /chat/environments/:id is one environment
// (New session; Edit, History, Delete… in the menu) and
// /chat/environments/:id/history is that environment's history. An
// environment is an inline definition (environment.json's JSON, in
// LaunchPad's TextArea, which has no schema completion; it is checked on blur
// and on save, never while typing) or a pointer to a file, repo : branch :
// path. Each is personal (its owner's alone) or shared (everyone's, from a
// file on its repository's default branch): the list has the caller's
// personal ones first, a new one is personal unless the form says shared, and
// its owner switches it from the ⋮ menu, which shows the server's rule when it
// can't be shared. The full UI's section is pages/Environments.tsx, on the
// same API and utils/environments.ts.
import React, { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useEnvironmentSelection } from '../../hooks/useEnvironments';
import { Button, Input, Label, Radio, RadioGroup, Text, TextArea, TextField } from '@launchpad-ui/components';
import { environmentsApi, type EnvironmentEventView, type EnvironmentResolvedView, type EnvironmentView, type EnvironmentVisibility } from '../../services/api';
import { useAuth } from '../../contexts/AuthContext';
import { LP_THEME } from '../../launchpad/theme';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useDefinitionCheck } from '../../hooks/useDefinitionCheck';
import { useEnvironmentPool } from '../../hooks/useEnvironmentPool';
import { poolFailureLine, poolLine, POOL_READY_HINT, refreshLine } from '../../utils/environmentPool';
import {
  ACTION_LABEL, DEFAULT_ENVIRONMENT_FILE, ENVIRONMENTS_DOCS_URL, describeEvent, draftFromEnvironment, draftInput,
  emptyEnvironmentDraft, environmentCommands, environmentError, personLabel, pointerLabel, repoLabel, shareBlocker, visibilityGroups,
  whenLabel, VISIBILITY_HINT, VISIBILITY_LABEL, type EnvironmentDraft,
} from '../../utils/environments';
import type { MenuAction } from './ContextMenu';
import { ChatHistoryButton, ChatMoreButton } from './chatChrome';
import { ChatError } from './TranscriptNotices';
import './automations/automations.css';

const openDocs = () => { window.open(ENVIRONMENTS_DOCS_URL, '_blank', 'noopener,noreferrer'); };

export function EnvironmentsPage({ history = false }: { history?: boolean }) {
  const { id } = useParams();
  const environmentsOn = useEnvironmentSelection();
  // environment-selection-enabled off: no Environments section, so a bookmark lands on New session.
  if (!environmentsOn) return <Navigate to="/chat" replace />;
  if (id === 'new') return <NewEnvironment />;
  if (id && history) return <EnvironmentHistory key={id} id={id} />;
  if (id) return <EnvironmentDetail key={id} id={id} />;
  return <EnvironmentList />;
}

/** The chat header and the cards under it, as the automation page has them. */
function Page({ title, chip, actions, children }: { title: string; chip?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={`chat-view ${LP_THEME}`}>
      <section className="chat-conv">
        <header className="chat-header">
          <ChatHistoryButton />
          <div className="chat-title">
            <span className="chat-title-name">{title}</span>
            {chip}
          </div>
          {actions && <div className="chat-header-actions">{actions}</div>}
        </header>
        <div className="chat-auto-page">{children}</div>
      </section>
    </div>
  );
}

function EnvironmentList() {
  const navigate = useNavigate();
  const [list, setList] = useState<EnvironmentView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    environmentsApi.list().then(l => { setList(l); setError(null); }).catch(err => setError(environmentError(err, 'Could not load environments')));
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <Page
      title="Environments"
      actions={<>
        <Button variant="primary" size="small" onPress={() => navigate('/chat/environments/new')}>New environment</Button>
        <ChatMoreButton label="Environments: actions" actions={ENVIRONMENTS_DOCS_URL ? [{ label: 'About environments', onSelect: openDocs }] : []} />
      </>}
    >
      {(error || list === null || list.length === 0) && (
        <div className="chat-auto-card" role="region" aria-label="Environments">
          {error && <ChatError text={error} onRetry={load} />}
          {list === null ? (!error && <p className="chat-auto-dim">Loading…</p>)
            : list.length === 0 && <p className="chat-auto-dim">No environments yet.</p>}
        </div>
      )}
      {list && visibilityGroups(list).map(g => (
        <div key={g.visibility} className="chat-auto-card" role="region" aria-label={g.label}>
          <h2>{g.label}</h2>
          <p className="chat-auto-dim">{VISIBILITY_HINT[g.visibility]}</p>
          <ul className="chat-auto-runs">
            {g.items.map(e => (
              <li key={e.id} className="chat-auto-item">
                <Link className="chat-auto-link" to={`/chat/environments/${encodeURIComponent(e.id)}`}>
                  <span className="chat-auto-line">
                    <span className="chat-auto-name">{e.name}</span>
                    <span className="chat-auto-state">{e.kind === 'pointer' ? 'File' : 'Inline'}</span>
                  </span>
                  <span className="chat-auto-sub">{e.kind === 'pointer' ? pointerLabel(e.file) : 'Inline definition'} · {whenLabel(e.updatedAt)} · {personLabel(e.updatedBy)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Page>
  );
}

function NewEnvironment() {
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
      navigate(`/chat/environments/${encodeURIComponent(created.id)}`, { replace: true });
    } catch (err) {
      setError(environmentError(err, 'Could not create the environment'));
      setBusy(false);
    }
  };
  return (
    <Page title="New environment">
      <div className="chat-auto-card">
        <EnvironmentFields draft={draft} onChange={setDraft} disabled={busy} check={check} />
        <RadioGroup value={visibility} onChange={v => setVisibility(v as EnvironmentVisibility)} isDisabled={busy} className="chat-env-visibility">
          <Label>Who can use it</Label>
          <Radio value="personal">{VISIBILITY_LABEL.personal}: {VISIBILITY_HINT.personal}</Radio>
          <Radio value="shared">{VISIBILITY_LABEL.shared}: {VISIBILITY_HINT.shared}</Radio>
          {blocked && <Text slot="description" className="chat-env-error">{blocked}</Text>}
        </RadioGroup>
        {error && error !== blocked && <ChatError text={error} />}
        <div className="chat-env-actions">
          <Button size="small" onPress={() => navigate('/chat/environments')}>Cancel</Button>
          <Button variant="primary" size="small" isDisabled={busy} onPress={() => void save()}>{busy ? 'Creating…' : 'Create environment'}</Button>
        </div>
      </div>
    </Page>
  );
}

function EnvironmentDetail({ id }: { id: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [env, setEnv] = useState<EnvironmentView | null>(null);
  const [resolved, setResolved] = useState<EnvironmentResolvedView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<EnvironmentDraft | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
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

  if (!env) {
    return (
      <Page title="Environment">
        <div className="chat-auto-card">{loadError ? <ChatError text={loadError} onRetry={() => { void load(); }} /> : <p className="chat-auto-dim">Loading…</p>}</div>
      </Page>
    );
  }

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
    setBusy(true); setError(null);
    try {
      await environmentsApi.remove(env.id, env.updatedAt);
      navigate('/chat/environments');
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
  const switchAction: MenuAction[] = !isOwner ? []
    : env.visibility === 'personal'
      ? [{ label: 'Share with everyone', hint: "Runs from a file on its repository's default branch", onSelect: () => { void switchTo('shared'); }, disabled: busy || !!draft }]
      : [{ label: 'Make personal', hint: 'Only you see it and use it', onSelect: () => { void switchTo('personal'); }, disabled: busy || !!draft }];

  const menu: MenuAction[] = [
    { label: 'Edit', onSelect: () => { setDraft(draftFromEnvironment(env)); setError(null); }, disabled: busy || !!draft },
    ...switchAction,
    { label: 'History', hint: 'Every change, who made it and when', onSelect: () => navigate(`/chat/environments/${encodeURIComponent(env.id)}/history`) },
    ...(ENVIRONMENTS_DOCS_URL ? [{ label: 'About environments', onSelect: openDocs }] : []),
    { label: 'Delete…', onSelect: () => setConfirmDelete(true), disabled: busy },
  ];

  return (
    <Page
      title={env.name}
      chip={<>
        <span className="chat-auto-state">{VISIBILITY_LABEL[env.visibility]}</span>
        <span className="chat-auto-state">{env.kind === 'pointer' ? 'File' : 'Inline'}</span>
      </>}
      actions={<>
        <Button variant="primary" size="small" isDisabled={!!draft} onPress={() => navigate(`/chat/new?environment=${encodeURIComponent(env.name)}`, { state: { environment: env } })}>New session</Button>
        <ChatMoreButton label={`${env.name}: actions`} actions={menu} />
      </>}
    >
      {error && <div className="chat-auto-card"><ChatError text={error} /></div>}
      {draft ? (
        <div className="chat-auto-card">
          <EnvironmentFields draft={draft} onChange={setDraft} disabled={busy} check={check} />
          <div className="chat-env-actions">
            <Button size="small" isDisabled={busy} onPress={() => { setDraft(null); setError(null); }}>Cancel</Button>
            <Button variant="primary" size="small" isDisabled={busy} onPress={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
          </div>
        </div>
      ) : (
        <>
          <div className="chat-auto-card">
            <h2>{env.kind === 'pointer' ? 'File' : 'Definition'}</h2>
            {env.kind === 'pointer'
              ? <code>{pointerLabel(env.file)}</code>
              : <pre className="chat-auto-prompt chat-env-definition">{JSON.stringify(env.definition, null, 2)}</pre>}
            <p className="chat-auto-dim">Edited {whenLabel(env.updatedAt)} by {personLabel(env.updatedBy)}</p>
            <p className="chat-auto-dim">
              {VISIBILITY_LABEL[env.visibility]}, {isOwner ? 'yours' : `${personLabel(env.owner)}'s`}. {env.visibility === 'shared' ? VISIBILITY_HINT.shared : 'Only its owner sees it and uses it'}.
            </p>
          </div>
          <EnvironmentPoolCard id={env.id} />
          {resolved && (
            <div className="chat-auto-card">
              <h2>Repositories</h2>
              <ul className="chat-env-lines">{resolved.repos.map(r => <li key={r.repo}><code>{repoLabel(r)}</code></li>)}</ul>
              {resolved.warnings.map((w, i) => <ChatError key={i} text={w} />)}
            </div>
          )}
          <div className="chat-auto-card">
            <h2>From the CLI</h2>
            <ul className="chat-env-lines">{environmentCommands(env.name).map(c => <li key={c}><code>{c}</code></li>)}</ul>
          </div>
        </>
      )}
      {confirmDelete && (
        <ConfirmDialog
          message={env.visibility === 'shared'
            ? `Delete ${env.name}? It is gone for everyone; projects made from it keep their repositories.`
            : `Delete ${env.name}? Projects made from it keep their repositories.`}
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { setConfirmDelete(false); void remove(); }}
        />
      )}
    </Page>
  );
}

/**
 * Its environment pool: how many boxes are ready, when the newest was
 * prepared and at which commit, when they are next checked for a refresh, and the last prepare failure with its log.
 * Nothing when it has no pool.
 */
export function EnvironmentPoolCard({ id }: { id: string }) {
  const pool = useEnvironmentPool(id);
  if (!pool) return null;
  const line = poolLine(pool);
  const refresh = refreshLine(pool);
  return (
    <div className="chat-auto-card chat-env-pool">
      <h2>Pool</h2>
      <p>{line.text}{line.commit && <> <code>{line.commit}</code></>}</p>
      {refresh && <p className="chat-auto-dim chat-env-pool-refresh" title="Boxes whose default branches moved are started, pulled, set up again and stopped; the rest are left as they are">{refresh}</p>}
      <p className="chat-auto-dim">Stopped boxes with its setup already run: a new session starts one ({POOL_READY_HINT}), then pulls and runs it as you.</p>
      {pool.lastFailure && (
        <>
          <ChatError text={poolFailureLine(pool.lastFailure.at)} />
          {pool.lastFailure.log && <pre className="chat-auto-prompt chat-env-pool-log">{pool.lastFailure.log}</pre>}
        </>
      )}
    </div>
  );
}

/** One environment's history, newest first, as the automation page lists its runs. */
function EnvironmentHistory({ id }: { id: string }) {
  const navigate = useNavigate();
  const [name, setName] = useState<string | null>(null);
  const [events, setEvents] = useState<EnvironmentEventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    environmentsApi.events(id)
      .then(l => { setEvents(l); setError(null); setName(l[0]?.environmentName ?? null); })
      .catch(err => setError(environmentError(err, 'Could not load its history')));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  return (
    <Page
      title={name ? `${name} · History` : 'History'}
      actions={<Button size="small" onPress={() => navigate(`/chat/environments/${encodeURIComponent(id)}`)}>Back</Button>}
    >
      <div className="chat-auto-card" role="region" aria-label="History">
        {error && <ChatError text={error} onRetry={load} />}
        {events === null ? (!error && <p className="chat-auto-dim">Loading…</p>)
          : events.length === 0 ? <p className="chat-auto-dim">No changes yet.</p>
          : (
            <ul className="chat-auto-runs">
              {events.map(e => (
                <li key={e.id} className="chat-auto-item">
                  <div className="chat-auto-link">
                    <span className="chat-auto-line">
                      <span className="chat-auto-name">{ACTION_LABEL[e.action]}</span>
                      <span className="chat-auto-took chat-auto-dim">{whenLabel(e.at)} · {personLabel(e.actor)}</span>
                    </span>
                    {describeEvent(e).map((line, i) => <span key={i} className="chat-auto-sub chat-env-change">{line}</span>)}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </div>
    </Page>
  );
}

/** The name, then an inline definition (JSON) or a pointer (repo, branch, path), as LaunchPad fields. */
function EnvironmentFields({ draft, onChange, disabled, check }: {
  draft: EnvironmentDraft;
  onChange: (d: EnvironmentDraft) => void;
  disabled?: boolean;
  check: ReturnType<typeof useDefinitionCheck>;
}) {
  return (
    <div className="chat-env-form">
      <TextField value={draft.name} onChange={name => onChange({ ...draft, name })} isDisabled={disabled}>
        <Label>Name</Label>
        <Input placeholder="full-stack" spellCheck={false} />
      </TextField>
      <RadioGroup
        value={draft.kind}
        onChange={v => onChange({ ...draft, kind: v as EnvironmentDraft['kind'], definition: draft.definition || emptyEnvironmentDraft().definition })}
        isDisabled={disabled}
        orientation="horizontal"
      >
        <Label>Definition</Label>
        <Radio value="inline">Inline JSON</Radio>
        <Radio value="pointer">File in a repository</Radio>
      </RadioGroup>
      {draft.kind === 'inline' ? (
        <TextField value={draft.definition} onChange={definition => onChange({ ...draft, definition })} onBlur={check.onBlur} isDisabled={disabled} isInvalid={check.errors.length > 0} className="chat-env-json">
          <Label>environment.json</Label>
          <TextArea rows={14} spellCheck={false} />
          {check.errors.map((e, i) => <Text key={i} slot="errorMessage" className="chat-env-error">{e}</Text>)}
        </TextField>
      ) : (
        <div className="chat-env-pointer">
          <TextField value={draft.fileRepo} onChange={fileRepo => onChange({ ...draft, fileRepo })} isDisabled={disabled}>
            <Label>Repository</Label>
            <Input placeholder="owner/name" spellCheck={false} />
          </TextField>
          <TextField value={draft.fileBranch} onChange={fileBranch => onChange({ ...draft, fileBranch })} isDisabled={disabled}>
            <Label>Branch</Label>
            <Input placeholder="default branch" spellCheck={false} />
          </TextField>
          <TextField value={draft.filePath} onChange={filePath => onChange({ ...draft, filePath })} isDisabled={disabled}>
            <Label>Path</Label>
            <Input placeholder={DEFAULT_ENVIRONMENT_FILE} spellCheck={false} />
          </TextField>
        </div>
      )}
    </div>
  );
}
