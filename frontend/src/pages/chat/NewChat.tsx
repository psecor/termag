// New chat in the simple UI: one composer. The question above it names the
// repository (with user-projects-enabled, the project),
// the Claude model and the permissions sit in its bar, and the
// drawer under it says where the session runs: a new box (the server claims
// a warm one when the pool has one, else launches one) or one of yours, its space and names, and with
// automations-enabled whether it runs on a schedule instead. Sending the
// message starts the chat; the first message waits in the chat until Claude
// can take it (chat/newChat.ts).
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { automationsApi, credentialsApi, environmentsApi, instancesApi, projectsApi, workstreamsApi } from '../../services/api';
import { useScheduleCheck } from '../../components/AutomationFields';
import { automationHref } from '../../chat/automationsView';
import { useAutomations, useAutomationsEnabled } from '../../chat/useAutomations';
import { draftBody, draftCron, emptyDraft, type AutomationDraft } from '../../utils/automationDraft';
import { isSetupOff } from '../../utils/boxSetup';
import { FLAGS, useFlag } from '../../flags';
import { useDictation } from '../../chat/useDictation';
import { DictationButton, DictationNote } from '../../chat/DictationButton';
import { blocksManagedBox, type BoxGateState } from '../../boxGate';
import { boxFeed } from '../../services/boxFeed';
import { noteAddBoxClick, noteBoxClaimed, noteProjectCreated } from '../../services/claimTiming';
import { replaySessionId } from '../../observability';
import { BOX_NAME_ERROR, isValidBoxName } from '../../utils/boxNames';
import { funnyProjectName, isBoxFailedRefusal } from '../../utils/projectStart';
import { repoKey, suggestedName, type RepoPick } from '../../utils/repoPick';
import { chatHref, repoNeedsTrust, repoStartsTrusted } from '../../chat/simpleChat';
import {
  newChatNames, orchestratorOption, queueKey, readLastPick, readLastStart, readPermissionPick, rememberStartPick, sessionWords, startBlocker, worktreeName,
  worktreeTargets, writeLastPick, writeLastStart, writePermissionPick, writeQueued,
} from '../../chat/newChat';
import { chatAgentName, chatModelTakesPdfs, newChatCreateFields, noRepoCreateFields, repoTriggerLabel, type ChatEffortId, type ChatModelId } from '../../chat/composer';
import { CHAT_PROVIDER_ID, PROVIDERS } from '../../providers/registry';
import { isSendKey, MAX_KEYS } from '../../chat/compose';
import type { Instance, Project } from '../../types';
import { SpacePicker } from './SpacePicker';
import { RepoPicker } from './RepoPicker';
import { ProjectPicker } from './ProjectPicker';
import { useUserProjectList } from '../../chat/useUserProjectList';
import {
  checkoutBaseName, defaultUserProject, nextCheckoutName, offeredProjects, projectCreateRepos, projectSelection, projectWorktreeTargets,
  RESERVED_CHECKOUT_NAMES,
} from '../../chat/projectPick';
import { Button } from '@launchpad-ui/components';
import { LP_THEME } from '../../launchpad/theme';
import { SchedulePicker } from './SchedulePicker';
import { ModelPicker } from '../../chat/ModelPicker';
import { writeEffortPick } from '../../chat/useChatEffort';
import { FollowsPermissions, PermissionPicker } from '../../chat/PermissionPicker';
import { writeModelPick } from '../../chat/useChatModel';
import { CheckoutPicker, OWN_CLONE, type WorktreeBase } from './CheckoutPicker';
import { WorktreePill } from './WorktreePill';
import { OrchestratorToggle } from '../../chat/OrchestratorToggle';
import { launchableBoxes, LaunchDrawer, NEW_BOX, newBoxSummary, placementBoxes } from './LaunchDrawer';
import { useBoxPlacement } from '../../hooks/useBoxPlacement';
import { AUTO, autoChoice, hotBoxNote, repoWordsFor } from '../../chat/boxPlacement';
import { writeHotBoxNotice } from '../../chat/hotBoxNotice';
import { BoxSizeSelect } from '../../components/BoxSizePicker';
import { BoxDiskInput } from '../../components/BoxDiskField';
import { useBoxDiskPick, useBoxSizePick, useBoxSizes } from '../../hooks/useBoxSizes';
import { useWarmBoxReady } from '../../hooks/useWarmBoxReady';
import { useEnvironmentPool } from '../../hooks/useEnvironmentPool';
import { poolHasBox, POOL_READY_HINT } from '../../utils/environmentPool';
import { preselectedSize, REPO_DEFAULT, sizeToSend } from '../../utils/boxSize';
import { diskInputError, diskToSend } from '../../utils/boxDisk';
import { canStartBox } from '../../utils/boxPower';
import { SendIcon } from '../../chat/ComposerIcons';
import { useChatModelOptions } from '../../chat/useChatModelOptions';
import { ChatHistoryButton } from './chatChrome';
import { useSpaceStep } from '../../chat/useSpaceStep';
import { useSimpleDataIfAny } from './simpleData';
import { githubRepoUrl } from '../../utils/repoPick';
import { selectionRepos, toggleRepo, type ListedPick } from '../../utils/multiRepo';
import { useEnvironmentSelection, useEnvironments } from '../../hooks/useEnvironments';
import type { EnvironmentRepoView, EnvironmentView } from '../../services/api';
import { EnvironmentCheckouts } from '../../components/EnvironmentCheckouts';
import { checkoutsPin } from '../../utils/environments';
import { EnvironmentSelect } from './EnvironmentSelect';
import { useSessionRefDrop } from '../../chat/useSessionRefDrop';
import { useComposerAttachments } from '../../chat/useComposerAttachments';
import { ComposerAttach } from '../../chat/ComposerAttach';
import { ComposerImages } from '../../chat/ChatImages';
import { messageTooLong, withTextFiles } from '../../chat/chatTextFiles';
import { holdFirstImages, queuedFirstText, releaseFirstImages } from '../../chat/firstImages';
import { recordTypedChatCommand } from '../../usageEvents';

/** The power states the server takes a session on with Runs on: Auto, waking the box (backend services/projectSetup.ts WAKEABLE_BOX_STATUSES). */
const WAKEABLE_STATUSES = ['stopped', 'hibernated', 'starting', 'stopping', 'hibernating'];

/** The automation API's prompt cap (backend routes/automations.ts MAX_PROMPT). */
const MAX_AUTOMATION_PROMPT = 20_000;

const PROJECT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** No repository picked: one object, so a project with none reads as the same pick from render to render. */
const EMPTY_PICK: RepoPick = { kind: 'empty' };

/** Phone drawer has no docked list, so New chat needs the same Chats control
 *  as a conversation. The composer stays the child; the stack is `display:
 *  contents` until the phone layout. */
function NewChatFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="chat-new-page">
      <div className="chat-new-stack">
        <ChatHistoryButton />
        {children}
      </div>
    </div>
  );
}

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

