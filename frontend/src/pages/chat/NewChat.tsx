// New chat in the simple UI: one composer. The question above it names the
// repository, the Claude model and the permissions sit in its bar, and the
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
import { chatAgentName, chatModelTakesPdfs, newChatCreateFields, repoTriggerLabel, type ChatEffortId, type ChatModelId } from '../../chat/composer';
import { CHAT_PROVIDER_ID, PROVIDERS } from '../../providers/registry';
import { isSendKey, MAX_KEYS } from '../../chat/compose';
import type { Instance, Project } from '../../types';
import { SpacePicker } from './SpacePicker';
import { RepoPicker } from './RepoPicker';
import { SchedulePicker } from './SchedulePicker';
import { ModelPicker } from '../../chat/ModelPicker';
import { writeEffortPick } from '../../chat/useChatEffort';
import { FollowsPermissions, PermissionPicker } from '../../chat/PermissionPicker';
import { writeModelPick } from '../../chat/useChatModel';
import { CheckoutPicker, OWN_CLONE, type WorktreeBase } from './CheckoutPicker';
import { OrchestratorToggle } from '../../chat/OrchestratorToggle';
import { launchableBoxes, LaunchDrawer, NEW_BOX, newBoxSummary } from './LaunchDrawer';
import { BoxSizeSelect } from '../../components/BoxSizePicker';
import { BoxDiskInput } from '../../components/BoxDiskField';
import { useBoxDiskPick, useBoxSizePick, useBoxSizes } from '../../hooks/useBoxSizes';
import { useWarmBoxReady } from '../../hooks/useWarmBoxReady';
import { useEnvironmentPool } from '../../hooks/useEnvironmentPool';
import { poolHasBox, POOL_READY_HINT } from '../../utils/environmentPool';
import { sizeToSend } from '../../utils/boxSize';
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

/** The automation API's prompt cap (backend routes/automations.ts MAX_PROMPT). */
const MAX_AUTOMATION_PROMPT = 20_000;

