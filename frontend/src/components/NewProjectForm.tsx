import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useProjects } from '../contexts/ProjectContext';
import { automationsApi, credentialsApi, environmentsApi, instancesApi, projectsApi, warmPoolApi, WarmPoolStatus, type EnvironmentRepoView } from '../services/api';
import { useEnvironmentPool } from '../hooks/useEnvironmentPool';
import { poolHasBox, POOL_READY_HINT } from '../utils/environmentPool';
import { AutomationFields } from './AutomationFields';
import { draftBody, draftCron, emptyDraft, type AutomationDraft } from '../utils/automationDraft';
import { isSetupOff } from '../utils/boxSetup';
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
import { archivedNameClash, boxIsUsableForProject, funnyProjectName, isBoxFailedRefusal, unusableBoxAdvice, type ArchivedNameClash } from '../utils/projectStart';
import { createBody, sameRepoMatches, suggestedName, type CreateRepoBody, type RepoPick } from '../utils/repoPick';
import { boxIsSettling, claimUpdateLive } from '../utils/boxFeed';
import { showsBoxError } from '../utils/boxPower';
import { RepoPicker } from './RepoPicker';
import { ExtraReposField } from './MultiRepo';
import { MULTI_REPO_MAX, selectionRepos, toggleRepo, type ExtraRepo, type ListedPick } from '../utils/multiRepo';
import { replaySessionId } from '../observability';
import { BoxSizeField } from './BoxSizePicker';
import { BoxDiskField } from './BoxDiskField';
import { useBoxDiskPick, useBoxSizePick, useBoxSizes } from '../hooks/useBoxSizes';
import { sizeToSend } from '../utils/boxSize';
import { useEnvironments } from '../hooks/useEnvironments';
import { EnvironmentCheckouts } from './EnvironmentCheckouts';
import { checkoutsPin, visibilityGroups } from '../utils/environments';
import { diskInputError, diskNote, diskToSend } from '../utils/boxDisk';

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
 * user picked an existing box, the dialog was opened for one, or the project
 * the user is on lives on a box that can take another (defaultBoxId).
 *
 * Boxes come from the shared box feed; whoever mounts this must have the feed
 * running (MainLayout does; Welcome starts it itself).
 */

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
  /**
   * The box of the project the user is on: preselected over the usual
   * default when it can take a project. Unlike initialBoxId it is only a
   * preference, so a stopped or failed box falls back to the usual default.
   */
  defaultBoxId?: string | null;
  onBranchOff?: (projectId: string) => void;
  /**
   * Leaves out the notes on how setup works (the redrawn first run says it in
   * its own heading). Errors and box
   * notes still show.
   */
  quiet?: boolean;
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

/**
 * A box Create can go on now: ready, or booting (the server holds the project
 * for it). Narrower than boxIsUsableForProject, whose starting, warming and
 * warm boxes leave Create disabled until they get there, so a default on one
 * would block the collapsed form (Bugbot, #497). Matches boxReady/boxBooting.
 */
function boxTakesProjectNow(b: Pick<Instance, 'status'>): boolean {
  return b.status === 'ready' || b.status === 'provisioning' || b.status === 'awaiting-agent';
}

