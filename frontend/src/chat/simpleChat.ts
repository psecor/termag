// Pure pieces of the desktop chat at /chat (the simple UI): which sessions
// it lists, the one-line status under the transcript, when the answer keys
// show, and the links out of it.
import type { AgentStatus, AgentStatusValue, Project } from '../types';
import { isChatRunnerProvider, PROVIDERS } from '../providers/registry';
import { buildRows, sortHome, statusLabel, waitingLabel, type InboxRow } from '../mobile/inbox';
import { repoKey } from '../utils/repoPick';
import type { Block } from './paneChat';
import type { ChatLiveStatus } from './chatLiveStatus';
import { isAskChatWorkstream } from '../utils/askChatVisibility';
import { LAB_PARAM } from './uiMode';
import { asDetail, DONE_YOUR_TURN, rowStatusText, statusText } from './statusWords';
import { sessionTitle } from './sessionTitle';

/**
 * GitHub owners whose new simple-UI sessions start trusted. Empty: every
 * session starts read-only and trust is the owner's own tick. A deployment
 * that wants its own orgs to start checked lists them here. Not
 * GITHUB_REPO_ORGS, on purpose: that list is about which repos to show, not
 * which ones to trust.
 */
const COMPANY_GITHUB_OWNERS: ReadonlySet<string> = new Set<string>([]);

/**
 * The chats in the sidebar: project workstreams with an agent, sorted the
 * way the phone's home list is (needs you, then running, then the rest).
 * MetaTerm and cloud sessions are not conversations the simple UI drives.
 * An automation's runs are (each is a chat-runner turn),
 * but its `main` is not: no agent ever runs there.
 */
export function chatRows(rows: readonly InboxRow[]): InboxRow[] {
  return sortHome(rows.filter(r => r.kind === 'normal' || (r.kind === 'automation' && r.workstream !== 'main')));
}

/**
 * Whether a Lab link's session has a conversation in the chat, so the link
 * can open it there (uiMode.ts simpleUiDeepLink): a listed project with that
 * workstream, live, of a kind chatRows lists: not MetaTerm, nor an
 * automation's `main`, where no agent runs. Anything else stays in Lab.
 */
export function sessionHasChat(
  projects: readonly Pick<Project, 'id' | 'kind' | 'workstreams'>[], projectId: string, workstream: string,
): boolean {
  const project = projects.find(p => p.id === projectId);
  if (!project?.workstreams.some(w => w.name === workstream && !w.archived)) return false;
  const kind = project.kind ?? 'normal';
  return kind === 'normal' || (kind === 'automation' && workstream !== 'main');
}

/**
 * An ask thread's own chat: the workstream the orchestrator makes for it,
 * named `ask-<thread id>` — defined in utils/askChatVisibility.ts beside the
 * row/workstream filters built on it, re-exported so the chat keeps one name.
 */
export { isAskChatWorkstream };

const isAskChat = (w: Project['workstreams'][number]) => Boolean(w.askThread) || isAskChatWorkstream(w.name);

/**
 * Projects whose main is a stand-in nobody has used (see
 * withoutAskPlaceholders), decided from what the project holds rather than
 * how it was made, so a project from an old CLI, made by hand or by another
 * agent counts too: it has ask threads, and its main has never been used (no
 * turns or typing banked as working time, no stored transcript, and no
 * session title, which a chat turn's end sets). `createdFor: 'ask'` (`termag
 * ask --new-box`, the deprecated --for-ask) is a hint for a project whose
 * first ask has no chat yet; it never keeps a used main out.
 */
export function askPlaceholderProjects(projects: readonly Project[]): Set<string> {
  const out = new Set<string>();
  for (const p of projects) {
    const main = p.workstreams.find(w => w.name === 'main');
    if (!main || main.sessionTitle?.trim() || main.hasTranscript || main.hasTurns) continue;
    const asked = p.workstreams.some(w => !w.archived && w.name !== 'main' && isAskChat(w));
    if (asked || p.createdFor === 'ask') out.add(p.id);
  }
  return out;
}