function apiCode(err: unknown): string | undefined {
  return (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
}

const browserStore = () => (typeof localStorage !== 'undefined' ? localStorage : null);

export function NewChat() {
  const navigate = useNavigate();
  const simple = useSimpleDataIfAny();
  const { projects, reloadProjects } = useProjects();
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const [params] = useSearchParams();
  // The repository and space the last chat started with open again here, and
  // the model and effort last picked in any composer (chat/newChat.ts readLastPick).
  const [last] = useState(() => readLastStart(browserStore()));
  const [lastPick] = useState(() => readLastPick(browserStore()));
  const spaceStep = useSpaceStep(params.get('space'), last.space);
  const rootRef = useRef<HTMLFormElement>(null);
  // Arriving here (the New session button, ⌘⇧O, or ⌘⇧O again while here: a
  // new history entry each time) puts the cursor in the message.
  const { key: visit, state: arrival } = useLocation();
  const messageRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { messageRef.current?.focus(); }, [visit]);
  // After a menu closes, which hands focus back to its trigger first (React Aria), then to the message.
  function focusMessageSoon() { setTimeout(() => messageRef.current?.focus(), 0); }

  const [repoPick, setPick] = useState<RepoPick>(last.pick ?? { kind: 'empty' });
  // An environment names the repositories instead of the
  // picker: ?environment= (an environment's New session) opens on it.
  // An environment's page passes the environment it opens New session with, so the first frame has it (no pop-in).
  // environment-selection-enabled off: no picker at all, not even the empty one that offers New environment.
  const environmentSelection = useEnvironmentSelection();
  const environments = useEnvironments(true, (arrival as { environment?: EnvironmentView } | null)?.environment ?? null);
  // It follows the URL on a mounted page, as ?schedule= does: New session after an environment's is the same route.
  // Reset while rendering (React's derived-state pattern), so no frame shows the last one's environment.
  const environmentParam = params.get('environment') ?? '';
  const [environmentName, setEnvironmentName] = useState(environmentParam);
  const [environmentFor, setEnvironmentFor] = useState(environmentParam);
  if (environmentFor !== environmentParam) {
    setEnvironmentFor(environmentParam);
    setEnvironmentName(environmentParam);
  }
  const environment = environments.find(e => e.name === environmentName) ?? null;
  // The repositories it resolves to now (a pointer's file is read on the server): what the trust pill asks about.
  // Each repository at the branch it is cloned on (absent: its default), as Full access is granted for them.
  const [environmentRepos, setEnvironmentRepos] = useState<{ id: string; repos: EnvironmentRepoView[]; error?: string } | null>(null);
  // Bumped when a create says they changed since (409 environment_repos_changed), to read them again.
  const [environmentReads, setEnvironmentReads] = useState(0);
  useEffect(() => {
    if (!environment) return;
    let cancelled = false;
    environmentsApi.resolved(environment.id)
      .then(r => { if (!cancelled) setEnvironmentRepos({ id: environment.id, repos: r.repos, ...(r.repos.length ? {} : { error: r.warnings.join('; ') || `${environment.name} names no repository` }) }); })
      .catch(() => { if (!cancelled) setEnvironmentRepos({ id: environment.id, repos: [], error: `Could not read ${environment.name}` }); });
    return () => { cancelled = true; };
  }, [environment?.id, environmentReads]);
  // New session starts from a project, with user-projects-enabled:
  // the pill is the person's project, most recently active first (the server's order, so the default
  // follows them across browsers), or ?project= (a project's New session here). From a repository…, or
  // projects that fail to load, bring today's repository picker back; the server still files the session
  // under the project for its repositories. An environment names the repositories instead, as before.
  const projectsOn = useFlag(FLAGS.userProjects, false);
  const userProjects = useUserProjectList(projectsOn);
  const projectParam = params.get('project');
  const [projectChoice, setProjectChoice] = useState<string | null>(null);
  const [fromRepository, setFromRepository] = useState(false);
  // A new ?project= (New session here, on a mounted page) is picked afresh, as ?environment= is.
  const [projectFor, setProjectFor] = useState(projectParam);
  if (projectFor !== projectParam) {
    setProjectFor(projectParam);
    setProjectChoice(null);
    setFromRepository(false);
  }
  const projectMode = projectsOn && !fromRepository && userProjects.kind !== 'failed' && !environment;
  const projectList = userProjects.kind === 'ready' ? userProjects.projects : [];
  const userProject = projectMode
    ? offeredProjects(projectList).find(p => p.id === projectChoice) ?? defaultUserProject(projectList, projectParam)
    : null;
  const [projectOpen, setProjectOpen] = useState(false);
  // What the project stands for as a repository pick, so Send, the permission pill, the size and Runs on: Auto read it as a picked repository.
  const projectPicked = useMemo(() => (userProject ? projectSelection(userProject) : null), [userProject]);
  const noRepoProject = !!userProject && userProject.repos.length === 0;
  const pick: RepoPick = projectMode ? projectPicked?.pick ?? EMPTY_PICK : repoPick;
  // More repositories ticked after the pick: two or more make a multi-repo
  // project. Only with multi-repo-projects-enabled.
  // A project's own come with it.
  const multiRepoOn = useFlag(FLAGS.multiRepo, false);
  const [morePicked, setMore] = useState<ListedPick[]>([]);
  const more = projectMode ? projectPicked?.more ?? [] : multiRepoOn ? morePicked : [];
  const [picked, setPicked] = useState<ChatModelId>(lastPick.model ?? last.model);
  const setModel = (id: ChatModelId) => { setPicked(id); writeLastPick(browserStore(), { model: id }); };
  // The last start's model while it is still offered: a Fireworks model shows once the menus load.
  const modelOptions = useChatModelOptions();
  const model = modelOptions.some(o => o.id === picked) ? picked : 'sonnet';
  // The effort its turns run at, beside the model. Not for a schedule.
  const [effort, setEffortState] = useState<ChatEffortId>(lastPick.effort ?? last.effort);
  const setEffort = (id: ChatEffortId) => { setEffortState(id); writeLastPick(browserStore(), { effort: id }); };
  const [message, setMessage] = useState('');
  const [repoOpen, setRepoOpen] = useState(false);
  /** Every other menu closes when one opens: the project menu's own part of that. */
  function closeProjectMenu() { setProjectOpen(false); }
  const [modelOpen, setModelOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  // Bumped when another menu opens or the form sends, so the space menu closes.
  const [spaceMenuEpoch, setSpaceMenuEpoch] = useState(0);
  function dismissSpaceMenu() { setSpaceMenuEpoch(n => n + 1); }
  // Run on a schedule: the same box and repository,
  // but an automation instead of a chat; the first message is its prompt.
  // The drawer's schedule dialog picks it (pages/chat/SchedulePicker.tsx).
  const automationsOn = useFlag(FLAGS.automations, false);
  // ?schedule=1 (the simple UI's New automation) starts on On a schedule,
  // and the choice follows the URL when it changes on a mounted page: New
  // session after New automation (or the other way round) is the same route.
  const scheduleParam = params.get('schedule') === '1';
  const [schedulePicked, setScheduled] = useState(scheduleParam);
  useEffect(() => { setScheduled(scheduleParam); }, [scheduleParam]);
  const simpleAutomations = useAutomationsEnabled();
  const { reload: reloadAutomations } = useAutomations();
  const scheduled = automationsOn && schedulePicked;
  // Under project-files-enabled a session has no space pill: its
  // space is its project's Project files, which the server sets (services/chatSpace.ts), from a repository too. An
  // automation keeps its pill: it isn't a session of a project, and its space is where it and its runs are listed.
  const projectFilesOn = useFlag(FLAGS.projectFiles, false) && projectsOn;
  const spaceUse = projectFilesOn && !scheduled
    ? { ...spaceStep, show: false, pending: false, ready: true, error: '', prepare: async (): Promise<string | null> => null, grant: async () => {} }
    : spaceStep;
  const dictation = useDictation({ text: message, setText: setMessage, max: scheduled ? MAX_AUTOMATION_PROMPT : MAX_KEYS });
  // A session dragged in from the sidebar goes into the message as a reference to it (chat/sessionRef.ts).
  const refDrop = useSessionRefDrop({ input: messageRef, text: message, setText: t => { dictation.onEdit(); setMessage(t); }, max: scheduled ? MAX_AUTOMATION_PROMPT : MAX_KEYS });
  // Images for the first message, as an open chat's composer takes them (chat/useComposerAttachments.ts).
  // The box is not known yet, so they wait here and then with the queued message (chat/firstImages.ts);
  // a box that takes none says so at the send, and keeps the text.
  // PDFs too on Claude's own models, as an open chat's composer offers them; the box's runner decides at the send.
  const attachments = useComposerAttachments({ pdfs: chatModelTakesPdfs(model) });
  const takesImages = !scheduled;
  // What the first message sends: what was typed, then its text files (chat/chatTextFiles.ts).
  const firstMessage = withTextFiles(message, attachments.files);
  const [draft, setDraft] = useState<AutomationDraft>(emptyDraft);
  // Checked here, not in the dialog, so the answer keeps coming once Done closes it.
  const scheduleCheck = useScheduleCheck(draft, scheduled);
  const [fallbackName] = useState(() => funnyProjectName());
  // A project's checkout is named after its first repository, or for a no-repo project its name made a directory
  // name (chat/projectPick.ts checkoutBaseName), never MetaTerm's; people see the project's name, not this.
  const defaults = useMemo(
    () => newChatNames(
      (environment ? environment.name : userProject ? checkoutBaseName(userProject) : suggestedName(pick)) ?? fallbackName,
      userProject ? [...projects.map(p => p.name), ...RESERVED_CHECKOUT_NAMES] : projects.map(p => p.name),
      boxes.map(b => b.name),
    ),
    [pick, environment, userProject, fallbackName, projects, boxes],
  );
  const [nameEdit, setNameEdit] = useState<string | null>(null);
  const [boxEdit, setBoxEdit] = useState<string | null>(null);
  const name = (nameEdit ?? defaults.projectName).trim();
  const boxName = (boxEdit ?? defaults.boxName).trim();

  const [gate, setGate] = useState<BoxGateState | undefined>();
  useEffect(() => {
    let cancelled = false;
    credentialsApi.get().then(c => { if (!cancelled) setGate(c.github.boxGate); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const blocked = blocksManagedBox(gate);

  useEffect(() => {
    if (!repoOpen && !modelOpen) return;
    function onPointer(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) {
        setRepoOpen(false);
        setModelOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setRepoOpen(false); setModelOpen(false); }
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [repoOpen, modelOpen]);

  // A box launched for an attempt whose project was then refused is reused
  // by the retry, so a second Send never launches a second box.
  const [launched, setLaunched] = useState<Instance | null>(null);
  // Runs on: Auto: with box-placement-enabled, New
  // session starts on Auto every time, and Auto is what GET
  // /api/boxes/placement recommends for the repositories picked.
  const placementOn = useFlag(FLAGS.boxPlacement, false);
  // What the drawer shows picked: AUTO, NEW_BOX, or the id of one of the
  // user's boxes; null until a pick, so the default follows the flag. An
  // explicit pick holds for this session only.
  // An asleep box is woken when it is picked; the start waits until it is up.
  const [boxPicked, setBoxChoice] = useState<string | null>(null);
  // Send while Auto is still checking your boxes: it goes as soon as Auto knows where (never a hold on Send).
  const [sendWhenPlaced, setSendWhenPlaced] = useState(false);
  const selection = boxPicked ?? (placementOn ? AUTO : NEW_BOX);
  // The repositories Auto is asked about, as owner/name: the picked one and any ticked (an environment's once read).
  // A pasted URL only once it reads as a GitHub repository, and never as typed: what the person pasted (a token
  // in its userinfo, say) stays out of the query string, which access logs and network recording keep.
  const placementRepos = useMemo(() => {
    if (environment) return environmentRepos?.id === environment.id ? environmentRepos.repos.map(r => r.repo) : [];
    if (userProject) return userProject.repos.map(r => r.repoKey);
    const first = pick.kind === 'listed' ? pick.fullName : pick.kind === 'pasted' ? repoKey(pick.url) ?? '' : '';
    return [first, ...(multiRepoOn ? morePicked.map(r => r.fullName) : [])].filter(Boolean);
  }, [environment, environmentRepos, userProject, pick, multiRepoOn, morePicked]);
  // The size New box would launch at, once the sizes are read (below): the pool keeps each size apart.
  const [placementSize, setPlacementSize] = useState<string | null>(null);
  // Asked again when a box wakes, sleeps, comes or goes.
  const boxesKey = useMemo(() => boxes.map(b => `${b.id}:${b.status}`).sort().join(','), [boxes]);
  // With a project, Auto asks about it: a box with a checkout of the project, rather than of its repositories.
  const placement = useBoxPlacement(placementOn, placementRepos, placementSize, boxesKey, userProject?.id ?? null);
  // The new box's size: the dropdown shows only while box-default-size is on, preselecting what the
  // server says a box for the repository launches at (its .termag/environment.json, utils/boxSize.ts).

  const [wakingId, setWakingId] = useState<string | null>(null);
  // The box whose wake was refused: Send says so instead of waiting on a box nobody is starting.
  const [wakeFailedId, setWakeFailedId] = useState<string | null>(null);
  // With Runs on: Auto, a box on its way down is listed too: a session on it starts it once it's down.
  const ownBoxes = useMemo(() => (placementOn ? placementBoxes(boxes) : launchableBoxes(boxes)), [boxes, placementOn]);
  // Where the session runs: Auto resolved (its box, New box, or AUTO while the placement loads), else the pick.
  const autoResolved = autoChoice({ view: placement.view, failed: placement.failed, boxIds: new Set(ownBoxes.map(b => b.id)), newBox: NEW_BOX });
  const boxChoice = selection === AUTO ? autoResolved ?? AUTO : selection;
  const chosenBox = boxChoice === NEW_BOX ? null : ownBoxes.find(b => b.id === boxChoice) ?? null;
  // A chosen box that drops out of the list (a reload in flight, a backend
  // restart, a box going away) stays chosen, as it was last seen: Send waits
  // for it rather than quietly launching a new box instead.
  const lastSeenBox = useRef<Instance | null>(null);
  if (chosenBox) lastSeenBox.current = chosenBox;
  const missingBox = boxChoice !== NEW_BOX && boxChoice !== AUTO && !chosenBox
    ? (lastSeenBox.current?.id === boxChoice ? lastSeenBox.current : null)
    : null;
  const drawerBoxes = missingBox ? [...ownBoxes, missingBox] : ownBoxes;
  // The server takes a project on a box that is up, or still launching (it waits for the agent).
  // With Runs on: Auto it also takes the caller's parked box, and wakes it: Send never waits on a box.
  // Not for a schedule: an automation's create still needs its box up (backend routes/projects.ts takes a parked box for a session only).
  const chosenBoxUp = !chosenBox || ['ready', 'provisioning', 'awaiting-agent'].includes(chosenBox.status)
    || (placementOn && !scheduled && WAKEABLE_STATUSES.includes(chosenBox.status));
  // How the session gets its code (pages/chat/CheckoutPicker.tsx): its own
  // clone, or a worktree of a project already on the chosen box with the same
  // repository. A choice that no longer applies falls back to the clone.
  // Picked for a box: with Runs on: Auto a pick holds on the box it was made for, and another box gets its own default.
  const [checkoutPick, setCheckoutPick] = useState<{ box: string | null; choice: string } | null>(null);
  const [worktreeBase, setWorktreeBase] = useState<WorktreeBase>('origin');
  // Only with chat-worktree-sessions-enabled; the server drops the fetch while it is off for the caller.
  const worktreeOn = useFlag(FLAGS.chatWorktreeSessions, false);
  // With Runs on: Auto, a worktree only on a box that is up: making one needs the box's agent there
  // (a parked box gets a new checkout, which waits for its agent).
  const worktreeBox = placementOn && chosenBox?.status !== 'ready' ? null : chosenBox;
  // A project's session is a worktree of the project's own checkouts there, not of any with the same repository.
  const worktreeOptions = useMemo(
    () => (scheduled || !worktreeOn ? []
      : userProject ? projectWorktreeTargets(userProject, projects, worktreeBox?.id ?? null)
      : worktreeTargets(pick, projects, worktreeBox?.id ?? null)),
    [scheduled, worktreeOn, userProject, pick, projects, worktreeBox],
  );
  // Auto's pick of an up box with the repository: a worktree of that checkout (from a fresh fetch, the base's default), not a clone.
  const autoCheckout = placementOn && selection === AUTO && worktreeBox
    ? placement.view?.boxes.find(b => b.instanceId === worktreeBox.id)?.checkoutProjectId ?? null
    : null;
  // A project on a box that is up with a checkout of it: a worktree of that checkout, wherever the box was chosen;
  // the newest when it has several. The choice stays under Options.
  const defaultCheckout = autoCheckout && worktreeOptions.some(p => p.id === autoCheckout) ? autoCheckout
    : userProject && worktreeOptions.length ? worktreeOptions[0].id : OWN_CLONE;
  const checkoutChoice = !placementOn ? checkoutPick?.choice ?? (userProject ? defaultCheckout : OWN_CLONE)
    : checkoutPick && checkoutPick.box === (worktreeBox?.id ?? null) ? checkoutPick.choice : defaultCheckout;
  const setCheckoutChoice = (choice: string) => setCheckoutPick({ box: worktreeBox?.id ?? null, choice });
  // An environment makes a project of its own repositories, never a worktree of another.
  const worktree: Project | null = environment ? null : worktreeOptions.find(p => p.id === checkoutChoice) ?? null;
  // A worktree is one repository's workstream: the extra repositories ticked
  // for a multi-repo project count for nothing there, the permission pick included.
  const ticked = worktree ? [] : more;
  // origin/<default> for a worktree: the project's default branch, else the
  // picked repository's (the same repository, worktreeTargets). A project
  // made from a pasted URL may know neither; then it starts off the checkout.
  // A checkout of several repositories has no one default to fetch (the server refuses a fetched one): off its checkout.
  const worktreeDefault = (p: Project): string | null => (p.layout === 'workspace' ? null
    : p.repoDefaultBranch || (pick.kind === 'listed' ? pick.defaultBranch || null : null));
  const worktreeStart: WorktreeBase = worktree && worktreeDefault(worktree) ? worktreeBase : 'checkout';
  // A worktree from a fresh fetch is new code nobody on the box has looked at,
  // so it asks as a fresh clone does: the permission pill, on the choice last
  // picked for the repository. Full access is offered only where the project
  // itself has it; a read-only project's fetched worktree is read-only too.
  const fetchedTrustable = !!worktree && worktreeStart === 'origin' && worktree.chatTrusted === true;
  // chat-session-permissions-enabled: the bar says which code the session gets (WorktreePill), and a worktree's
  // permission pill names the setting and the checkout (FollowsPermissions' named words), not "As <checkout>".
  const sessionChoicesOn = useFlag(FLAGS.chatSessionPermissions, false);
  // Its workstream's name: the session name if typed, else the message's first words.
  const worktreeNameFor = (typed: string | null) => worktree
    ? worktreeName(typed?.trim() || sessionWords(message) || fallbackName, worktree.workstreams.map(w => w.name))
    : null;
  const [busy, setBusy] = useState<'space' | 'box' | 'chat' | null>(null);
  const [error, setError] = useState('');

  // An environment's model fields are a chat's; its first repository stands for it where one is named (trust, the name).
  const resolvedRepos = environment && environmentRepos?.id === environment.id ? environmentRepos : null;
  const environmentUrls = environment ? (resolvedRepos?.repos ?? []).map(r => githubRepoUrl(r.repo)) : null;
  const fields = environmentUrls
    ? (environmentUrls.length ? newChatCreateFields({ kind: 'pasted', url: environmentUrls[0] }, model) : null)
    : noRepoProject ? noRepoCreateFields(model) : newChatCreateFields(pick, model);
  const repoUrl = fields?.repoUrl ?? null;
  const workspaceRepos = fields && !environment ? selectionRepos({ pick, more: ticked }) : null;
  // What a new box is sized for: every repository of a multi-repo project (the server takes the largest), else the one;
  // an environment's box is sized by its one file instead.
  const sizeRepos = environment ? null : workspaceRepos ? workspaceRepos.map(r => r.url) : repoUrl;
  const { sizes: boxSizes, disk: boxDisk } = useBoxSizes(boxChoice === NEW_BOX, sizeRepos, environment?.name);
  const [boxSize, setBoxSize] = useBoxSizePick(sizeRepos, environment?.name);
  // What Auto asks the pool about: the size picked, else the one preselected for the repository.
  const sizeForPlacement = boxSizes ? sizeToSend(boxSizes, boxSize) ?? boxSizes.defaultSize ?? null : null;
  useEffect(() => { setPlacementSize(sizeForPlacement); }, [sizeForPlacement]);
  // The new box's disk, beside its size: what the person typed, else the repository's diskGiB or 120 (utils/boxDisk.ts).
  const [diskTyped, setDiskTyped] = useBoxDiskPick(sizeRepos, environment?.name);
  const warmBoxReady = useWarmBoxReady(boxChoice === NEW_BOX && !!boxDisk);
  const environmentPool = useEnvironmentPool(boxChoice === NEW_BOX && environment?.visibility === 'shared' ? environment.id : null);
  // What New box makes, named in the drawer once its name, size or disk is changed; a launched one by its own name.
  const newBox = newBoxSummary({
    name: launched ? launched.name : boxName, defaultName: defaults.boxName,
    sizes: boxSizes, picked: boxSize, disk: boxDisk, typed: diskTyped,
  });
  // Every repository asks once, as the permission pill. It opens on the
  // choice last picked for that repository, else a company-org repository on
  // Full access and any other on Read only; a choice applies only to the
  // repository it was made on. The backend records Full access as the trust tick.
  const askTrust = environmentUrls ? environmentUrls.some(u => repoNeedsTrust(u)) : repoNeedsTrust(repoUrl);
  // Its repositories still being read: the pill holds its place, disabled, so it doesn't pop in once they come.
  const environmentResolving = !!environment && !resolvedRepos;
  // Several repositories start on Full access only when every one would on
  // its own, and a choice made for them holds only while the same ones are ticked.
  const selectionUrls = environmentUrls ?? [repoUrl, ...ticked.map(r => githubRepoUrl(r.fullName))];
  const selectionKey = resolvedRepos ? resolvedRepos.repos.map(r => `${r.repo}@${r.branch ?? ''}`).join(' ')
    : selectionUrls.map(u => (u && repoKey(u)) ?? '').join(' ');
  const [trustChoice, setTrustChoice] = useState<{ key: string; checked: boolean } | null>(null);
  // An environment's repositories not read yet name none: Read only until they do, never Full access by default.
  // A shared environment's checkouts are anyone's to set, so neither a repository's owner nor
  // a pick remembered for it vouches for them: its session starts on Read only, and a choice holds per checkout.
  const startsTrusted = selectionUrls.length > 0 && !environment && selectionUrls.every(u => {
    const remembered = readPermissionPick(browserStore(), u);
    return remembered ? remembered === 'full' : repoStartsTrusted(u);
  });
  const trustChecked = trustChoice?.key === selectionKey ? trustChoice.checked : startsTrusted;
  // The bar's worktree pill, where Options offers a worktree: a press makes the session a new checkout, or a worktree
  // of the checkout Auto would pick (else the newest).
  const worktreePill: Project | null = sessionChoicesOn && worktreeOptions.length > 0 && fields && !environment
    ? worktree ?? worktreeOptions.find(p => p.id === defaultCheckout) ?? worktreeOptions[0]
    : null;
  // Act as an orchestrator: the box tells the chat's turns to use the opt-in
  // agent-orchestrator skill, out of the conversation (chat/newChat.ts).
  const [orchestrate, setOrchestrate] = useState(false);
  const orchestrator = orchestratorOption({
    providerHasSkill: !!PROVIDERS[CHAT_PROVIDER_ID]?.orchestratorSkill && !worktree,
    scheduled,
    trusted: askTrust ? trustChecked : true,
    // A box of yours with termag setup off has no skill to use.
    setupOff: isSetupOff(launched ?? chosenBox),
  });
  // A worktree's typed name goes through worktreeName, which makes any text a valid workstream name.
  const nameError = !worktree && name && !PROJECT_NAME_RE.test(name) ? 'Letters, digits, - and _ only' : '';
  const boxError = boxChoice === NEW_BOX && !launched && boxName && !isValidBoxName(boxName) ? BOX_NAME_ERROR : '';
  const diskError = boxChoice === NEW_BOX && !launched ? diskInputError(boxDisk, diskTyped) : null;
  // The schedule as /preview read it: no box is launched for a schedule the
  // API would refuse (too frequent, unreadable).
  const scheduleOk = !scheduled || (draftCron(draft) !== null && !!draft.timezone && !!message.trim() && scheduleCheck.valid);
  // An automation's tier is the permission pill: Full access is the owner's
  // trust tick (the full tier sets chatTrustedAt), Read only runs read-only.
  const scheduleTier: AutomationDraft['tier'] = askTrust ? (trustChecked ? 'full' : 'read') : draft.tier;
  const environmentWait = environment && !environmentUrls?.length && !busy
    ? (resolvedRepos?.error ?? `Reading ${environment.name}…`) : '';
  // With projects on and none picked (still loading, or the person has none yet): Send waits for one.
  const projectWait = projectMode && !userProject && !busy
    ? (userProjects.kind === 'loading' ? 'Loading your projects…' : 'Pick a project, or start from a repository') : '';
  const whyNot = environmentWait || projectWait || startBlocker({
    busy: !!busy, hasRepo: fields !== null, name: worktree ? worktreeNameFor(nameEdit) ?? '' : name, nameError,
    spacesReady: spaceUse.ready, spaceError: spaceUse.error,
    boxReady: !!launched || boxChoice !== NEW_BOX, boxName, boxError: boxError || (diskError ? `Disk: ${diskError}` : ''),
  }) || (chosenBox && !chosenBoxUp && !busy
    ? (wakeFailedId === chosenBox.id ? `${chosenBox.name} didn't wake up: pick it again to retry, or pick another box`
      // Auto's asleep pick isn't woken while composing; a schedule needs its box up, so a pick of it wakes it.
      : scheduled && selection === AUTO && canStartBox(chosenBox) && wakingId !== chosenBox.id ? `A schedule needs its box up: pick ${chosenBox.name} to wake it, or pick another box`
      : `Waiting for ${chosenBox.name} to wake up`)
    : '')
    // Auto still checking your boxes holds nothing: Send goes once it knows where (sendWhenPlaced).
    || (boxChoice !== NEW_BOX && boxChoice !== AUTO && !chosenBox && !busy ? `${missingBox?.name ?? 'That box'} isn't available right now: pick it again or another box` : '')
    || (scheduleOk || busy ? '' : 'Pick a schedule the runs can keep, and say what each run should do')
    || (scheduled && workspaceRepos && !busy ? 'A scheduled run works in one repository: untick the others' : '')
    || (scheduled && environment && !busy ? "A schedule doesn't take an environment yet: pick its repository instead" : '')
    || (scheduled && noRepoProject && !busy ? 'A scheduled run works in a repository: pick a project with one' : '')
    // A new checkout of a project with several repositories is a multi-repo create, which the server refuses while
    // multi-repo projects are off for the person (a worktree of a checkout it has still works).
    || (userProject && userProject.repos.length > 1 && !multiRepoOn && !worktree && !busy
      ? `${userProject.name} has several repositories, which aren't on for you: pick another project, or start from a repository` : '')
    || (scheduled && (attachments.images.length || attachments.files.length) && !busy ? 'A scheduled run takes no attachments: remove them' : '')
    || (attachments.preparing && !busy ? 'Getting the attachments ready to send' : '')
    || (!scheduled && !busy ? messageTooLong(firstMessage) ?? '' : '');
  // A plain chat still needs a message to send, just without a written hint.
  // Attachments alone are a first message too, as in an open chat.
  const hasAttachments = takesImages && (attachments.images.length > 0 || attachments.files.length > 0);
  const messageMissing = !busy && !scheduled && !message.trim() && !hasAttachments;
  const canStart = !busy && !blocked && !whyNot && !messageMissing;

  // A new repository renames the session and the box after it again, and is
  // what the next New session opens on as soon as it is picked: a pasted URL
  // only once it reads as a repository, so a half-typed one never is.
  function choosePick(next: RepoPick) {
    setPick(next);
    setMore([]);
    if (next.kind === 'listed' || (next.kind === 'pasted' && repoKey(next.url))) {
      rememberStartPick(browserStore(), { pick: next });
    }
    setNameEdit(null);
    setBoxEdit(null);
    setError('');
  }

  // A tick in the repository menu. The session is named after the first repository, so only a new first one renames it.
  function toggleMore(repo: ListedPick) {
    const next = toggleRepo({ pick, more }, repo);
    setMore(next.more);
    if (next.pick === pick) return;
    setPick(next.pick);
    if (next.pick.kind === 'listed') rememberStartPick(browserStore(), { pick: next.pick });
    setNameEdit(null);
    setBoxEdit(null);
    setError('');
  }

  function chooseBox(choice: string) {
    setBoxChoice(choice);
    setError('');
    const box = ownBoxes.find(b => b.id === choice);
    if (!box || !canStartBox(box) || wakingId === box.id) return;
    setWakingId(box.id);
    setWakeFailedId(null);
    instancesApi.start(box.id)
      .then(r => {
        // Starting now, whatever the next list says: the feed keeps polling a
        // starting box, and canStartBox no longer offers a second start.
        boxFeed.upsert({ ...box, status: r?.status ?? 'starting' });
        return boxFeed.reload();
      })
      .catch(err => {
        setWakeFailedId(box.id);
        setError(apiError(err, `Could not wake ${box.name}`));
      })
      .finally(() => setWakingId(w => (w === box.id ? null : w)));
  }

  /**
   * With Runs on: Auto, once a session exists: a hot box it was started on
   * leaves a note in its transcript (never a gate), and a parked one it woke
   * is read again, so the session narrates the wake from the box's new state.
   */
  function noteSessionPlaced(projectId: string, ws: string, onBox: Instance | null) {
    if (!placementOn || !onBox) return;
    const note = placement.view ? hotBoxNote(placement.view.boxes.find(b => b.instanceId === onBox.id), placement.view) : null;
    if (note) writeHotBoxNotice(browserStore(), `${projectId}|${ws}`, note);
    if (WAKEABLE_STATUSES.includes(onBox.status)) void boxFeed.reload();
  }

  // Send while Auto is still checking your boxes: it goes as soon as Auto knows where (never a hold on Send).
  useEffect(() => {
    if (!sendWhenPlaced || boxChoice === AUTO) return;
    setSendWhenPlaced(false);
    void start(undefined, true);
  }, [sendWhenPlaced, boxChoice]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start(e?: React.FormEvent, placed = false) {
    e?.preventDefault();
    if (!canStart || !fields) return;
    // Taken once: a second Send while Auto checks does nothing (the effect below sends it once Auto knows where).
    if (sendWhenPlaced && !placed) return;
    if (boxChoice === AUTO) { setSendWhenPlaced(true); return; }
    // Never a new box for a chosen one that is missing (whyNot holds Send for it too).
    if (boxChoice !== NEW_BOX && !chosenBox) return;
    dictation.detach();
    setError('');
    setRepoOpen(false);
    setModelOpen(false);
    setPermissionOpen(false);
    closeProjectMenu();
    dismissSpaceMenu();
    let space: string | null;
    try {
      setBusy('space');
      space = await spaceUse.prepare();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
      return;
    }
    let box = chosenBox ?? launched;
    if (!box) {
      setBusy('box');
      noteAddBoxClick();
      try {
        const r = await instancesApi.create(boxName, 'ec2', { size: sizeToSend(boxSizes, boxSize), diskGiB: diskToSend(boxDisk, diskTyped), repo: sizeRepos, environment: environment?.name });
        if (r.claimed) noteBoxClaimed(r.instance.id);
        boxFeed.upsert(r.instance);
        box = r.instance;
        setLaunched(box);
      } catch (err) {
        const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
        if (code === 'github-required') setGate('blocked');
        else setError(apiError(err, 'Could not launch a box'));
        setBusy(null);
        return;
      }
    }
    try {
      setBusy('space');
      await spaceUse.grant(space, box.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
      return;
    }
    setBusy('chat');
    if (worktree) {
      await startWorktree(worktree, space);
      return;
    }
    if (scheduled) {
      try {
        const created = await automationsApi.create({
          name, instanceId: box.id,
          repoUrl: fields.repoUrl,
          defaultBranch: fields.defaultBranch,
          replaySessionId: await replaySessionId(),
          ...draftBody({ ...draft, prompt: message }),
          claudeModel: fields.claudeModel,
          ...(fields.backend ? { backend: fields.backend, model: fields.model } : {}),
          // The full tier is the owner's trust tick (it sets chatTrustedAt): a
          // repository left on Read only runs read-only.
          tier: scheduleTier,
          // With the simple UI's automation pages, the space picked is the automation's: it is listed there (chat/automationPlaces.ts).
          ...(simpleAutomations && space ? { spaceName: space } : {}),
        });
        noteProjectCreated(created.project.id, box.id);
        // An automation runs at the default effort, but the next New session keeps the one picked.
        writeLastStart(browserStore(), { pick, space, model, effort });
        // A run-less automation is listed only from the shared automations list: reload it too, not wait for its poll.
        await Promise.all([reloadProjects().catch(() => {}), reloadAutomations()]);
        navigate(simpleAutomations ? automationHref(created.project.id) : `/automations/${encodeURIComponent(created.project.id)}`);
      } catch (err) {
        if (isBoxFailedRefusal(err)) {
          setLaunched(null);
          await boxFeed.reload();
          setError('The box failed to launch. Start again to launch another.');
        } else {
          setError(apiError(err, 'Could not create the automation'));
        }
        setBusy(null);
      }
      return;
    }
    try {
      const body = {
        instanceId: box.id,
        initialAgent: { enabled: true, provider: CHAT_PROVIDER_ID, ...(fields.backend ? { backend: fields.backend, model: fields.model } : {}) },
        replaySessionId: await replaySessionId(),
        // The checkouts it was read as (and any Full access given for): the server holds the create to them, since an ask
        // of the project runs them without asking whenever it comes (Bugbot, #985).
        // A project's own repositories as it keeps them (an ssh URL stays ssh), not as the pick reads them.
        ...(environment ? { environment: environment.name, environmentRepos: checkoutsPin(resolvedRepos?.repos ?? []) }
          : (userProject && projectCreateRepos(userProject))
            || (workspaceRepos ? { repos: workspaceRepos } : { repoUrl: fields.repoUrl, defaultBranch: fields.defaultBranch })),
        claudeModel: fields.claudeModel,
        chatTrusted: askTrust && trustChecked,
        ...(orchestrate && orchestrator === 'available' ? { chatOrchestrator: true } : {}),
        // The chat belongs to the space it was started in, or to none, for good (backend services/chatSpace.ts).
        // With no pill (project-files-enabled) and the project named, an explicit none: the server pins the session to
        // its project's files at the create, or with none to no space, never leaving it for a box's first grant. A
        // repository's or an environment's create names no project: the server finds it and gives the session its
        // Project files after the create, which a space fixed now would block, so it sends nothing.
        ...(spaceUse.show || (spaceUse !== spaceStep && userProject) ? { chatSpace: space } : {}),
        // The project it starts in: the checkout is one of it.
        ...(userProject ? { userProjectId: userProject.id } : {}),
      };
      let project: Project;
      try {
        project = await projectsApi.create({ name, ...body });
      } catch (err) {
        // A project's checkout name is New session's to choose, so a name another checkout holds (one made meanwhile,
        // or an archived one, which a project's create never brings back) is tried once more with the next suffix.
        if (!userProject || apiCode(err) !== 'checkout_name_taken') throw err;
        const base = nameEdit?.trim() || checkoutBaseName(userProject);
        project = await projectsApi.create({ name: nextCheckoutName(base, name, projects.map(p => p.name)), ...body });
      }
      noteProjectCreated(project.id, box.id);
      noteSessionPlaced(project.id, 'main', box);
      // With no space pill a session picked none: the remembered space (New automation's default) stays as it was.
      writeLastStart(browserStore(), { pick, space: spaceUse === spaceStep ? space : last.space ?? null, model, effort });
      // The first message goes from the session's view, at this effort (chat/useChatEffort.ts).
      writeEffortPick(`${project.id}|main`, effort);
      // The attachments' count goes in storage before the text, so a reload never finds the text without it.
      holdFirstImages(browserStore(), project.id, attachments.images);
      const first = queuedFirstText(browserStore(), project.id, firstMessage, attachments.images.length);
      const held = first != null && writeQueued(browserStore(), project.id, first);
      // Sent later by the chat's sendQueued, not its composer, so counted here.
      // Not held, it goes to the composer as a draft, which counts it when it is sent.
      if (held && message.trim()) recordTypedChatCommand(message, 'new');
      await reloadProjects().catch(() => {});
      // Its tab goes in the space it was started in (the sidebar groups a chat by its own space).
      if (space) simple?.items.open({ kind: 'chat', projectId: project.id, workstream: 'main' }, null);
      navigate(chatHref(project.id, 'main'), held ? undefined : { state: { draft: firstMessage } });
    } catch (err) {
      if (isBoxFailedRefusal(err)) {
        setLaunched(null);
        await boxFeed.reload();
        setError('The box failed to launch. Start again to launch another.');
      } else if (userProject && ['user_project_archived', 'user_project_not_found', 'user_project_repos_mismatch'].includes(apiCode(err) ?? '')) {
        // Archived (or changed) elsewhere since the list was read: say so, read the projects again, and open the menu.
        const code = apiCode(err);
        setError(code === 'user_project_repos_mismatch'
          ? `${userProject.name}'s repositories changed since this page read them. Check them and send again.`
          : `${userProject.name} was ${code === 'user_project_archived' ? 'archived' : 'removed'}. Pick another project.`);
        userProjects.reload();
        // Changed: the same project, read again, so the next Send sends its repositories as they are now.
        // Archived or gone: the menu opens to pick another.
        if (code === 'user_project_repos_mismatch') setProjectChoice(userProject.id);
        else { setProjectChoice(null); setProjectOpen(true); }
      } else {
        setError(apiError(err, 'Could not start the session'));
        if (apiCode(err) === 'environment_repos_changed') setEnvironmentReads(n => n + 1);
      }
      setBusy(null);
    }
  }

  // A worktree of an existing project: a new workstream, from origin/<default>
  // fetched now or off the project's checkout as the full UI's Branch off…
  // does. Off the checkout it runs with the project's permissions; from a
  // fetch, with the permission picked here (fullAccess), Full access only on a
  // trusted project. A box too old to make a person's fetched tree refuses
  // (backend createWorkstreamFor). The first message waits in the
  // workstream's own queue.
  async function startWorktree(project: Project, space: string | null) {
    const wsName = worktreeNameFor(nameEdit) ?? 'session';
    const branch = worktreeDefault(project);
    try {
      // The chat belongs to the space it was started in, as a clone's does (backend services/chatSpace.ts).
      const inSpace = spaceUse.show || spaceUse !== spaceStep ? { chatSpace: space } : {};
      const ws = await workstreamsApi.create(project.id, worktreeStart === 'origin' && branch
        ? { name: wsName, baseRef: `origin/${branch}`, fetch: { remoteBranch: branch, fullAccess: fetchedTrustable && trustChecked }, ...inSpace, newSession: true }
        : { name: wsName, ...inSpace, newSession: true });
      // Its first message goes from its own view, on the model and at the effort picked here.
      noteSessionPlaced(project.id, ws.name, worktreeBox);
      writeModelPick(`${project.id}|${ws.name}`, model);
      writeEffortPick(`${project.id}|${ws.name}`, effort);
      writeLastStart(browserStore(), { pick, space, model, effort });
      holdFirstImages(browserStore(), queueKey(project.id, ws.name), attachments.images);
      const first = queuedFirstText(browserStore(), queueKey(project.id, ws.name), firstMessage, attachments.images.length);
      const held = first != null && writeQueued(browserStore(), queueKey(project.id, ws.name), first);
      await reloadProjects().catch(() => {});
      navigate(chatHref(project.id, ws.name), held ? undefined : { state: { draft: firstMessage } });
    } catch (err) {
      setError(apiError(err, `Could not start a worktree of ${project.name}`));
      setBusy(null);
    }
  }

  if (blocked) {
    return (
      <NewChatFrame>
        <div className="chat-compose">
          <h2>Connect GitHub first</h2>
          <p>Every session runs on its own box, and termag needs your GitHub token to launch one and check your repository out there.</p>
          <Link className="btn-primary" to="/settings?from=chat">Connect GitHub in Settings</Link>
        </div>
      </NewChatFrame>
    );
  }

  const sendLabel = sendWhenPlaced ? 'Finding a box'
    : busy === 'space' ? 'Setting up the space'
    : busy === 'box' ? 'Launching a box'
    : busy === 'chat' ? (scheduled ? 'Creating' : 'Starting')
    : scheduled ? 'Create automation' : 'Send';

  return (
    <NewChatFrame>
      <form ref={rootRef} className="chat-compose chat-new-card" onSubmit={e => void start(e)} {...(takesImages && !busy ? attachments.dropHandlers(() => messageRef.current?.focus()) : {})}>
        {attachments.dragging && <div className="chat-drop-overlay" aria-hidden="true">Drop images to attach</div>}
        {/* One sentence that wraps as text: the repository and its "?" are one unbreakable piece (chat.css). */}
        <div className="chat-launch-ask">
        {fields || environment ? 'What are we doing in ' : 'What are we doing? '}
        <span className="chat-launch-subject">
        {environment ? (
          <span className="chat-launch-environment" title={environment.name}>{environment.name}</span>
        ) : projectMode ? (
        <ProjectPicker
          state={userProjects}
          selected={userProject}
          // Picked, the next thing to do is say what to do there: the cursor goes to the message once the menu has closed.
          onSelect={p => { setProjectChoice(p.id); setNameEdit(null); setBoxEdit(null); setCheckoutPick(null); setError(''); focusMessageSoon(); }}
          onFromRepository={() => { setFromRepository(true); setRepoOpen(true); setError(''); }}
          // + New project: listed at once and picked; Send makes its first checkout on the box Runs on picked.
          onCreated={p => { userProjects.upsert(p); setProjectChoice(p.id); setNameEdit(null); setBoxEdit(null); setCheckoutPick(null); setError(''); focusMessageSoon(); }}
          multiRepo={multiRepoOn}
          open={projectOpen}
          onOpenChange={open => { setProjectOpen(open); if (open) { setRepoOpen(false); setModelOpen(false); setPermissionOpen(false); dismissSpaceMenu(); } }}
          disabled={!!busy}
        />
        ) : (
        <RepoPicker
          pick={pick}
          onPick={choosePick}
          empty={!fields}
          open={repoOpen}
          onOpenChange={open => { setRepoOpen(open); if (open) { setModelOpen(false); setPermissionOpen(false); dismissSpaceMenu(); } }}
          more={ticked}
          onToggle={multiRepoOn && !worktree ? toggleMore : undefined}
          // From a repository…: back to the projects, while they're there to go back to.
          back={fromRepository && userProjects.kind === 'ready' ? { label: 'Your projects', onBack: () => { setFromRepository(false); setRepoOpen(false); setProjectOpen(true); } } : undefined}
        />
        )}
        {(fields || environment) && <span className="chat-launch-q" aria-hidden="true">?</span>}
        </span>
        </div>
        {/* Projects that couldn't be read: today's repository picker, and Send works as it always has (the server files the session under a project). */}
        {projectsOn && userProjects.kind === 'failed' && !environment && (
          <div className={`${LP_THEME} chat-launch-project-note`} role="status">
            Couldn't load your projects; pick a repository.
            <Button variant="minimal" size="small" onPress={() => userProjects.reload()}>Try again</Button>
          </div>
        )}
        {/* What it clones, on screen before Send whatever the permission: an ask of the project runs them unprompted. */}
        {resolvedRepos?.repos.length ? <EnvironmentCheckouts repos={resolvedRepos.repos} className="chat-launch-checkouts" /> : null}

        {/* The composer and its drawer, with no gap between them: the drawer tucks under the composer. */}
        <div className="chat-launch-composer">
        <div className="chat-compose-box" {...refDrop.handlers} data-ref-drop={refDrop.over || undefined}>
          {(takesImages || attachments.images.length > 0 || attachments.files.length > 0) && <ComposerImages images={attachments.images} files={attachments.files} onRemove={attachments.remove} disabled={!!busy} />}
          <textarea
            ref={messageRef}
            className="chat-compose-input"
            value={message}
            // A run's prompt is the automation's (up to 20,000 characters, routes/automations.ts); a chat message is typed into a pane.
            onChange={e => { dictation.onEdit(); setMessage(e.target.value.slice(0, scheduled ? MAX_AUTOMATION_PROMPT : MAX_KEYS)); }}
            onPaste={takesImages && !busy ? attachments.onPaste : undefined}
            onKeyDown={e => {
              if (dictation.onKeyDown(e)) return;
              // Enter sends a chat; an automation's prompt is a document, and the send arrow creates it.
              if (scheduled || !isSendKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) return;
              e.preventDefault();
              void start();
            }}
            placeholder={scheduled ? 'What each run should do. It starts on a fresh branch, with notes from earlier runs.' : `What should ${chatAgentName(model, modelOptions) ?? 'it'} do?`}
            aria-label="Message"
            rows={4}
          />
          <div className="chat-compose-bar" data-extras={worktreePill ? 'wide' : undefined}>
            <div className="chat-compose-pills">
            <ModelPicker
              model={model}
              options={modelOptions}
              onChange={setModel}
              effort={scheduled ? null : effort}
              onEffortChange={setEffort}
              open={modelOpen}
              onOpenChange={open => { setModelOpen(open); if (open) { setRepoOpen(false); setPermissionOpen(false); closeProjectMenu(); dismissSpaceMenu(); } }}
            />
            {/* Permissions and the orchestrator: beside the model where the bar has room, else a
                row of their own above it (chat.css, the composer bar's container query). */}
            <div className="chat-compose-extras">
            {worktreePill && (
              <WorktreePill
                worktree={worktree?.name ?? null}
                target={worktreePill.name}
                of={userProject ? userProject.name : repoTriggerLabel(pick)}
                fetchedFrom={worktree && worktreeStart === 'origin' ? `origin/${worktreeDefault(worktree)}` : null}
                onSwitch={() => setCheckoutChoice(worktree ? OWN_CLONE : worktreePill.id)}
                disabled={!!busy}
              />
            )}
            {worktree && !fetchedTrustable ? (
              <FollowsPermissions
                project={worktree.name}
                fetched={worktreeStart === 'origin'}
                named={sessionChoicesOn ? { trusted: worktree.chatTrusted === true, of: userProject?.name ?? null } : undefined}
              />
            ) : (askTrust || environmentResolving) && (
              <PermissionPicker
                value={trustChecked ? 'full' : 'read'}
                onChange={choice => {
                  setTrustChoice({ key: selectionKey, checked: choice === 'full' });
                  // Remembered for the picker's one repository; an environment's choice is for its checkouts alone.
                  if (ticked.length === 0 && !environment) writePermissionPick(browserStore(), repoUrl, choice);
                }}
                open={permissionOpen}
                onOpenChange={open => { setPermissionOpen(open); if (open) { setRepoOpen(false); setModelOpen(false); closeProjectMenu(); dismissSpaceMenu(); } }}
                checkouts={resolvedRepos?.repos.map(r => (r.branch ? `${r.repo} at ${r.branch}` : r.repo))}
                scheduled={scheduled}
                disabled={!!busy || environmentResolving}
              />
            )}
            {orchestrator !== 'hidden' && (
              <OrchestratorToggle on={orchestrate} onChange={setOrchestrate} state={orchestrator} disabled={!!busy} />
            )}
            </div>
            </div>
            <div className="chat-compose-actions">
            {takesImages && <ComposerAttach onFiles={files => { void attachments.attach(files); }} disabled={!!busy} className="chat-compose-mic chat-compose-attach" />}
            <DictationButton dictation={dictation} disabled={!!busy} className="chat-compose-mic" />
            {/* Shows once there is a message, and stays while the session starts. */}
            {(message.trim() || hasAttachments || busy) && (
              <button type="submit" className="chat-compose-send" aria-label={sendLabel} disabled={!canStart || sendWhenPlaced} aria-describedby={whyNot ? 'chat-new-why' : undefined}>
                <SendIcon />
              </button>
            )}
            </div>
          </div>
        </div>
        <LaunchDrawer
          boxes={drawerBoxes}
          boxChoice={boxChoice}
          onBoxChoice={chooseBox}
          placement={placementOn ? {
            view: placement.view, failed: placement.failed, onRetry: placement.retry, selection,
            repoWords: userProject ? `has ${userProject.name}` : repoWordsFor(placementRepos),
            // A type the repository's requirements matched is never in the pool, which holds presets only.
            // So is one whose size's own ask failed: the pool's answer for it isn't known (useBoxPlacement sizeStale).
            newBoxCold: placement.sizeStale || (!!boxSizes && (boxSize ?? preselectedSize(boxSizes)) === REPO_DEFAULT),
          } : null}
          wakingId={wakingId}
          newBox={newBox}
          disabled={!!busy}
          // After a launched box's project was refused, the retry keeps that box; the session name stays editable.
          boxLocked={!!launched}
          space={spaceUse.pending ? (
            // Spaces still loading: the trigger holds its place, disabled, so nothing shifts when they come.
            <SpacePicker {...spaceUse.pickerProps} disabled menuEpoch={spaceMenuEpoch} onOpen={() => {}} />
          ) : spaceUse.show ? (
            <SpacePicker
              {...spaceUse.pickerProps}
              // A space is remembered once picked; a new one only once the session makes it.
              onChange={next => {
                spaceUse.pickerProps.onChange(next);
                if (next.kind !== 'new') rememberStartPick(browserStore(), { space: next.kind === 'existing' ? next.name : null });
              }}
              error={spaceUse.error}
              disabled={!!busy}
              menuEpoch={spaceMenuEpoch}
              onOpen={() => { setRepoOpen(false); setModelOpen(false); setPermissionOpen(false); closeProjectMenu(); }}
            />
          ) : null}
          // Offered with no environment too (its dialog's New environment makes one from here), unless environment selection is off.
          environment={environmentSelection ? (
            <EnvironmentSelect
              environments={environments}
              value={environment?.name ?? null}
              onChange={name => { setEnvironmentName(name ?? ''); setNameEdit(null); setBoxEdit(null); setError(''); }}
              disabled={!!busy || !!launched}
              // The space's epoch: what closes its dialog (a menu opening, a send) closes this one too.
              menuEpoch={spaceMenuEpoch}
              onOpen={() => { setRepoOpen(false); setModelOpen(false); setPermissionOpen(false); closeProjectMenu(); }}
            />
          ) : null}
          checkout={worktreeOptions.length > 0 && fields && !environment ? (
            <CheckoutPicker
              choice={worktree ? worktree.id : OWN_CLONE}
              onChoice={setCheckoutChoice}
              base={worktreeStart}
              onBase={setWorktreeBase}
              targets={worktreeOptions}
              defaultBranchOf={worktreeDefault}
              repoName={userProject ? userProject.name : repoTriggerLabel(pick)}
              disabled={!!busy}
              onOpen={() => { setRepoOpen(false); setModelOpen(false); setPermissionOpen(false); closeProjectMenu(); dismissSpaceMenu(); }}
            />
          ) : null}
          schedule={automationsOn ? (
            <SchedulePicker
              scheduled={scheduled}
              onScheduledChange={setScheduled}
              draft={{ ...draft, prompt: message, tier: scheduleTier }}
              onDraftChange={setDraft}
              check={scheduleCheck}
              tierElsewhere={askTrust}
              disabled={!!busy}
              onOpen={() => { setRepoOpen(false); setModelOpen(false); setPermissionOpen(false); closeProjectMenu(); dismissSpaceMenu(); }}
            />
          ) : null}
          newBoxName={
            <label className="chat-new-field chat-launch-new-field">
              <span>Name</span>
              <input value={launched ? launched.name : boxEdit ?? defaults.boxName} disabled={!!launched} onChange={e => setBoxEdit(e.target.value)} aria-label="Box name" />
              {boxError && <span className="chat-new-error">{boxError}</span>}
              {/* A pooled environment's box: a stopped one with its setup run starts. */}
              {!launched && poolHasBox(environmentPool) && <span className="chat-new-hint">{POOL_READY_HINT}</span>}
            </label>
          }
          newBoxSize={!launched && (boxSizes || boxDisk)
            ? <>
              {boxSizes && <BoxSizeSelect options={boxSizes} picked={boxSize} onPick={setBoxSize} disabled={!!busy} className="chat-launch-new-size" />}
              {boxDisk && <BoxDiskInput disk={boxDisk} typed={diskTyped} onType={setDiskTyped} warmBoxReady={warmBoxReady} disabled={!!busy} className="chat-launch-new-disk" />}
            </>
            : null}
          sessionName={
            <label className="chat-new-field">
              <span>Session name</span>
              <input value={nameEdit ?? worktreeNameFor(null) ?? defaults.projectName} onChange={e => setNameEdit(e.target.value)} />
              {nameError && <span className="chat-new-error">{nameError}</span>}
            </label>
          }
        />
        </div>
        <DictationNote dictation={dictation} className="chat-compose-status" />
        {takesImages && attachments.note && <div className="chat-compose-error" role="status">{attachments.note}</div>}

        {/* Why Send is disabled: only once there is a message to send. */}
        {whyNot && (message.trim() || hasAttachments || scheduled) && <span className="chat-compose-why" id="chat-new-why">{whyNot}</span>}
        {sendWhenPlaced && !busy && <div className="chat-compose-status" role="status">Finding a box…</div>}
        {busy && <div className="chat-compose-status" role="status">{busy === 'space' ? 'Setting up the space…' : busy === 'box' ? 'Launching a box…' : scheduled ? 'Creating…' : 'Starting…'}</div>}
        {error && <div className="chat-compose-error" role="alert">{error}</div>}
        {refDrop.note && <div className="chat-compose-error" role="status">{refDrop.note}</div>}
      </form>
    </NewChatFrame>
  );
}