export function NewProjectForm({ onCreated, submitLabel = 'Create project', actions, autoFocus, onGithubRequired, initialBoxId, defaultBoxId, onBranchOff, mode = 'project', quiet = false }: NewProjectFormProps) {
  const automation = mode === 'automation';
  const [draft, setDraft] = useState<AutomationDraft>(emptyDraft);
  // The full tier is the owner's trust tick (it sets chatTrustedAt): Create waits for the checkbox AutomationFields shows for it.
  const [fullTierTicked, setFullTierTicked] = useState(false);
  const { user } = useAuth();
  const { projects: contextProjects } = useProjects();
  const isAdmin = user?.role === 'admin';
  const multiRepoOn = useFlag(FLAGS.multiRepo, false) && !automation;
  const [extraRepos, setExtraRepos] = useState<ExtraRepo[]>([]);
  const [fetchedProjects, setFetchedProjects] = useState<Project[] | null>(null);
  useEffect(() => {
    if (contextProjects.length > 0) return;
    let cancelled = false;
    projectsApi.list()
      .then(list => { if (!cancelled) setFetchedProjects(list); })
      .catch(() => { if (!cancelled) setFetchedProjects([]); });
    return () => { cancelled = true; };
  }, [contextProjects.length]);
  const projects = contextProjects.length > 0 ? contextProjects : (fetchedProjects ?? []);
  const pickerNoted = useRef(false);
  // Set when the user picks a box, or when this submit has created one, so a
  // later feed reload cannot put the default back (and a refused project is
  // retried on the box just created).
  const boxChoiceTouched = useRef(false);
  const advancedRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (pickerNoted.current) return;
    pickerNoted.current = true;
    notePickerMounted();
  }, []);

  // ── Start from ──────────────────────────────────────────────────────────
  const [pickerPick, setPickerPick] = useState<RepoPick>(EMPTY_PICK);
  // Listed repositories ticked after the pick: with multi-repo-projects-enabled
  // the list is a multi-select, and two or more make a multi-repo project.
  const [pickerMore, setPickerMore] = useState<ListedPick[]>([]);
  const multiSelect = multiRepoOn;
  const more = multiSelect ? pickerMore : [];
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const pick = pickerPick;
  // An environment names the repositories itself: picked, the
  // repository fields give way, and the project and its new box are made from it.
  const environments = useEnvironments(!automation);
  const [environmentName, setEnvironmentName] = useState('');
  const environment = environments.find(e => e.name === environmentName) ?? null;
  // Its checkouts now (a pointer's file is read on the server), each repository at its branch: listed under the
  // field before Create, and the create is held to them, since an ask of the project runs them without asking.
  // Read again after a 409 environment_repos_changed; a failed read holds Create, saying so, and sends nothing.
  const [checkouts, setCheckouts] = useState<{ id: string; repos: EnvironmentRepoView[]; error?: string } | null>(null);
  const [checkoutReads, setCheckoutReads] = useState(0);
  useEffect(() => {
    if (!environment) return;
    let cancelled = false;
    environmentsApi.resolved(environment.id)
      .then(r => { if (!cancelled) setCheckouts({ id: environment.id, repos: r.repos, ...(r.repos.length ? {} : { error: r.warnings.join('; ') || `${environment.name} names no repository` }) }); })
      .catch(() => { if (!cancelled) setCheckouts({ id: environment.id, repos: [], error: `Could not read ${environment.name}'s repositories; pick it again to retry` }); });
    return () => { cancelled = true; };
  }, [environment?.id, checkoutReads]);
  const shownCheckouts = environment && checkouts?.id === environment.id ? checkouts : null;
  const environmentRepos = shownCheckouts && !shownCheckouts.error ? checkoutsPin(shownCheckouts.repos) : null;
  function choosePick(next: RepoPick) {
    if (pickIdentity(pickerPick) !== pickIdentity(next)) setNameTouched(false);
    setPickerPick(next.kind === 'empty' ? EMPTY_PICK : next);
    setPickerMore([]);
  }
  // The name follows the first repository, so only a new first one renames the project.
  // Every Add another repository row holds a slot, blank or not, as ExtraReposField counts them.
  function toggleListed(repo: ListedPick) {
    const next = toggleRepo({ pick: pickerPick, more }, repo, MULTI_REPO_MAX - extraRepos.length);
    if (pickIdentity(pickerPick) !== pickIdentity(next.pick)) setNameTouched(false);
    setPickerPick(next.pick);
    setPickerMore(next.more);
  }
  // The name follows the repo until the user edits it; an empty project gets
  // a fresh "proj-fuzzy-pants" so the field is never blank (and a different
  // one each time the start-from choice changes back to empty).
  useEffect(() => {
    if (nameTouched) return;
    if (environment) {
      setName(environment.name);
      return;
    }
    const suggested = suggestedName(pickerPick);
    if (suggested) setName(suggested);
    else if (pickerPick.kind === 'empty') setName(funnyProjectName());
  }, [nameTouched, pickerPick, environment]);

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
  // The mount reload failed after an earlier good one: the list is from before
  // and can lack a box that has started since.
  const feedFailing = useSyncExternalStore(boxFeed.subscribe, boxFeed.isFailing);
  const boxesStale = reloadSettled && feedLoaded && feedFailing;
  // A quarantined box is kept for an admin's investigation; nothing new goes on it.
  const boxes = useMemo(() => allBoxes.filter(b => b.status !== 'terminated' && b.status !== 'quarantined'), [allBoxes]);
  const usable = useMemo(() => boxes.filter(boxIsUsableForProject), [boxes]);
  // Until the user picks, the box of the project the user is on is the
  // default when Create can go on it now, so a new project skips a box's
  // setup time. Otherwise the form starts a new box. An
  // initialBoxId (Pick a repository) is an explicit box and wins over all of
  // these.
  const [boxChoice, setBoxChoice] = useState<string | null>(null);
  // Whether defaultBoxId was taken, decided once on the first loaded list: a
  // box feed poll that changes its status (provisioning to failed, stopped to
  // ready) must not move the select while the user reads the form. It waits
  // for a real list (feedLoaded): after a failed first load the list is empty,
  // and deciding on it would pass on the box for good (Bugbot, #497).
  const defaultBoxDecision = useRef<'taken' | 'passed' | null>(null);
  useEffect(() => {
    if (!boxesLoaded || boxChoiceTouched.current) return;
    if (initialBoxId && boxes.some(b => b.id === initialBoxId)) {
      setBoxChoice(initialBoxId);
      return;
    }
    if (defaultBoxId && feedLoaded && defaultBoxDecision.current === null) {
      const current = boxes.find(b => b.id === defaultBoxId);
      defaultBoxDecision.current = current && boxTakesProjectNow(current) ? 'taken' : 'passed';
    }
    if (defaultBoxDecision.current === 'taken' && boxes.some(b => b.id === defaultBoxId)) {
      setBoxChoice(defaultBoxId!);
      return;
    }
    setBoxChoice(NEW_BOX);
  }, [boxesLoaded, feedLoaded, boxes, initialBoxId, defaultBoxId]);
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

  // null follows the default, the project name. A string, including "", is
  // what the user typed.
  const [boxNameOverride, setBoxNameOverride] = useState<string | null>(null);
  const newBoxName = boxNameOverride !== null
    ? boxNameOverride
    : boxNameFromProject(name);
  const nameError = projectNameError(name);
  // An illegal box name clears as the user types. API failures are boxError
  // and must not keep Create disabled on their own.
  const boxNameError = choice === NEW_BOX && newBoxName.trim() && !isValidBoxName(newBoxName.trim()) ? BOX_NAME_ERROR : '';
  const takenBox = choice === NEW_BOX ? boxNameTaken(newBoxName, boxes) : undefined;
  const conflictError = takenBox ? boxNameConflictMessage(newBoxName.trim()) : '';
  useEffect(() => {
    if (!conflictError && !nameError) return;
    if (advancedRef.current && !advancedRef.current.open) advancedRef.current.open = true;
  }, [conflictError, nameError]);
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

  // The new box's size: the dropdown shows only while box-default-size is on, preselecting what the
  // server says a box for the picked repository launches at (its .termag/environment.json, utils/boxSize.ts).
  // A multi-repo project's box is sized for every repository (the server takes the largest), else the one.
  // An environment's box is sized by its one file instead (the server reads it).
  const sizeRepos = environment ? null : (multiRepoOn ? selectionRepos({ pick, more }, extraRepos) : null)?.map(r => r.url) ?? createBody(pick)?.repoUrl;
  const { sizes: boxSizes, disk: boxDisk } = useBoxSizes(choice === NEW_BOX, sizeRepos, environment?.name);
  const [boxSize, setBoxSize] = useBoxSizePick(sizeRepos, environment?.name);
  // The new box's disk: what the person typed, else the repository's diskGiB or 120 (utils/boxDisk.ts).
  const [diskTyped, setDiskTyped] = useBoxDiskPick(sizeRepos, environment?.name);
  const diskError = choice === NEW_BOX ? diskInputError(boxDisk, diskTyped) : null;
  const environmentPool = useEnvironmentPool(choice === NEW_BOX && environment?.visibility === 'shared' ? environment.id : null);
  const [warmPool, setWarmPool] = useState<WarmPoolStatus | null>(null);
  useEffect(() => {
    if (choice !== NEW_BOX) return;
    let cancelled = false;
    warmPoolApi.get().then(p => { if (!cancelled) setWarmPool(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [choice]);

  /** The new box, or null with the reason shown. */
  // Whether the box this submit created came from the warm pool, for the
  // project.created event's warmClaimed (backend services/productEvents.ts).
  const lastBoxClaimed = useRef<boolean | null>(null);

  // setupOff: a Try again of a failed box with termag setup off relaunches it so.
  async function createBox(boxName = newBoxName.trim(), setupOff = false): Promise<Instance | null> {
    if (!boxName || boxBusy || boxNameError || addBoxBlocked) return null;
    setBoxBusy(true); setBoxError(''); setBoxHint('');
    noteAddBoxClick();
    try {
      const r = await instancesApi.create(boxName, 'ec2', { size: sizeToSend(boxSizes, boxSize), diskGiB: diskToSend(boxDisk, diskTyped), repo: sizeRepos, environment: environment?.name, ...(setupOff ? { setupEnabled: false } : {}) });
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
      if (r.claimed) setBoxHint(r.pool === 'environment' ? `A box with ${environment?.name ?? 'the environment'}'s setup already run was waiting; it is starting now.` : 'A warm box was waiting, so it is ready now.');
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
  const body: CreateRepoBody | null = environment ? { repoUrl: null } : createBody(pick);
  const workspaceRepos = !environment && multiRepoOn ? selectionRepos({ pick, more }, extraRepos) : null;
  const newBoxOk = choice === NEW_BOX && !!newBoxName.trim() && !boxNameError && !diskError && !addBoxBlocked && !conflictError && !nameError;
  const retryOk = boxAdvice === 'try-again' && !addBoxBlocked;
  const automationOk = !automation || (!!draft.prompt.trim() && draftCron(draft) !== null && !!draft.timezone && (draft.tier !== 'full' || fullTierTicked));
  // An automation runs on a box (the chat runner needs one): "this host" is not offered.
  const canSubmit = !busy && !nameError && (boxReady || boxBooting || newBoxOk || retryOk) && !!name.trim() && body !== null && automationOk && !(automation && choice === THIS_HOST)
    && (!environment || environmentRepos !== null);
  const matches = !choice || choice === NEW_BOX || workspaceRepos || environment
    ? []
    : sameRepoMatches(pick, projects, choice === THIS_HOST ? null : choice);

  // An archived project already holds the name on the chosen box. Kept with
  // the name and box it was refused for, so editing either drops the offer.
  const [archivedClash, setArchivedClash] = useState<{ key: string; project: ArchivedNameClash } | null>(null);
  const clashKey = `${name.trim()}|${choice}`;
  const clash = archivedClash?.key === clashKey ? archivedClash.project : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await create();
  }

  async function create(archivedName?: 'unarchive' | 'rename-aside') {
    if (!canSubmit || !body) return;
    setBusy(true); setError(''); setArchivedClash(null);
    let instanceId = choice === THIS_HOST ? null : chosenBox?.id ?? null;
    let warmClaimed: boolean | undefined;
    if (choice === NEW_BOX || (retryOk && chosenBox)) {
      // The box is chosen from here on, so a refused project is retried on
      // it rather than on a second new box; a failed one is launched again
      // under its own name.
      lastBoxClaimed.current = null;
      const box = choice === NEW_BOX ? await createBox() : await createBox(chosenBox?.name, isSetupOff(chosenBox));
      if (!box) { setBusy(false); return; }
      instanceId = box.id;
      warmClaimed = lastBoxClaimed.current ?? undefined;
    }
    if (instanceId) notePickerSubmitted(instanceId);
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
          ...(archivedName && { archivedName }),
          ...(environment ? { environment: environment.name, environmentRepos: environmentRepos ?? [] } : workspaceRepos ? { repos: workspaceRepos } : body),
        });
      }
    } catch (err) {
      const archived = archivedNameClash(err);
      if (archived) {
        setArchivedClash({ key: clashKey, project: archived });
      } else if (isBoxFailedRefusal(err)) {
        // The launch failed before the project was asked for: the box line
        // says so once the list has the failed box.
        await boxFeed.reload();
      } else {
        setError(apiError(err, 'Could not create the project'));
        if ((err as { response?: { data?: { code?: string } } })?.response?.data?.code === 'environment_repos_changed') setCheckoutReads(n => n + 1);
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
      {environments.length > 0 && (
        <div className="npf-field">
          <label htmlFor="npf-environment">Environment</label>
          <select id="npf-environment" value={environmentName} onChange={e => { setEnvironmentName(e.target.value); setNameTouched(false); }}>
            <option value="">None</option>
            {/* Personal first, then shared. */}
            {visibilityGroups(environments).map(g => (
              <optgroup key={g.visibility} label={g.label}>
                {g.items.map(e => <option key={e.id} value={e.name}>{e.name}</option>)}
              </optgroup>
            ))}
          </select>
          {shownCheckouts?.error ? <div className="error-text">{shownCheckouts.error}</div>
            : shownCheckouts ? <EnvironmentCheckouts repos={shownCheckouts.repos} className="usage-dim npf-checkouts" /> : null}
        </div>
      )}
      {!environment && (
        <RepoPicker value={pickerPick} onChange={choosePick} autoFocus={autoFocus} showPaste={false} more={more} onToggle={multiSelect ? toggleListed : undefined} />
      )}
      {multiRepoOn && !environment && (
        <ExtraReposField value={extraRepos} onChange={setExtraRepos} primaryCount={body?.repoUrl ? 1 + more.length : 0} />
      )}
      {(() => {
        const choices = (
          <>
            <div className="npf-field">
              <label htmlFor="npf-name">Project name</label>
              <input id="npf-name" value={name} onChange={e => { setName(e.target.value); setNameTouched(true); }} placeholder="letters, digits, - and _" />
            </div>
            {!environment && (
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
                <label htmlFor="npf-box-name">Box name</label>
                <input
                  id="npf-box-name"
                  value={newBoxName}
                  onChange={e => { setBoxNameOverride(e.target.value); setBoxError(''); }}
                  placeholder="e.g. dev01"
                  disabled={boxBusy}
                />
                {/* A pooled environment's box starts a stopped one with its setup already run. */}
                {poolHasBox(environmentPool) && !diskNote(boxDisk, diskTyped, true)
                  ? <span className="npf-note usage-dim">{POOL_READY_HINT}</span>
                  : warmPool && (
                    <span className="npf-note usage-dim">{warmPool.warm > 0 && !diskNote(boxDisk, diskTyped, true) ? 'ready now' : 'a few minutes'}</span>
                  )}
              </div>
            )}
            {choice === NEW_BOX && boxSizes && (
              <BoxSizeField options={boxSizes} picked={boxSize} onPick={setBoxSize} disabled={boxBusy} />
            )}
            {choice === NEW_BOX && boxDisk && (
              <BoxDiskField disk={boxDisk} typed={diskTyped} onType={setDiskTyped} warmBoxReady={(warmPool?.warm ?? 0) > 0} disabled={boxBusy} />
            )}
          </>
        );
        return (
          <details className="npf-advanced" ref={advancedRef}>
            <summary>Advanced settings</summary>
            <div className="npf-advanced-body">{choices}</div>
          </details>
        );
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
          <strong>{chosenBox.name}</strong> · {chosenBox.status === 'ready' && claimUpdateLive(chosenBox) ? 'updating the box…' : status(chosenBox.status)}
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
      {boxesStale && <div className="usage-dim npf-note">Could not refresh your boxes just now, so this list may be out of date. Reload the page if a box is missing.</div>}
      {boxHint && <div className="usage-dim npf-note">{boxHint}</div>}
      {!quiet && (choice === NEW_BOX || boxBooting) && (
        <div className="usage-dim npf-note">
          termag creates the project now and sets it up after the box is ready; it opens by itself, and the box keeps going if you close this tab.
        </div>
      )}
      {(nameError || conflictError || boxNameError || boxError) && (
        <div className="error-text">
          {nameError || conflictError || boxNameError || boxError}
          {conflictError && !nameError && ' Choose that box, or another box name, in Advanced settings.'}
        </div>
      )}

      {matches.map(project => (
        <div key={project.id} className="npf-note">
          <strong>{project.name}</strong> already checks out this repository. A workstream shares that checkout and is usually what you want.
          {onBranchOff && <button type="button" className="btn-ghost" onClick={() => onBranchOff(project.id)}>Branch off instead</button>}
        </div>
      ))}
      {automation && <AutomationFields draft={draft} onChange={setDraft} showEnabled idPrefix="npf-af" onFullTierTick={setFullTierTicked} />}
      {!quiet && !environment && <div className="usage-dim npf-note">
        {automation
          ? <>Each run gets its own branch under this project and shows up as a conversation in termag. Nothing runs until the schedule's first occurrence; use Run now on the automation to try it.</>
          : workspaceRepos
            ? <>{workspaceRepos.length} repositories, each cloned into its own directory; the agent starts when every checkout is done.</>
          : body?.repoUrl
            ? <>The repo is fetched in the agent pane first, so you can watch it; the agent starts when the checkout is done.</>
            : <>An empty project with a seeded AGENTS.md and CLAUDE.md.</>}
      </div>}
      {error && <div className="error-text">{error}</div>}
      {clash && (
        <div className="npf-note">
          You archived a project named <strong>{clash.name}</strong> on this box on {clash.archivedAt.slice(0, 10)}, so the name is taken.
          {' '}Un-archive it to get it back as it was{clash.workstreams > 1 ? `, with its ${clash.workstreams} workstreams` : ''} (whatever is still in its folder on the box),
          {' '}or rename it aside to {clash.name}-archived-{clash.archivedAt.slice(0, 10)} (it stays archived) and create a new {clash.name}.
          <div className="npf-actions">
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void create('unarchive')}>Un-archive it</button>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void create('rename-aside')}>Rename it aside and create</button>
          </div>
        </div>
      )}
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