/** The live status says the session has had a turn: it is working or needs you now, or came to rest from that. */
const liveUsed = (r: InboxRow) => r.status === 'working' || r.status === 'waiting' || Boolean(r.stoppedAt);

/**
 * The rows without the unused main of a project that has asks
 * (askPlaceholderProjects), whose ask threads have rows of their own (and
 * show under the session that sent them). Its agent may have started and be
 * waiting at its prompt (Ready), but it has done nothing, has no title and
 * isn't open (`keep`: rowKey of every open tab and of the route's chat), so
 * all it would add is one more row named after the project, like the
 * project of the same name on the person's own box.
 *
 * A main that was used is never folded. `hosts` comes from the last project
 * list, which learns of a first turn only when it is read again, so the live
 * status counts too: working, waiting, or come to rest from that
 * (`stoppedAt`). `used` remembers the mains seen used for the page's life (the
 * caller keeps the set), so a main stays after its status is gone (a
 * restart, a box reconnect) until the list says so itself.
 */
export function withoutAskPlaceholders(
  rows: readonly InboxRow[], hosts: ReadonlySet<string>, keep: ReadonlySet<string>, used: Set<string> = new Set(),
): InboxRow[] {
  for (const r of rows) if (r.workstream === 'main' && liveUsed(r)) used.add(r.key);
  if (!hosts.size) return [...rows];
  return rows.filter(r => !(
    r.workstream === 'main' && hosts.has(r.projectId) && !used.has(r.key)
    && !r.sessionTitle?.trim() && !keep.has(r.key)
  ));
}

/**
 * Every list's sessions in the simple UI (pages/chat/simpleData.tsx): the
 * sidebar, Recent agents, the tabs, and the explorers (explorerAgents,
 * noSpaceAgents), which all read these rows, so an ask project's unused main
 * is folded out of each the same way. `keep`: rowKey of every open tab and
 * of the route's chat; `used`: the mains seen used on this page
 * (withoutAskPlaceholders), kept by the caller.
 */
export function chatListRows(
  projects: readonly Project[], statusMap: Record<string, AgentStatus | undefined>, username: string, keep: ReadonlySet<string>,
  used: Set<string> = new Set(),
): InboxRow[] {
  return withoutAskPlaceholders(chatRows(buildRows([...projects], statusMap, username)), askPlaceholderProjects(projects), keep, used);
}

export interface ChatRowName {
  /** What the row leads with: the session's one title (chat/sessionTitle.ts), the same string on every surface. */
  title: string;
  /**
   * Under the title, or after it in a tooltip: the project, when the title
   * isn't the project's name. For an ask, its session's own title when that
   * says something else than the one shown, else nothing (the project and
   * box are in the tooltip). Never the workstream's name.
   */
  where: string | null;
  /** The row is an ask thread's chat. */
  ask: boolean;
}

/** What a sidebar row is called: its session's title (sessionTitle), and where it is. */
export function chatRowName(row: Pick<InboxRow, 'projectName' | 'workstream' | 'sessionTitle' | 'sessionTitleSource' | 'askTitle' | 'askThreadId'>): ChatRowName {
  const title = sessionTitle(row);
  if (row.askThreadId) {
    const own = row.sessionTitle?.trim() || null;
    return { title, where: own && own !== title ? own : null, ask: true };
  }
  return { title, where: title !== row.projectName ? row.projectName : null, ask: false };
}

export interface SidebarLine {
  /** The words for the row's state. */
  state: string;
  /** The second line: Claude's last words, or the status message. */
  message: string | null;
  /** Which glyph and colour the row takes. */
  glyph: AgentStatusValue;
}

/**
 * A sidebar row's state and preview. The open chat publishes its own status
 * line and last assistant text (chat/chatLiveStatus.ts), so its row says what
 * its header says (a plain finished turn is "Idle", the transcript's line
 * alone adds "your turn"); another chat reads the status pipeline, and one
 * whose box or checkout is still coming up says so rather than "Not running".
 */
