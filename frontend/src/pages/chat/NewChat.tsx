// New chat in the simple UI: one composer. The repository sits above it, the
// Claude model sits in its bar, and sending the message starts the chat.
// Every chat gets its own new box (the server claims a warm one when the pool
// has one, else launches one) and Claude; the first message waits in the
// chat until Claude can take it (chat/newChat.ts). Trust, a space, a schedule
// and the chat's names stay with the rest of the simple UI.
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { automationsApi, credentialsApi, githubReposApi, instancesApi, projectsApi } from '../../services/api';
import { AutomationFields, draftBody, draftCron, emptyDraft, type AutomationDraft } from '../../components/AutomationFields';
import { FLAGS, useFlag } from '../../flags';
import { useDictation } from '../../chat/useDictation';
import { DictationButton, DictationNote } from '../../chat/DictationButton';
import { blocksManagedBox, type BoxGateState } from '../../boxGate';
import { boxFeed } from '../../services/boxFeed';
import { noteAddBoxClick, noteBoxClaimed, noteProjectCreated } from '../../services/claimTiming';
import { replaySessionId } from '../../observability';
import { BOX_NAME_ERROR, isValidBoxName } from '../../utils/boxNames';
import { funnyProjectName, isBoxFailedRefusal } from '../../utils/projectStart';
import {
  catalogFromWire, degradedCatalog, suggestedName, type CatalogGroup, type RepoCatalog, type RepoPick,
} from '../../utils/repoPick';
import { chatHref, repoNeedsTrust, repoStartsTrusted } from '../../chat/simpleChat';
import { newChatNames, orchestratorOption, readLastStart, startBlocker, writeLastStart, writeQueued } from '../../chat/newChat';
import {
  newChatCreateFields, REPO_EMPTY, repoListView, repoTriggerLabel,
  type ChatModelId,
} from '../../chat/composer';
import { CHAT_PROVIDER_ID, PROVIDERS } from '../../providers/registry';
import { isSendKey, MAX_KEYS } from '../../chat/compose';
import type { Instance } from '../../types';
import { SpacePicker } from './SpacePicker';
import { ModelPicker } from '../../chat/ModelPicker';
import { SendIcon } from '../../chat/ComposerIcons';
import { useChatModelOptions } from '../../chat/useChatModelOptions';
import { ChatHistoryButton } from './chatChrome';
import { useSpaceStep } from '../../chat/useSpaceStep';

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

function Caret() {
  return <span className="chat-compose-caret" aria-hidden="true" />;
}

const browserStore = () => (typeof localStorage !== 'undefined' ? localStorage : null);

