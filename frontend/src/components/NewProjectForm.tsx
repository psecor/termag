import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useProjects } from '../contexts/ProjectContext';
import { automationsApi, credentialsApi, instancesApi, projectsApi, warmPoolApi, ProjectTemplateInfo, WarmPoolStatus } from '../services/api';
import { AutomationFields, draftBody, draftCron, emptyDraft, type AutomationDraft } from './AutomationFields';
import { CONNECT_GITHUB_TO_ADD_BOX, blocksManagedBox, type BoxGateState } from '../boxGate';
import type { Instance, Project } from '../types';
import { PROVIDERS, SELECTABLE_PROVIDER_IDS, isSelectableProvider } from '../providers/registry';
import { useBackendChoices } from '../providers/useBackendChoices';
import { BackendModelFields, offeredChoice } from './BackendModelFields';
import { boxFeed } from '../services/boxFeed';
import { noteAddBoxClick, noteBoxClaimed, notePickerMounted, notePickerSubmitted, noteProjectCreated } from '../services/claimTiming';
import { FLAGS, useFlag } from '../flags';
import { BOX_NAME_ERROR, isValidBoxName } from '../utils/boxNames';
import {
  boxNameConflictMessage,
  boxNameFromProject,
  boxNameTaken,
  projectNameError,
} from '../utils/newProjectBox';
import { boxIsUsableForProject, funnyProjectName, isBoxFailedRefusal, pickDefaultBox, unusableBoxAdvice } from '../utils/projectStart';
import { nameFromRepo } from '../utils/repoName';
import { createBody, sameRepoMatches, suggestedName, type RepoPick } from '../utils/repoPick';
import { boxIsSettling } from '../utils/boxFeed';
import { showsBoxError } from '../utils/boxPower';
import { RepoPicker } from './RepoPicker';
import { replaySessionId } from '../observability';

/**
 * The one "new project" form: what to start from (empty, a starter repo, or
 * any GitHub URL), a name, the agent, and the box it runs on. A new box and
 * the project are asked for in one submit: the project waits on the server
 * while the box boots and is set up when the box's agent connects, so the
 * tab can close. The sidebar's New project dialog and the last
 * step of the /welcome wizard both render this, so the two cannot drift
 *.
 *
 * With the repository picker on, the open form is the repository list and
 * Create. Name, paste, agent, and box choice sit under Advanced settings.
 * That path provisions a new managed box named after the project, unless the
 * user picked an existing box (or the dialog was opened for one).
 *
 * Boxes come from the shared box feed; whoever mounts this must have the feed
 * running (MainLayout does; Welcome starts it itself).
 */

const EMPTY = '__empty__';
const CUSTOM = '__custom__';
const NEW_BOX = '__new__';
const THIS_HOST = '__host__';

/** What the form creates: a project, or an automation, a project the scheduler runs. */
export type NewProjectMode = 'project' | 'automation';