export function sidebarLine(row: InboxRow, live: ChatLiveStatus | undefined, setupStatus: string | null | undefined): SidebarLine {
  if (live) {
    return {
      state: rowStatusText(live.text),
      message: live.preview,
      glyph: live.tone === 'working' || live.tone === 'setup' ? 'working' : live.tone === 'off' ? 'not_running' : 'idle',
    };
  }
  if (row.status === 'not_running' && (setupStatus === 'pending' || setupStatus === 'cloning')) {
    return { state: statusText('Working', 'setting up'), message: null, glyph: 'working' };
  }
  return { state: statusLabel(row), message: row.message, glyph: row.status };
}

/**
 * Which box a session runs on, in words: the box's name, or "<owner>'s box"
 * for a shared session on a box this user can't list. Sessions with the same
 * name, or the same workstream name, on different boxes differ by this.
 */
export function boxLabel(
  row: Pick<InboxRow, 'instanceId' | 'shared' | 'owner'>,
  boxName: string | null | undefined,
): string | null {
  if (!row.instanceId) return null;
  if (boxName) return boxName;
  return row.shared && row.owner ? `${row.owner}'s box` : null;
}

/**
 * The blocks the chat shows: the conversation from its first turn on. What
 * the pane printed before the agent's first turn (the shell's banner, the
 * typed launch command, the CLI's welcome box) is unrecognised text, not
 * conversation, so it is dropped; with no turn yet there is nothing to show.
 * Text after the first turn stays even when the grammar did not recognise it,
 * since that may be the agent's own output.
 */
export function conversationBlocks(blocks: readonly Block[]): Block[] {
  const first = blocks.findIndex(b => b.kind !== 'system');
  return first === -1 ? [] : blocks.slice(first);
}

export type StatusTone = 'working' | 'waiting' | 'idle' | 'off' | 'setup' | 'offline';

export interface StatusLine {
  tone: StatusTone;
  text: string;
}

export interface StatusLineInput {
  status: AgentStatusValue | undefined;
  waitingReason?: AgentStatus['waitingReason'];
  /** The hook's message: the tool running, or what the agent asks. */
  message?: string | null;
  /** The pane's spinner line, e.g. "✻ Channeling… (1m 17s · ↓ 3.5k tokens)". */
  spinner?: string | null;
  /** The setup tile's label while the project is still being set up ("cloning"). */
  setupLabel?: string | null;
  /** The box's agent is offline: what is shown is the last capture. */
  offline?: boolean;
}

/**
 * The single line under the transcript saying what the agent is doing now,
 * leading with one of the four status words (chat/statusWords.ts).
 */
export function statusLine(i: StatusLineInput): StatusLine {
  if (i.setupLabel) return { tone: 'setup', text: statusText('Working', `setting up · ${i.setupLabel}`) };
  if (i.offline) return { tone: 'offline', text: statusText('Not running', 'box offline, showing the last capture') };
  const message = i.message?.trim() || null;
  switch (i.status) {
    case 'working': {
      const spin = i.spinner?.replace(/^[✻✶✳✢·*]\s*/, '').trim() || null;
      return { tone: 'working', text: statusText('Working', message ?? (spin && asDetail(spin))) };
    }
    case 'waiting':
      return { tone: 'waiting', text: message ? `${waitingLabel(i.waitingReason)} · ${message}` : waitingLabel(i.waitingReason) };
    case 'idle':
      return { tone: 'idle', text: DONE_YOUR_TURN };
    default:
      return { tone: 'off', text: statusText('Not running') };
  }
}

/**
 * Whether the answer keys (digits, Enter, Esc, arrows) show under the
 * transcript: only while the agent waits on the user or a question is on
 * screen. A plain chat has the composer and nothing else.
 */
export function showAnswerKeys(status: AgentStatusValue | undefined, dialogOptions: number): boolean {
  return status === 'waiting' || dialogOptions > 0;
}

/** The conversation's own URL under /chat. */
export function chatHref(projectId: string, workstream: string): string {
  const base = `/chat/p/${encodeURIComponent(projectId)}`;
  return workstream === 'main' ? base : `${base}?ws=${encodeURIComponent(workstream)}`;
}

/**
 * The same session in the classic workspace (the deep link ProjectContext
 * reads), marked as opening Lab on purpose (LAB_PARAM), so a new tab or a
 * reload of it stays in Lab rather than going back to the chat.
 */