const PROJECT_NAME_RE = /^[a-zA-Z0-9_-]+$/;

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

  const [pick, setPick] = useState<RepoPick>(last.pick ?? { kind: 'empty' });
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
  // More repositories ticked after the pick: two or more make a multi-repo
  // project. Only with multi-repo-projects-enabled.
  const multiRepoOn = useFlag(FLAGS.multiRepo, false);
  const [morePicked, setMore] = useState<ListedPick[]>([]);
  const more = multiRepoOn ? morePicked : [];
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
  const defaults = useMemo(
    () => newChatNames((environment ? environment.name : suggestedName(pick)) ?? fallbackName, projects.map(p => p.name), boxes.map(b => b.name)),
    [pick, environment, fallbackName, projects, boxes],
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
  // Where the session runs: NEW_BOX, or the id of one of the user's boxes.
  // An asleep box is woken when it is picked; the start waits until it is up.
  const [boxChoice, setBoxChoice] = useState<string>(NEW_BOX);
  // The new box's size: the dropdown shows only while box-default-size is on, preselecting what the
  // server says a box for the repository launches at (its .termag/environment.json, utils/boxSize.ts).

  const [wakingId, setWakingId] = useState<string | null>(null);
  // The box whose wake was refused: Send says so instead of waiting on a box nobody is starting.
  const [wakeFailedId, setWakeFailedId] = useState<string | null>(null);
  const ownBoxes = useMemo(() => launchableBoxes(boxes), [boxes]);
  const chosenBox = boxChoice === NEW_BOX ? null : ownBoxes.find(b => b.id === boxChoice) ?? null;
  // A chosen box that drops out of the list (a reload in flight, a backend
  // restart, a box going away) stays chosen, as it was last seen: Send waits
  // for it rather than quietly launching a new box instead.
  const lastSeenBox = useRef<Instance | null>(null);
  if (chosenBox) lastSeenBox.current = chosenBox;
  const missingBox = boxChoice !== NEW_BOX && !chosenBox
    ? (lastSeenBox.current?.id === boxChoice ? lastSeenBox.current : null)
    : null;
  const drawerBoxes = missingBox ? [...ownBoxes, missingBox] : ownBoxes;
  // The server takes a project on a box that is up, or still launching (it waits for the agent).
  const chosenBoxUp = !chosenBox || ['ready', 'provisioning', 'awaiting-agent'].includes(chosenBox.status);
  // How the session gets its code (pages/chat/CheckoutPicker.tsx): its own
  // clone, or a worktree of a project already on the chosen box with the same
  // repository. A choice that no longer applies falls back to the clone.
  const [checkoutChoice, setCheckoutChoice] = useState<string>(OWN_CLONE);
  const [worktreeBase, setWorktreeBase] = useState<WorktreeBase>('origin');
  // Only with chat-worktree-sessions-enabled; the server drops the fetch while it is off for the caller.
  const worktreeOn = useFlag(FLAGS.chatWorktreeSessions, false);
  const worktreeOptions = useMemo(
    () => (scheduled || !worktreeOn ? [] : worktreeTargets(pick, projects, chosenBox?.id ?? null)),
    [scheduled, worktreeOn, pick, projects, chosenBox],
  );
  // An environment makes a project of its own repositories, never a worktree of another.
  const worktree: Project | null = environment ? null : worktreeOptions.find(p => p.id === checkoutChoice) ?? null;
  // A worktree is one repository's workstream: the extra repositories ticked
  // for a multi-repo project count for nothing there, the permission pick included.
  const ticked = worktree ? [] : more;
  // origin/<default> for a worktree: the project's default branch, else the
  // picked repository's (the same repository, worktreeTargets). A project
  // made from a pasted URL may know neither; then it starts off the checkout.
  const worktreeDefault = (p: Project): string | null =>
    p.repoDefaultBranch || (pick.kind === 'listed' ? pick.defaultBranch || null : null);
  const worktreeStart: WorktreeBase = worktree && worktreeDefault(worktree) ? worktreeBase : 'checkout';
  // A worktree from a fresh fetch is new code nobody on the box has looked at,
  // so it asks as a fresh clone does: the permission pill, on the choice last
  // picked for the repository. Full access is offered only where the project
  // itself has it; a read-only project's fetched worktree is read-only too.
  const fetchedTrustable = !!worktree && worktreeStart === 'origin' && worktree.chatTrusted === true;
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
    : newChatCreateFields(pick, model);
  const repoUrl = fields?.repoUrl ?? null;
  const workspaceRepos = fields && !environment ? selectionRepos({ pick, more: ticked }) : null;
  // What a new box is sized for: every repository of a multi-repo project (the server takes the largest), else the one;
  // an environment's box is sized by its one file instead.
  const sizeRepos = environment ? null : workspaceRepos ? workspaceRepos.map(r => r.url) : repoUrl;
  const { sizes: boxSizes, disk: boxDisk } = useBoxSizes(boxChoice === NEW_BOX, sizeRepos, environment?.name);
  const [boxSize, setBoxSize] = useBoxSizePick(sizeRepos, environment?.name);
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
  const whyNot = environmentWait || startBlocker({
    busy: !!busy, hasRepo: fields !== null, name: worktree ? worktreeNameFor(nameEdit) ?? '' : name, nameError,
    spacesReady: spaceStep.ready, spaceError: spaceStep.error,
    boxReady: !!launched || boxChoice !== NEW_BOX, boxName, boxError: boxError || (diskError ? `Disk: ${diskError}` : ''),
  }) || (chosenBox && !chosenBoxUp && !busy
    ? (wakeFailedId === chosenBox.id ? `${chosenBox.name} didn't wake up: pick it again to retry, or pick another box` : `Waiting for ${chosenBox.name} to wake up`)
    : '')
    || (boxChoice !== NEW_BOX && !chosenBox && !busy ? `${missingBox?.name ?? 'That box'} isn't available right now: pick it again or another box` : '')
    || (scheduleOk || busy ? '' : 'Pick a schedule the runs can keep, and say what each run should do')
    || (scheduled && workspaceRepos && !busy ? 'A scheduled run works in one repository: untick the others' : '')
    || (scheduled && environment && !busy ? "A schedule doesn't take an environment yet: pick its repository instead" : '')
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

  async function start(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canStart || !fields) return;
    // Never a new box for a chosen one that is missing (whyNot holds Send for it too).
    if (boxChoice !== NEW_BOX && !chosenBox) return;
    dictation.detach();
    setError('');
    setRepoOpen(false);
    setModelOpen(false);
    setPermissionOpen(false);
    dismissSpaceMenu();
    let space: string | null;
    try {
      setBusy('space');
      space = await spaceStep.prepare();
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
      await spaceStep.grant(space, box.id);
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
      const project = await projectsApi.create({
        name,
        instanceId: box.id,
        initialAgent: { enabled: true, provider: CHAT_PROVIDER_ID, ...(fields.backend ? { backend: fields.backend, model: fields.model } : {}) },
        replaySessionId: await replaySessionId(),
        // The checkouts it was read as (and any Full access given for): the server holds the create to them, since an ask
        // of the project runs them without asking whenever it comes (Bugbot, #985).
        ...(environment ? { environment: environment.name, environmentRepos: checkoutsPin(resolvedRepos?.repos ?? []) }
          : workspaceRepos ? { repos: workspaceRepos } : { repoUrl: fields.repoUrl, defaultBranch: fields.defaultBranch }),
        claudeModel: fields.claudeModel,
        chatTrusted: askTrust && trustChecked,
        ...(orchestrate && orchestrator === 'available' ? { chatOrchestrator: true } : {}),
        // The chat belongs to the space it was started in, or to none, for good (backend services/chatSpace.ts).
        ...(spaceStep.show ? { chatSpace: space } : {}),
      });
      noteProjectCreated(project.id, box.id);
      writeLastStart(browserStore(), { pick, space, model, effort });
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
      } else {
        setError(apiError(err, 'Could not start the session'));
        if ((err as { response?: { data?: { code?: string } } })?.response?.data?.code === 'environment_repos_changed') setEnvironmentReads(n => n + 1);
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
      const inSpace = spaceStep.show ? { chatSpace: space } : {};
      const ws = await workstreamsApi.create(project.id, worktreeStart === 'origin' && branch
        ? { name: wsName, baseRef: `origin/${branch}`, fetch: { remoteBranch: branch, fullAccess: fetchedTrustable && trustChecked }, ...inSpace }
        : { name: wsName, ...inSpace });
      // Its first message goes from its own view, on the model and at the effort picked here.
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

  const sendLabel = busy === 'space' ? 'Setting up the space'
    : busy === 'box' ? 'Launching a box'
    : busy === 'chat' ? (scheduled ? 'Creating' : 'Starting')
    : scheduled ? 'Create automation' : 'Send';

  return (
    <NewChatFrame>
      <form ref={rootRef} className="chat-compose chat-new-card" onSubmit={e => void start(e)} {...(takesImages && !busy ? attachments.dropHandlers(() => messageRef.current?.focus()) : {})}>
        {attachments.dragging && <div className="chat-drop-overlay" aria-hidden="true">Drop images to attach</div>}
        <div className="chat-launch-ask">
        <span>{fields || environment ? 'What are we doing in' : 'What are we doing?'}</span>
        {environment ? (
          <span className="chat-launch-environment">{environment.name}</span>
        ) : (
        <RepoPicker
          pick={pick}
          onPick={choosePick}
          empty={!fields}
          open={repoOpen}
          onOpenChange={open => { setRepoOpen(open); if (open) { setModelOpen(false); setPermissionOpen(false); dismissSpaceMenu(); } }}
          more={ticked}
          onToggle={multiRepoOn && !worktree ? toggleMore : undefined}
        />
        )}

        {(fields || environment) && <span className="chat-launch-q" aria-hidden="true">?</span>}
        </div>
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
          <div className="chat-compose-bar">
            <div className="chat-compose-pills">
            <ModelPicker
              model={model}
              options={modelOptions}
              onChange={setModel}
              effort={scheduled ? null : effort}
              onEffortChange={setEffort}
              open={modelOpen}
              onOpenChange={open => { setModelOpen(open); if (open) { setRepoOpen(false); setPermissionOpen(false); dismissSpaceMenu(); } }}
            />
            {worktree && !fetchedTrustable ? <FollowsPermissions project={worktree.name} fetched={worktreeStart === 'origin'} /> : (askTrust || environmentResolving) && (
              <PermissionPicker
                value={trustChecked ? 'full' : 'read'}
                onChange={choice => {
                  setTrustChoice({ key: selectionKey, checked: choice === 'full' });
                  // Remembered for the picker's one repository; an environment's choice is for its checkouts alone.
                  if (ticked.length === 0 && !environment) writePermissionPick(browserStore(), repoUrl, choice);
                }}
                open={permissionOpen}
                onOpenChange={open => { setPermissionOpen(open); if (open) { setRepoOpen(false); setModelOpen(false); dismissSpaceMenu(); } }}
                checkouts={resolvedRepos?.repos.map(r => (r.branch ? `${r.repo} at ${r.branch}` : r.repo))}
                scheduled={scheduled}
                disabled={!!busy || environmentResolving}
              />
            )}
            {orchestrator !== 'hidden' && (
              <OrchestratorToggle on={orchestrate} onChange={setOrchestrate} state={orchestrator} disabled={!!busy} />
            )}
            </div>
            <div className="chat-compose-actions">
            {takesImages && <ComposerAttach onFiles={files => { void attachments.attach(files); }} disabled={!!busy} className="chat-compose-mic chat-compose-attach" />}
            <DictationButton dictation={dictation} disabled={!!busy} className="chat-compose-mic" />
            {/* Shows once there is a message, and stays while the session starts. */}
            {(message.trim() || hasAttachments || busy) && (
              <button type="submit" className="chat-compose-send" aria-label={sendLabel} disabled={!canStart} aria-describedby={whyNot ? 'chat-new-why' : undefined}>
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
          wakingId={wakingId}
          newBox={newBox}
          disabled={!!busy}
          // After a launched box's project was refused, the retry keeps that box; the session name stays editable.
          boxLocked={!!launched}
          space={spaceStep.pending ? (
            // Spaces still loading: the trigger holds its place, disabled, so nothing shifts when they come.
            <SpacePicker {...spaceStep.pickerProps} disabled menuEpoch={spaceMenuEpoch} onOpen={() => {}} />
          ) : spaceStep.show ? (
            <SpacePicker
              {...spaceStep.pickerProps}
              // A space is remembered once picked; a new one only once the session makes it.
              onChange={next => {
                spaceStep.pickerProps.onChange(next);
                if (next.kind !== 'new') rememberStartPick(browserStore(), { space: next.kind === 'existing' ? next.name : null });
              }}
              error={spaceStep.error}
              disabled={!!busy}
              menuEpoch={spaceMenuEpoch}
              onOpen={() => { setRepoOpen(false); setModelOpen(false); setPermissionOpen(false); }}
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
              onOpen={() => { setRepoOpen(false); setModelOpen(false); setPermissionOpen(false); }}
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
              repoName={repoTriggerLabel(pick)}
              disabled={!!busy}
              onOpen={() => { setRepoOpen(false); setModelOpen(false); setPermissionOpen(false); dismissSpaceMenu(); }}
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
              onOpen={() => { setRepoOpen(false); setModelOpen(false); setPermissionOpen(false); dismissSpaceMenu(); }}
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
        {busy && <div className="chat-compose-status" role="status">{busy === 'space' ? 'Setting up the space…' : busy === 'box' ? 'Launching a box…' : scheduled ? 'Creating…' : 'Starting…'}</div>}
        {error && <div className="chat-compose-error" role="alert">{error}</div>}
        {refDrop.note && <div className="chat-compose-error" role="status">{refDrop.note}</div>}
      </form>
    </NewChatFrame>
  );
}
