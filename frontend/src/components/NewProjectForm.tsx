import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useProjects } from '../contexts/ProjectContext';
import { credentialsApi, instancesApi, projectsApi, warmPoolApi, ProjectTemplateInfo, WarmPoolStatus } from '../services/api';
import { CONNECT_GITHUB_TO_ADD_BOX, blocksManagedBox, type BoxGateState } from '../boxGate';
import type { Project } from '../types';
import { PROVIDERS, SELECTABLE_PROVIDER_IDS, isSelectableProvider } from '../providers/registry';
import { boxFeed } from '../services/boxFeed';
import { noteAddBoxClick, noteBoxClaimed, notePickerMounted, notePickerSubmitted, noteProjectCreated } from '../services/claimTiming';
import { FLAGS, useFlag } from '../flags';
import { BOX_NAME_ERROR, isValidBoxName } from '../utils/boxNames';
import { boxIsUsableForProject, funnyProjectName, pickDefaultBox } from '../utils/projectStart';
import { nameFromRepo } from '../utils/repoName';
import { createBody, sameRepoMatches, suggestedName, type RepoPick } from '../utils/repoPick';
import { boxIsSettling } from '../utils/boxFeed';
import { showsBoxError } from '../utils/boxPower';
import { RepoPicker } from './RepoPicker';

/**
 * The one "new project" form: what to start from (empty, a starter repo, or
 * any GitHub URL), a name, the agent, and the box it runs on, with a new box
 * created and awaited in place. The sidebar's New project dialog and the last
 * step of the /welcome wizard both render this, so the two cannot drift
 *.
 *
 * Boxes come from the shared box feed; whoever mounts this must have the feed
 * running (MainLayout does; Welcome starts it itself).
 */

const EMPTY = '__empty__';
const CUSTOM = '__custom__';
const NEW_BOX = '__new__';
const THIS_HOST = '__host__';

export interface NewProjectFormProps {
  onCreated: (project: Project) => void | Promise<void>;
  submitLabel?: string;
  /** Rendered before the submit button: Cancel, "Finish without a project". */
  actions?: React.ReactNode;
  autoFocus?: boolean;
  /**
   * Adding a managed box needs a stored GitHub token (boxGate). When blocked,
   * the form offers this instead of a link to Settings: the wizard sends the
   * user back to its GitHub step.
   */
  onGithubRequired?: () => void;
  initialBoxId?: string;
  onBranchOff?: (projectId: string) => void;
}

const EMPTY_PICK: RepoPick = { kind: 'empty' };

function pickIdentity(pick: RepoPick): string {
  switch (pick.kind) {
    case 'empty': return 'empty';
    case 'listed': return `listed:${pick.fullName}`;
    case 'starter': return `starter:${pick.templateId}`;
    case 'pasted': return 'pasted';
  }
}

function apiError(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
  return typeof msg === 'string' ? msg : fallback;
}

function status(s: string): string { return s.replace('-', ' '); }