export function fullUiHref(projectId: string | null | undefined, workstream = 'main'): string {
  if (!projectId) return '/';
  const q = new URLSearchParams({ project: projectId });
  if (workstream !== 'main') q.set('ws', workstream);
  q.set(LAB_PARAM, '1');
  return `/?${q.toString()}`;
}

/** Where an automation run's conversation opens: the simple UI. */
export function runConversationHref(projectId: string, workstream: string): string {
  return chatHref(projectId, workstream);
}

/**
 * Whether New chat asks the user to trust this project. Every repository
 * asks, and so does a project with no repository. The checkbox starts checked
 * only for the owners listed in COMPANY_GITHUB_OWNERS (repoStartsTrusted); the
 * person can clear it before this session. The backend records the tick. An owner
 * string never trusts a session that was created with the box cleared.
 */
export function repoNeedsTrust(repoUrl: string | null | undefined): boolean {
  void repoUrl;
  return true;
}

/**
 * Whether the new-session "Let Claude run commands" checkbox starts checked.
 * True only for a github.com repository whose owner is in
 * COMPANY_GITHUB_OWNERS (https or ssh, either case), none by default. Every other owner, a
 * non-repository URL, and no repository stay unchecked: read-only until
 * trusted from the session.
 */
export function repoStartsTrusted(repoUrl: string | null | undefined): boolean {
  const key = repoUrl ? repoKey(repoUrl) : null;
  if (!key) return false;
  const owner = key.slice(0, key.indexOf('/'));
  return COMPANY_GITHUB_OWNERS.has(owner);
}

/** `owner/name` for a GitHub https or ssh URL, else null. */
export function repoSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Whether a workstream's agent runs in the chat runner (the SDK chat) rather
 * than in its pane: its agent workflow, else the project's main one, is a
 * chat-runner provider (any engine).
 */
export function isSdkChat(project: Pick<Project, 'workflows' | 'workstreams'>, workstream: string): boolean {
  return isChatRunnerProvider(chatProvider(project, workstream));
}

/**
 * Who a chat's agent is, by its provider's engine: Claude Code, with its model picker, effort and the rest; or
 * another engine's agent (a Cursor or Devin review chat), named as the registry names it, which takes none of those.
 */
export function chatAgentOf(project: Pick<Project, 'workflows' | 'workstreams'>, workstream: string): { name: string; claudeCode: boolean; readTier: string } {
  const provider = chatProvider(project, workstream);
  const config = provider ? PROVIDERS[provider] : undefined;
  if (!config || !config.chatEngine || config.chatEngine === 'claude') return { name: 'Claude', claudeCode: true, readTier: READ_TIERS.claude };
  return { name: config.displayName.replace(/\s*\(chat\)$/, ''), claudeCode: false, readTier: READ_TIERS[config.chatEngine] };
}

/** What each engine's read-only turn can do (agent chat-runner.js: confinedTools, PI_READ_ONLY_TOOLS, cursorTurnArgs' plan mode, devinTurnArgs' ask mode). */
const READ_TIERS: Record<'claude' | 'pi' | 'cursor' | 'devin', string> = {
  claude: 'only Read, Grep and Glob this turn: no shell, no edits, no MCP servers',
  pi: 'only read, grep, find and ls this turn: no shell, no edits, no MCP servers',
  cursor: 'only its plan mode this turn: it reads the code, and runs no shell, makes no edits and loads no MCP servers',
  devin: 'only its ask mode this turn: it reads the code, and runs no shell, makes no edits and loads no MCP servers',
};

/** The provider of a workstream's agent workflow, else the project's main one. */
export function chatProvider(project: Pick<Project, 'workflows' | 'workstreams'>, workstream: string): string | null | undefined {
  const ws = project.workstreams.find(w => w.name === workstream);
  const agents = project.workflows.filter(w => w.type === 'agent');
  const own = ws ? agents.find(w => w.workstreamId === ws.id) : undefined;
  const main = project.workstreams.find(w => w.name === 'main');
  const fallback = agents.find(w => main && w.workstreamId === main.id) ?? agents[0];
  return (own ?? fallback)?.provider;
}