export interface NewProjectFormProps {
  onCreated: (project: Project) => void | Promise<void>;
  /**
   * `automation`: the repository, name and box fields stay; the agent is
   * fixed (Claude in the chat runner) and the schedule, prompt and run
   * settings appear; submit posts to /api/automations.
   */
  mode?: NewProjectMode;
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

export function NewProjectForm({ onCreated, submitLabel = 'Create project', actions, autoFocus, onGithubRequired, initialBoxId, onBranchOff, mode = 'project' }: NewProjectFormProps) {
  const automation = mode === 'automation';
  const [draft, setDraft] = useState<AutomationDraft>(emptyDraft);
  // The full tier is the owner's trust tick (it sets chatTrustedAt): Create waits for the checkbox AutomationFields shows for it.
  const [fullTierTicked, setFullTierTicked] = useState(false);
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
  // Set when the user picks a box, or when this submit has created one, so a
  // later feed reload cannot put the default back (and a refused project is
  // retried on the box just created).
  const boxChoiceTouched = useRef(false);
  const advancedRef = useRef<HTMLDetailsElement>(null);
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
  // The model backend the agent runs on and the model it starts on;
  // null is the default. Both go back to the default
  // whenever the agent changes.
  const backendChoices = useBackendChoices(provider);
  const [backend, setBackend] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const chosen = offeredChoice(backendChoices, backend, model);

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
  // Until the user picks, the picker path starts a new box. The flag-off form
  // still prefers a ready box, and keeps that choice across reloads. An
  // initialBoxId (Pick a repository) is an explicit box and wins on both.
  const [boxChoice, setBoxChoice] = useState<string | null>(null);
  useEffect(() => {
    if (!boxesLoaded || boxChoiceTouched.current) return;
    if (initialBoxId && boxes.some(b => b.id === initialBoxId)) {
      setBoxChoice(initialBoxId);
      return;
    }
    if (pickerOn) {
      setBoxChoice(NEW_BOX);
      return;
    }
    setBoxChoice(prev => prev ?? (pickDefaultBox(usable)?.id ?? NEW_BOX));
  }, [boxesLoaded, usable, boxes, initialBoxId, pickerOn]);
  const choice = boxChoice ?? '';
  const chosenBox = boxes.find(b => b.id === choice) ?? null;
  const boxReady = choice === THIS_HOST || chosenBox?.status === 'ready';
  // The server holds a project for a box on its way up (waitsForBoxAgent).
  const boxBooting = chosenBox?.status === 'provisioning' || chosenBox?.status === 'awaiting-agent';
  const waitingOnBox = useMemo(
    () => (chosenBox ? contextProjects.filter(p => p.instanceId === chosenBox.id && !p.archived) : []),
    [chosenBox, contextProjects],
  );
  const boxAdvice = chosenBox ? unusableBoxAdvice(chosenBox, waitingOnBox.length) : null;

  // null follows the default: the project name on the picker path, else
  // "<unix user>-box". A string, including "", is what the user typed.
  const [boxNameOverride, setBoxNameOverride] = useState<string | null>(null);
  const legacyBoxName = user ? `${user.unixUsername}-box` : '';
  const newBoxName = boxNameOverride !== null
    ? boxNameOverride
    : (pickerOn ? boxNameFromProject(name) : legacyBoxName);
  const nameError = projectNameError(name);
  // An illegal box name clears as the user types. API failures are boxError
  // and must not keep Create disabled on their own.
  const boxNameError = choice === NEW_BOX && newBoxName.trim() && !isValidBoxName(newBoxName.trim()) ? BOX_NAME_ERROR : '';
  const takenBox = choice === NEW_BOX ? boxNameTaken(newBoxName, boxes) : undefined;
  const conflictError = takenBox ? boxNameConflictMessage(newBoxName.trim()) : '';
  useEffect(() => {
    if (!pickerOn || (!conflictError && !nameError)) return;
    if (advancedRef.current && !advancedRef.current.open) advancedRef.current.open = true;
  }, [pickerOn, conflictError, nameError]);
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

  /** The new box, or null with the reason shown. */
  // Whether the box this submit created came from the warm pool, for the
  // project.created event's warmClaimed (backend services/productEvents.ts).
  const lastBoxClaimed = useRef<boolean | null>(null);

  async function createBox(boxName = newBoxName.trim()): Promise<Instance | null> {
    if (!boxName || boxBusy || boxNameError || addBoxBlocked) return null;
    setBoxBusy(true); setBoxError(''); setBoxHint('');
    noteAddBoxClick();
    try {
      const r = await instancesApi.create(boxName, 'ec2');
      // Into the list now, ahead of the feed's next poll: a claimed box is
      // already ready and the form should say so at once; a provisioning one
      // starts the feed polling.
      if (r.claimed) noteBoxClaimed(r.instance.id);
      lastBoxClaimed.current = !!r.claimed;
      boxFeed.upsert(r.instance);
      // Stay on this box if the project create is refused, instead of
      // provisioning another one on the next submit.
      boxChoiceTouched.current = true;
      setBoxChoice(r.instance.id);
      if (r.hint) setBoxHint(r.hint);
      if (r.claimed) setBoxHint('A warm box was waiting, so it is ready now.');
      // A list fetch that was in flight when the box was created (the mount
      // reload, a poll) would replace the list without it; fetch again so the
      // row is authoritative, not just painted.
      await boxFeed.reload();
      return r.instance;
    } catch (err) {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'github-required') setBoxGate('blocked');
      // One attempt. A taken name is shown; it is not rewritten and retried.
      else setBoxError(apiError(err, 'Could not create the box'));
      return null;
    } finally {
      setBoxBusy(false);
    }
  }