export function NewProjectForm({ onCreated, submitLabel = 'Create project', actions, autoFocus, onGithubRequired, initialBoxId, onBranchOff }: NewProjectFormProps) {
  const { user } = useAuth();
  const { projects: contextProjects } = useProjects();
  const isAdmin = user?.role === 'admin';
  const pickerOn = useFlag(FLAGS.repoFirstPicker, false);
  const [fetchedProjects, setFetchedProjects] = useState<Project[] | null>(null);
  useEffect(() => {
    if (!pickerOn || contextProjects.length > 0) return;
    let cancelled = false;
    projectsApi.list()
      .then(list => { if (!cancelled) setFetchedProjects(list); })
      .catch(() => { if (!cancelled) setFetchedProjects([]); });
    return () => { cancelled = true; };
  }, [pickerOn, contextProjects.length]);
  const projects = contextProjects.length > 0 ? contextProjects : (fetchedProjects ?? []);
  const pickerNoted = useRef(false);
  useEffect(() => {
    if (!pickerOn || pickerNoted.current) return;
    pickerNoted.current = true;
    notePickerMounted();
  }, [pickerOn]);

  // ── Start from ──────────────────────────────────────────────────────────
  const [templates, setTemplates] = useState<ProjectTemplateInfo[]>([]);
  const [start, setStart] = useState<string>(EMPTY);
  const [customUrl, setCustomUrl] = useState('');
  const [pickerPick, setPickerPick] = useState<RepoPick>(EMPTY_PICK);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  useEffect(() => {
    if (pickerOn) return;
    projectsApi.templates().then(setTemplates).catch(() => {});
  }, [pickerOn]);
  const legacyRepoUrl = useMemo(() => {
    if (start === EMPTY) return '';
    if (start === CUSTOM) return customUrl.trim();
    return templates.find(t => t.id === start)?.repoUrl ?? '';
  }, [start, customUrl, templates]);
  const legacyPick = useMemo((): RepoPick => {
    if (start === EMPTY) return EMPTY_PICK;
    if (start === CUSTOM) return { kind: 'pasted', url: customUrl };
    return { kind: 'starter', templateId: start, url: legacyRepoUrl };
  }, [start, customUrl, legacyRepoUrl]);
  const pick = pickerOn ? pickerPick : legacyPick;
  function choosePick(next: RepoPick) {
    if (pickIdentity(pickerPick) !== pickIdentity(next)) setNameTouched(false);
    setPickerPick(next.kind === 'empty' ? EMPTY_PICK : next);
  }
  // The name follows the repo until the user edits it; an empty project gets
  // a fresh "proj-fuzzy-pants" so the field is never blank (and a different
  // one each time the start-from choice changes back to empty).
  useEffect(() => {
    if (nameTouched) return;
    if (!pickerOn) {
      setName(legacyRepoUrl ? nameFromRepo(legacyRepoUrl) : funnyProjectName());
      return;
    }
    const suggested = suggestedName(pickerPick);
    if (suggested) setName(suggested);
    else if (pickerPick.kind === 'empty') setName(funnyProjectName());
  }, [nameTouched, pickerOn, legacyRepoUrl, pickerPick]);

  // ── Agent ───────────────────────────────────────────────────────────────
  // A stored default that is no longer selectable (codex) must not leak into
  // a new project: fall back to the first selectable provider.
  const [provider, setProvider] = useState<string>(() =>
    isSelectableProvider(user?.defaultAgentProvider) ? user!.defaultAgentProvider : SELECTABLE_PROVIDER_IDS[0]);

  // ── Box ─────────────────────────────────────────────────────────────────
  const allBoxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  // False until the feed's first successful load: an empty list before that
  // means "not yet", not "no boxes". A failed first load must not leave the
  // picker stuck on "checking…": once the mount reload has settled either
  // way the form proceeds (with a note, and "a new box…" still available).
  const feedLoaded = useSyncExternalStore(boxFeed.subscribe, boxFeed.hasLoaded);
  const [reloadSettled, setReloadSettled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    boxFeed.reload().finally(() => { if (!cancelled) setReloadSettled(true); });
    return () => { cancelled = true; };
  }, []);
  const boxesLoaded = feedLoaded || reloadSettled;
  const boxesUnavailable = reloadSettled && !feedLoaded;
  const boxes = useMemo(() => allBoxes.filter(b => b.status !== 'terminated'), [allBoxes]);
  const usable = useMemo(() => boxes.filter(boxIsUsableForProject), [boxes]);
  // Chosen once, when the feed has answered: the first ready box, else one on
  // its way, else a new one. Committed to state so a later reload or reorder
  // cannot switch the box under the user (and a failure on the chosen one
  // stays visible instead of being silently skipped).
  const [boxChoice, setBoxChoice] = useState<string | null>(null);
  useEffect(() => {
    if (!boxesLoaded || boxChoice !== null) return;
    if (initialBoxId && boxes.some(b => b.id === initialBoxId)) {
      setBoxChoice(initialBoxId);
      return;
    }
    setBoxChoice(pickDefaultBox(usable)?.id ?? NEW_BOX);
  }, [boxesLoaded, boxChoice, usable, boxes, initialBoxId]);
  const choice = boxChoice ?? '';
  const chosenBox = boxes.find(b => b.id === choice) ?? null;
  const boxReady = choice === THIS_HOST || chosenBox?.status === 'ready';

  // Seeded once (RequireAuth guarantees user at mount); clearing it stays cleared.
  const [newBoxName, setNewBoxName] = useState(() => (user ? `${user.unixUsername}-box` : ''));
  // Derived from the name, so it clears as the user types and is gone once
  // the picker leaves "a new box…"; API failures are boxError and must not
  // keep the Create button disabled.
  const boxNameError = choice === NEW_BOX && newBoxName.trim() && !isValidBoxName(newBoxName.trim()) ? BOX_NAME_ERROR : '';
  const [boxBusy, setBoxBusy] = useState(false);
  const [boxError, setBoxError] = useState('');
  const [boxHint, setBoxHint] = useState('');
  // A managed box needs a stored GitHub token; the server enforces it too
  // (409 github-required) and the gate is re-read from that answer.
  const [boxGate, setBoxGate] = useState<BoxGateState | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    credentialsApi.get().then(c => { if (!cancelled) setBoxGate(c.github.boxGate); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const addBoxBlocked = blocksManagedBox(boxGate);

  const warmPoolEnabled = useFlag(FLAGS.warmPool, false);
  const [warmPool, setWarmPool] = useState<WarmPoolStatus | null>(null);
  useEffect(() => {
    if (!warmPoolEnabled || choice !== NEW_BOX) return;
    let cancelled = false;
    warmPoolApi.get().then(p => { if (!cancelled) setWarmPool(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [warmPoolEnabled, choice]);

  async function createBox() {
    const boxName = newBoxName.trim();
    if (!boxName || boxBusy || boxNameError || addBoxBlocked) return;
    setBoxBusy(true); setBoxError(''); setBoxHint('');
    noteAddBoxClick();
    try {
      const r = await instancesApi.create(boxName, 'ec2');
      // Into the list now, ahead of the feed's next poll: a claimed box is
      // already ready and the form should say so at once; a provisioning one
      // starts the feed polling.
      if (r.claimed) noteBoxClaimed(r.instance.id);
      boxFeed.upsert(r.instance);
      setBoxChoice(r.instance.id);
      if (r.hint) setBoxHint(r.hint);
      if (r.claimed) setBoxHint('A warm box was waiting — it is ready now.');
      // A list fetch that was in flight when the box was created (the mount
      // reload, a poll) would replace the list without it; fetch again so the
      // row is authoritative, not just painted.
      await boxFeed.reload();
    } catch (err) {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'github-required') setBoxGate('blocked');
      else setBoxError(apiError(err, 'Could not create the box'));
    } finally {
      setBoxBusy(false);
    }
  }

  // ── Submit ──────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const body = createBody(pick);
  const canSubmit = !busy && boxReady && !!name.trim() && body !== null;
  const matches = !choice || choice === NEW_BOX
    ? []
    : sameRepoMatches(pick, projects, choice === THIS_HOST ? null : choice);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !body) return;
    setBusy(true); setError('');
    const instanceId = choice === THIS_HOST ? null : chosenBox!.id;
    if (pickerOn && instanceId) notePickerSubmitted(instanceId);
    let project: Project;
    try {
      project = await projectsApi.create({
        name: name.trim(),
        instanceId,
        initialAgent: { enabled: true, provider },
        ...body,
      });
    } catch (err) {
      setError(apiError(err, 'Could not create the project'));
      setBusy(false);
      return;
    }
    if (project.instanceId) noteProjectCreated(project.id, project.instanceId);
    // The project exists now: a failure past this point must not read as
    // "could not create" and invite a retry that would duplicate it.
    try {
      await onCreated(project);
    } catch {
      setError(`Created "${project.name}", but could not open it. Find it in the project list.`);
      setBusy(false);
    }
  }

  return (
    <form className="npf" onSubmit={e => void submit(e)}>
      {pickerOn ? (
        <RepoPicker value={pickerPick} onChange={choosePick} autoFocus={autoFocus} />
      ) : (
        <>
          <div className="npf-field">
            <label htmlFor="npf-start">Start from</label>
            <select id="npf-start" value={start} autoFocus={autoFocus} onChange={e => { setStart(e.target.value); setNameTouched(false); }}>
              <option value={EMPTY}>empty — a fresh directory with AGENTS.md and CLAUDE.md</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.label} — {t.blurb}</option>)}
              <option value={CUSTOM}>custom — a GitHub repo URL</option>
            </select>
          </div>
          {start === CUSTOM && (
            <div className="npf-field">
              <label htmlFor="npf-url">Repository URL</label>
              <input id="npf-url" value={customUrl} onChange={e => setCustomUrl(e.target.value)} placeholder="https://github.com/owner/repo" />
            </div>
          )}
        </>
      )}
      <div className="npf-field">
        <label htmlFor="npf-name">Project name</label>
        <input id="npf-name" value={name} onChange={e => { setName(e.target.value); setNameTouched(true); }} placeholder="letters, digits, - and _" />
      </div>
      <div className="npf-field">
        <label htmlFor="npf-provider">Agent</label>
        <select id="npf-provider" value={provider} onChange={e => setProvider(e.target.value)}>
          {SELECTABLE_PROVIDER_IDS.map(id => <option key={id} value={id}>{PROVIDERS[id]?.displayName ?? id}</option>)}
        </select>
      </div>

      <div className="npf-field">
        <label htmlFor="npf-box">Box</label>
        <select id="npf-box" value={choice} disabled={!boxesLoaded} onChange={e => { setBoxChoice(e.target.value); setBoxError(''); setBoxHint(''); }}>
          {!boxesLoaded && <option value="">checking your boxes…</option>}
          {usable.map(b => <option key={b.id} value={b.id}>{b.name} · {status(b.status)}</option>)}
          {chosenBox && !boxIsUsableForProject(chosenBox) && (
            <option value={chosenBox.id}>{chosenBox.name} · {status(chosenBox.status)}</option>
          )}
          {/* The chosen box left the list entirely (terminated from the sidebar):
              keep the select consistent and let the user pick again. */}
          {boxesLoaded && choice && choice !== NEW_BOX && choice !== THIS_HOST && !chosenBox && (
            <option value={choice}>that box is gone — pick another</option>
          )}
          <option value={NEW_BOX}>{boxes.length ? 'a new box…' : 'a new box (none yet)…'}</option>
          {isAdmin && <option value={THIS_HOST}>this host (admin)</option>}
        </select>
      </div>
      {choice === NEW_BOX && (
        <div className="npf-field npf-inline">
          <label htmlFor="npf-box-name">New box name</label>
          <input
            id="npf-box-name"
            value={newBoxName}
            onChange={e => { setNewBoxName(e.target.value); setBoxError(''); }}
            placeholder="e.g. dev01"
            disabled={boxBusy}
          />
          <button type="button" className="btn-primary" onClick={() => void createBox()} disabled={boxBusy || !newBoxName.trim() || !!boxNameError || addBoxBlocked} title={addBoxBlocked ? CONNECT_GITHUB_TO_ADD_BOX : undefined}>
            {boxBusy ? 'Creating…' : 'Create box'}
          </button>
          {warmPoolEnabled && warmPool && (
            <span className="npf-note usage-dim">{warmPool.warm > 0 ? 'ready now' : 'a few minutes'}</span>
          )}
        </div>
      )}
      {choice === NEW_BOX && addBoxBlocked && (
        <div className="error-text">
          {onGithubRequired
            ? <>{CONNECT_GITHUB_TO_ADD_BOX.replace(' in Settings', '')}: <button type="button" className="recents-link" onClick={onGithubRequired}>back to the GitHub step</button></>
            : <Link to="/settings">{CONNECT_GITHUB_TO_ADD_BOX}</Link>}
        </div>
      )}
      {chosenBox && (
        <div className={`npf-box-status status-${chosenBox.status}`}>
          <strong>{chosenBox.name}</strong> · {status(chosenBox.status)}
          {/* Only states the feed keeps polling through change on their own; a
              stopped or hibernated box waits for a start. */}
          {boxIsSettling(chosenBox) && <span className="usage-dim"> — this updates on its own</span>}
          {/* failed, or a power error worth showing (a start whose agent never
              connected leaves the box `starting` with the error set). */}
          {(chosenBox.status === 'failed' || showsBoxError(chosenBox)) && chosenBox.provisioningError && (
            <div className="error-text">{chosenBox.provisioningError}</div>
          )}
          {!boxIsUsableForProject(chosenBox) && (
            <div className="usage-dim">
              Start it from the Boxes section of the workspace sidebar, or{' '}
              <button type="button" className="recents-link" onClick={() => { setBoxChoice(NEW_BOX); setBoxError(''); setBoxHint(''); }}>create a new one</button>.
            </div>
          )}
        </div>
      )}
      {boxesUnavailable && <div className="usage-dim npf-note">Could not load your boxes just now; you can still create a new one.</div>}
      {boxHint && <div className="usage-dim npf-note">{boxHint}</div>}
      {(boxNameError || boxError) && <div className="error-text">{boxNameError || boxError}</div>}

      {matches.map(project => (
        <div key={project.id} className="npf-note">
          <strong>{project.name}</strong> already checks out this repository. A workstream shares that checkout and is usually what you want.
          {onBranchOff && <button type="button" className="btn-ghost" onClick={() => onBranchOff(project.id)}>Branch off instead</button>}
        </div>
      ))}
      <div className="usage-dim npf-note">
        {body?.repoUrl
          ? <>The repo is fetched in the agent pane first, so you can watch it; the agent starts when the checkout is done.</>
          : <>An empty project with a seeded AGENTS.md and CLAUDE.md.</>}
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="npf-actions">
        {actions}
        <button type="submit" className="btn-primary" disabled={!canSubmit} title={!boxReady ? 'Waits for the box to be ready' : undefined}>
          {busy ? 'Creating…' : matches.length > 0 ? 'Create a second checkout' : submitLabel}
        </button>
      </div>
    </form>
  );
}