export function NewChat() {
  const navigate = useNavigate();
  const { projects, reloadProjects } = useProjects();
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const [params] = useSearchParams();
  // The repository, space and model the last chat started with open again here.
  const [last] = useState(() => readLastStart(browserStore()));
  const spaceStep = useSpaceStep(params.get('space'), last.space);
  const rootRef = useRef<HTMLFormElement>(null);
  // Arriving here (the New session button, ⌘⇧O, or ⌘⇧O again while here: a
  // new history entry each time) puts the cursor in the message.
  const { key: visit } = useLocation();
  const messageRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { messageRef.current?.focus(); }, [visit]);

  const [pick, setPick] = useState<RepoPick>(last.pick ?? { kind: 'empty' });
  const [picked, setModel] = useState<ChatModelId>(last.model);
  // The last start's model while it is still offered: a Fireworks model shows once the menus load.
  const modelOptions = useChatModelOptions();
  const model = modelOptions.some(o => o.id === picked) ? picked : 'sonnet';
  const [message, setMessage] = useState('');
  const [paste, setPaste] = useState(last.pick?.kind === 'pasted' ? last.pick.url : '');
  const [query, setQuery] = useState('');
  const [repoOpen, setRepoOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  // Bumped when another menu opens or the form sends, so the space menu closes.
  const [spaceMenuEpoch, setSpaceMenuEpoch] = useState(0);
  function dismissSpaceMenu() { setSpaceMenuEpoch(n => n + 1); }
  const [catalog, setCatalog] = useState<RepoCatalog | null>(null);
  const request = useRef(0);
  // Run on a schedule: the same box and repository,
  // but an automation instead of a chat; the first message is its prompt.
  const automationsOn = useFlag(FLAGS.automations, false);
  const [scheduled, setScheduled] = useState(false);
  const dictation = useDictation({ text: message, setText: setMessage, max: scheduled ? MAX_AUTOMATION_PROMPT : MAX_KEYS });
  const [draft, setDraft] = useState<AutomationDraft>(emptyDraft);
  const [fallbackName] = useState(() => funnyProjectName());
  const defaults = useMemo(
    () => newChatNames(suggestedName(pick) ?? fallbackName, projects.map(p => p.name), boxes.map(b => b.name)),
    [pick, fallbackName, projects, boxes],
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

  function loadRepos(refresh: boolean) {
    const id = ++request.current;
    if (refresh) setCatalog(null);
    githubReposApi.list(refresh)
      .then(body => { if (request.current === id) setCatalog(catalogFromWire(body)); })
      .catch(() => { if (request.current === id) setCatalog(degradedCatalog()); });
  }

  useEffect(() => { loadRepos(false); }, []);

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
  const [busy, setBusy] = useState<'space' | 'box' | 'chat' | null>(null);
  const [error, setError] = useState('');

  const fields = newChatCreateFields(pick, model);
  const repoUrl = fields?.repoUrl ?? null;
  // Every repository asks once. A company-org repository starts checked;
  // switching repository returns to that repository's default, and a manual
  // tick applies only to the URL it was made on. The backend records the tick.
  const askTrust = repoNeedsTrust(repoUrl);
  // Same company-org rule as the default tick (repoStartsTrusted): for those
  // repositories the checkbox moves into Options instead of sitting inline,
  // since trust there is already the default rather than an opt-in ask.
  const trustCompanyRepo = repoStartsTrusted(repoUrl);
  const [trustChoice, setTrustChoice] = useState<{ url: string | null; checked: boolean } | null>(null);
  const trustChecked = trustChoice?.url === repoUrl ? trustChoice.checked : repoStartsTrusted(repoUrl);
  // Act as an orchestrator: the box tells the chat's turns to use the opt-in
  // agent-orchestrator skill, out of the conversation (chat/newChat.ts).
  const [orchestrate, setOrchestrate] = useState(false);
  const orchestrator = orchestratorOption({
    providerHasSkill: !!PROVIDERS[CHAT_PROVIDER_ID]?.orchestratorSkill,
    scheduled,
    trusted: askTrust ? trustChecked : true,
  });
  const nameError = name && !PROJECT_NAME_RE.test(name) ? 'Letters, digits, - and _ only' : '';
  const boxError = !launched && boxName && !isValidBoxName(boxName) ? BOX_NAME_ERROR : '';
  // The schedule as AutomationFields previewed it: no box is launched for a
  // schedule the API would refuse (too frequent, unreadable).
  const [scheduleValid, setScheduleValid] = useState(false);
  const scheduleOk = !scheduled || (draftCron(draft) !== null && !!draft.timezone && !!message.trim() && scheduleValid);
  const whyNot = startBlocker({
    busy: !!busy, hasRepo: fields !== null, name, nameError,
    spacesReady: spaceStep.ready, spaceError: spaceStep.error,
    boxReady: !!launched, boxName, boxError,
  }) || (scheduleOk || busy ? '' : 'Pick a schedule the runs can keep, and say what each run should do');
  // A plain chat still needs a message to send, just without a written hint.
  const messageMissing = !busy && !scheduled && !message.trim();
  const canStart = !busy && !blocked && !whyNot && !messageMissing;

  const list = repoListView(catalog);
  const q = query.trim().toLowerCase();

  function visibleRepos(group: CatalogGroup) {
    if (!q) return group.repos;
    return group.repos.filter(repo => repo.fullName.toLowerCase().includes(q));
  }

  function chooseListed(fullName: string, defaultBranch: string) {
    setPick({ kind: 'listed', fullName, defaultBranch });
    setPaste('');
    setNameEdit(null);
    setBoxEdit(null);
    setRepoOpen(false);
    setError('');
  }

  function onPaste(url: string) {
    setPaste(url);
    setPick(url.trim() ? { kind: 'pasted', url } : { kind: 'empty' });
    setNameEdit(null);
    setBoxEdit(null);
    setError('');
  }

  async function start(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canStart || !fields) return;
    dictation.detach();
    setError('');
    setRepoOpen(false);
    setModelOpen(false);
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
    let box = launched;
    if (!box) {
      setBusy('box');
      noteAddBoxClick();
      try {
        const r = await instancesApi.create(boxName, 'ec2');
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
          // repository the owner has not ticked runs read-only, whatever the
          // Run settings panel says.
          tier: askTrust && !trustChecked ? 'read' : draft.tier,
        });
        noteProjectCreated(created.project.id, box.id);
        writeLastStart(browserStore(), { pick, space, model });
        await reloadProjects().catch(() => {});
        navigate(`/automations/${encodeURIComponent(created.project.id)}`);
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
        repoUrl: fields.repoUrl,
        defaultBranch: fields.defaultBranch,
        claudeModel: fields.claudeModel,
        chatTrusted: askTrust && trustChecked,
        ...(orchestrate && orchestrator === 'available' ? { chatOrchestrator: true } : {}),
      });
      noteProjectCreated(project.id, box.id);
      writeLastStart(browserStore(), { pick, space, model });
      const held = writeQueued(browserStore(), project.id, message);
      await reloadProjects().catch(() => {});
      navigate(chatHref(project.id, 'main'), held ? undefined : { state: { draft: message } });
    } catch (err) {
      if (isBoxFailedRefusal(err)) {
        setLaunched(null);
        await boxFeed.reload();
        setError('The box failed to launch. Start again to launch another.');
      } else {
        setError(apiError(err, 'Could not start the session'));
      }
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

  // Shared by the inline spot and the one inside Options: same checkbox,
  // same copy, same create payload either way (chatTrusted tracks trustChecked).
  function trustCheckbox(extraClassName?: string) {
    return (
      <label className={extraClassName ? `chat-new-trust ${extraClassName}` : 'chat-new-trust'}>
        <input type="checkbox" checked={trustChecked} onChange={e => setTrustChoice({ url: repoUrl, checked: e.target.checked })} />
        <span>
          {scheduled
            ? <><strong>I trust this repository.</strong> Runs get the full tier: a fresh Claude runs commands, commits and opens PRs in it with nobody watching (its classifier denies rather than asks). Unchecked, every run is read-only.</>
            : repoUrl
              ? <><strong>I trust this repository.</strong> Claude runs commands and edits files in it without asking.</>
              : <><strong>Let Claude run commands.</strong> Claude runs commands and edits files in this project without asking.</>}
          {!scheduled && <>{' '}Unchecked, Claude can read it but cannot run tools until you trust it from the session.</>}
        </span>
      </label>
    );
  }

  return (
    <NewChatFrame>
      <form ref={rootRef} className="chat-compose chat-new-card" onSubmit={e => void start(e)}>
        <div className="chat-compose-picks">
        <div className="chat-compose-repo">
          <button
            type="button"
            className="chat-compose-repo-btn"
            aria-expanded={repoOpen}
            aria-haspopup="listbox"
            onClick={() => { setRepoOpen(o => !o); setModelOpen(false); dismissSpaceMenu(); }}
          >
            <span className="chat-compose-repo-name">{repoTriggerLabel(pick)}</span>
            <Caret />
          </button>
          {repoOpen && (
            <div className="chat-compose-menu" role="listbox" aria-label="Repositories">
              <input
                className="chat-compose-search"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search repositories"
                aria-label="Search repositories"
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
              />
              {list.kind === 'loading' && <div className="chat-compose-note">Loading repositories…</div>}
              {list.kind === 'error' && (
                <div className="chat-compose-note" role="alert">
                  {list.text}{' '}
                  <button type="button" className="chat-compose-retry" onClick={() => loadRepos(true)}>Try again</button>
                </div>
              )}
              {list.kind === 'empty' && <div className="chat-compose-note">{REPO_EMPTY}</div>}
              {catalog?.ok && catalog.groups.map(group => {
                const repos = visibleRepos(group);
                if (repos.length === 0 && group.status === 'ok') return null;
                return (
                  <div key={`${group.kind}:${group.owner}`}>
                    <div className="chat-compose-owner">{group.owner}</div>
                    {group.status !== 'ok' && (
                      <div className="chat-compose-note">
                        {group.href ? <a href={group.href}>{group.text}</a> : group.text}
                      </div>
                    )}
                    {repos.map(repo => (
                      <button
                        key={repo.fullName}
                        type="button"
                        role="option"
                        aria-selected={pick.kind === 'listed' && pick.fullName === repo.fullName}
                        className="chat-compose-option"
                        onClick={() => chooseListed(repo.fullName, repo.defaultBranch)}
                      >
                        {repo.fullName}
                      </button>
                    ))}
                  </div>
                );
              })}
              <label className="chat-compose-paste">
                <span>Repository URL</span>
                <input
                  value={paste}
                  onChange={e => onPaste(e.target.value)}
                  placeholder="https://github.com/owner/repo"
                  aria-label="Repository URL"
                  onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
                />
              </label>
            </div>
          )}
        </div>

        {spaceStep.show && (
          <SpacePicker
            {...spaceStep.pickerProps}
            error={spaceStep.error}
            disabled={!!busy}
            menuEpoch={spaceMenuEpoch}
            onOpen={() => { setRepoOpen(false); setModelOpen(false); }}
          />
        )}
        </div>

        <div className="chat-compose-box">
          <textarea
            ref={messageRef}
            className="chat-compose-input"
            value={message}
            // A run's prompt is the automation's (up to 20,000 characters, routes/automations.ts); a chat message is typed into a pane.
            onChange={e => { dictation.onEdit(); setMessage(e.target.value.slice(0, scheduled ? MAX_AUTOMATION_PROMPT : MAX_KEYS)); }}
            onKeyDown={e => {
              if (dictation.onKeyDown(e)) return;
              // Enter sends a chat; an automation's prompt is a document, and the send arrow creates it.
              if (scheduled || !isSendKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing })) return;
              e.preventDefault();
              void start();
            }}
            placeholder={scheduled ? 'What each run should do. It starts on a fresh branch, with notes from earlier runs.' : 'What should Claude do?'}
            aria-label="Message"
            rows={4}
          />
          <div className="chat-compose-bar">
            <ModelPicker
              model={model}
              options={modelOptions}
              onChange={setModel}
              open={modelOpen}
              onOpenChange={open => { setModelOpen(open); if (open) { setRepoOpen(false); dismissSpaceMenu(); } }}
            />
            <div className="chat-compose-actions">
            <DictationButton dictation={dictation} disabled={!!busy} className="chat-compose-mic" />
            {/* Shows once there is a message, and stays while the session starts. */}
            {(message.trim() || busy) && (
              <button type="submit" className="chat-compose-send" aria-label={sendLabel} disabled={!canStart} aria-describedby={whyNot ? 'chat-new-why' : undefined}>
                <SendIcon />
              </button>
            )}
            </div>
          </div>
        </div>
        <DictationNote dictation={dictation} className="chat-compose-status" />

        {automationsOn && (
          <label className="chat-new-trust chat-new-schedule">
            <input type="checkbox" checked={scheduled} onChange={e => setScheduled(e.target.checked)} />
            <span><strong>Run on a schedule.</strong> Instead of one session, an automation: a fresh Claude runs this prompt on a cadence, each run its own branch and conversation.</span>
          </label>
        )}
        {scheduled && <AutomationFields draft={{ ...draft, prompt: message }} onChange={d => { setDraft(d); if (d.prompt !== message) setMessage(d.prompt); }} showEnabled idPrefix="nc-af" onValidity={setScheduleValid} />}
        {askTrust && !trustCompanyRepo && trustCheckbox()}
        {orchestrator !== 'hidden' && (
          <label className="chat-new-orchestrator">
            <input
              type="checkbox"
              checked={orchestrate && orchestrator === 'available'}
              disabled={orchestrator !== 'available'}
              onChange={e => setOrchestrate(e.target.checked)}
            />
            <span>
              <strong>Act as an orchestrator.</strong> Claude starts with the agent-orchestrator skill: it splits the
              work into tasks, hands them to other agents with <code>termag ask</code>, keeps plans and handoffs in a
              termag space, and combines what comes back instead of doing the work itself.
              {orchestrator === 'needs-trust' && <>{' '}Needs the trust box ticked{trustCompanyRepo ? ' (under Options)' : ''}: an untrusted session cannot run commands.</>}
            </span>
          </label>
        )}
        <details className="chat-new-options">
          <summary>Options</summary>
          {askTrust && trustCompanyRepo && trustCheckbox('chat-new-trust-options')}
          <label className="chat-new-field">
            <span>Session name</span>
            <input value={nameEdit ?? defaults.projectName} onChange={e => setNameEdit(e.target.value)} />
            {nameError && <span className="chat-new-error">{nameError}</span>}
          </label>
          <label className="chat-new-field">
            <span>Box name</span>
            <input value={launched ? launched.name : boxEdit ?? defaults.boxName} disabled={!!launched} onChange={e => setBoxEdit(e.target.value)} />
            {boxError && <span className="chat-new-error">{boxError}</span>}
          </label>
        </details>
        {whyNot && <span className="chat-compose-why" id="chat-new-why">{whyNot}</span>}
        {busy && <div className="chat-compose-status" role="status">{busy === 'space' ? 'Setting up the space…' : busy === 'box' ? 'Launching a box…' : scheduled ? 'Creating…' : 'Starting…'}</div>}
        {error && <div className="chat-compose-error" role="alert">{error}</div>}
      </form>
    </NewChatFrame>
  );
}