  // ── Submit ──────────────────────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const body = createBody(pick);
  const newBoxOk = choice === NEW_BOX && !!newBoxName.trim() && !boxNameError && !addBoxBlocked && !conflictError && !nameError;
  const retryOk = boxAdvice === 'try-again' && !addBoxBlocked;
  const automationOk = !automation || (!!draft.prompt.trim() && draftCron(draft) !== null && !!draft.timezone && (draft.tier !== 'full' || fullTierTicked));
  // An automation runs on a box (the chat runner needs one): "this host" is not offered.
  const canSubmit = !busy && !nameError && (boxReady || boxBooting || newBoxOk || retryOk) && !!name.trim() && body !== null && automationOk && !(automation && choice === THIS_HOST);
  const matches = !choice || choice === NEW_BOX
    ? []
    : sameRepoMatches(pick, projects, choice === THIS_HOST ? null : choice);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !body) return;
    setBusy(true); setError('');
    let instanceId = choice === THIS_HOST ? null : chosenBox?.id ?? null;
    let warmClaimed: boolean | undefined;
    if (choice === NEW_BOX || (retryOk && chosenBox)) {
      // The box is chosen from here on, so a refused project is retried on
      // it rather than on a second new box; a failed one is launched again
      // under its own name.
      lastBoxClaimed.current = null;
      const box = await createBox(choice === NEW_BOX ? undefined : chosenBox?.name);
      if (!box) { setBusy(false); return; }
      instanceId = box.id;
      warmClaimed = lastBoxClaimed.current ?? undefined;
    }
    if (pickerOn && instanceId) notePickerSubmitted(instanceId);
    let project: Project;
    try {
      if (automation) {
        if (!instanceId) { setError('An automation runs on a box'); setBusy(false); return; }
        const created = await automationsApi.create({
          name: name.trim(),
          instanceId,
          repoUrl: body.repoUrl ?? null,
          defaultBranch: 'defaultBranch' in body ? body.defaultBranch ?? null : null,
          replaySessionId: await replaySessionId(),
          ...draftBody(draft),
        });
        project = created.project;
      } else {
        project = await projectsApi.create({
          name: name.trim(),
          instanceId,
          initialAgent: { enabled: true, provider, ...(chosen.backend && { backend: chosen.backend }), ...(chosen.model && { model: chosen.model }) },
          // The replay this tab is recording: the Claude session's spans are filed under it.
          replaySessionId: await replaySessionId(),
          ...(warmClaimed !== undefined && { warmClaimed }),
          ...body,
        });
      }
    } catch (err) {
      if (isBoxFailedRefusal(err)) {
        // The launch failed before the project was asked for: the box line
        // says so once the list has the failed box.
        await boxFeed.reload();
      } else {
        setError(apiError(err, 'Could not create the project'));
      }
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
        <RepoPicker value={pickerPick} onChange={choosePick} autoFocus={autoFocus} showPaste={false} />
      ) : (
        <>
          <div className="npf-field">
            <label htmlFor="npf-start">Start from</label>
            <select id="npf-start" value={start} autoFocus={autoFocus} onChange={e => { setStart(e.target.value); setNameTouched(false); }}>
              <option value={EMPTY}>empty: a fresh directory with AGENTS.md and CLAUDE.md</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.label}: {t.blurb}</option>)}
              <option value={CUSTOM}>custom: a GitHub repo URL</option>
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
      {(() => {
        const choices = (
          <>
            <div className="npf-field">
              <label htmlFor="npf-name">Project name</label>
              <input id="npf-name" value={name} onChange={e => { setName(e.target.value); setNameTouched(true); }} placeholder="letters, digits, - and _" />
            </div>
            {pickerOn && (
              <div className="npf-field">
                <label htmlFor="npf-paste">Paste a URL</label>
                <input
                  id="npf-paste"
                  value={pickerPick.kind === 'pasted' ? pickerPick.url : ''}
                  onChange={e => choosePick({ kind: 'pasted', url: e.target.value })}
                  placeholder="https://github.com/owner/repo"
                />
              </div>
            )}
            {automation ? (
              <div className="npf-field">
                <label>Agent</label>
                <span className="npf-static">Claude, headless, in the chat runner</span>
              </div>
            ) : (
              <div className="npf-field">
                <label htmlFor="npf-provider">Agent</label>
                <select id="npf-provider" value={provider} onChange={e => { setProvider(e.target.value); setBackend(null); setModel(null); }}>
                  {SELECTABLE_PROVIDER_IDS.map(id => <option key={id} value={id}>{PROVIDERS[id]?.displayName ?? id}</option>)}
                </select>
              </div>
            )}
            {!automation && (
              <BackendModelFields
                idPrefix="npf"
                choices={backendChoices}
                backend={chosen.backend}
                model={chosen.model}
                onBackend={setBackend}
                onModel={setModel}
              />
            )}
            <div className="npf-field">
              <label htmlFor="npf-box">Box</label>
              <select id="npf-box" value={choice} disabled={!boxesLoaded} onChange={e => { boxChoiceTouched.current = true; setBoxChoice(e.target.value); setBoxError(''); setBoxHint(''); setError(''); }}>
                {!boxesLoaded && <option value="">checking your boxes…</option>}
                {usable.map(b => <option key={b.id} value={b.id}>{b.name} · {status(b.status)}</option>)}
                {chosenBox && !boxIsUsableForProject(chosenBox) && (
                  <option value={chosenBox.id}>{chosenBox.name} · {status(chosenBox.status)}</option>
                )}
                {/* The chosen box left the list entirely (terminated from the sidebar):
                    keep the select consistent and let the user pick again. */}
                {boxesLoaded && choice && choice !== NEW_BOX && choice !== THIS_HOST && !chosenBox && (
                  <option value={choice}>that box is gone; pick another</option>
                )}
                <option value={NEW_BOX}>{boxes.length ? 'a new box…' : 'a new box (none yet)…'}</option>
                {isAdmin && !automation && <option value={THIS_HOST}>this host (admin)</option>}
              </select>
            </div>
            {choice === NEW_BOX && (
              <div className="npf-field npf-inline">
                <label htmlFor="npf-box-name">{pickerOn ? 'Box name' : 'New box name'}</label>
                <input
                  id="npf-box-name"
                  value={newBoxName}
                  onChange={e => { setBoxNameOverride(e.target.value); setBoxError(''); }}
                  placeholder="e.g. dev01"
                  disabled={boxBusy}
                />
                {warmPoolEnabled && warmPool && (
                  <span className="npf-note usage-dim">{warmPool.warm > 0 ? 'ready now' : 'a few minutes'}</span>
                )}
              </div>
            )}
          </>
        );
        return pickerOn ? (
          <details className="npf-advanced" ref={advancedRef}>
            <summary>Advanced settings</summary>
            <div className="npf-advanced-body">{choices}</div>
          </details>
        ) : choices;
      })()}
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
          {boxIsSettling(chosenBox) && <span className="usage-dim"> · this updates on its own</span>}
          {/* failed, or a power error worth showing (a start whose agent never
              connected leaves the box `starting` with the error set). */}
          {(chosenBox.status === 'failed' || showsBoxError(chosenBox)) && chosenBox.provisioningError && (
            <div className="error-text">{chosenBox.provisioningError}</div>
          )}
          {boxAdvice === 'try-again' && (
            <div className="usage-dim">
              No project was created. Try again launches {chosenBox.name} again and removes the failed box.
            </div>
          )}
          {boxAdvice === 'retry-project' && (
            <div className="usage-dim">
              {waitingOnBox[0].name} is waiting on this box; use Retry on it in the sidebar to launch {chosenBox.name} again.
            </div>
          )}
          {boxAdvice === 'start-it' && (
            <div className="usage-dim">
              Start it from the Boxes section of the workspace sidebar, or{' '}
              <button type="button" className="recents-link" onClick={() => { boxChoiceTouched.current = true; setBoxChoice(NEW_BOX); setBoxError(''); setBoxHint(''); }}>create a new one</button>.
            </div>
          )}
        </div>
      )}
      {boxesUnavailable && <div className="usage-dim npf-note">Could not load your boxes just now; you can still create a new one.</div>}
      {boxHint && <div className="usage-dim npf-note">{boxHint}</div>}
      {(choice === NEW_BOX || boxBooting) && (
        <div className="usage-dim npf-note">
          termag creates the project now and sets it up after the box is ready; it opens by itself, and the box keeps going if you close this tab.
        </div>
      )}
      {(nameError || conflictError || boxNameError || boxError) && (
        <div className="error-text">
          {nameError || conflictError || boxNameError || boxError}
          {pickerOn && conflictError && !nameError && ' Choose that box, or another box name, in Advanced settings.'}
        </div>
      )}

      {matches.map(project => (
        <div key={project.id} className="npf-note">
          <strong>{project.name}</strong> already checks out this repository. A workstream shares that checkout and is usually what you want.
          {onBranchOff && <button type="button" className="btn-ghost" onClick={() => onBranchOff(project.id)}>Branch off instead</button>}
        </div>
      ))}
      {automation && <AutomationFields draft={draft} onChange={setDraft} showEnabled idPrefix="npf-af" onFullTierTick={setFullTierTicked} />}
      <div className="usage-dim npf-note">
        {automation
          ? <>Each run gets its own branch under this project and shows up as a conversation in the simple UI. Nothing runs until the schedule's first occurrence; use Run now on the automation to try it.</>
          : body?.repoUrl
            ? <>The repo is fetched in the agent pane first, so you can watch it; the agent starts when the checkout is done.</>
            : <>An empty project with a seeded AGENTS.md and CLAUDE.md.</>}
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="npf-actions">
        {actions}
        <button
          type="submit"
          className="btn-primary"
          disabled={!canSubmit}
          data-analytics={choice === NEW_BOX ? 'add-box' : 'new-project-create'}
          title={conflictError || (choice === NEW_BOX && addBoxBlocked ? CONNECT_GITHUB_TO_ADD_BOX : undefined)}
        >
          {boxBusy ? 'Creating box…' : busy ? 'Creating…' : retryOk ? 'Try again' : matches.length > 0 ? 'Create a second checkout' : submitLabel}
        </button>
      </div>
    </form>
  );
}
