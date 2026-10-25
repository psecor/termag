// Pure pieces of the desktop chat at /chat (the simple UI): which sessions
// it lists, the one-line status under the transcript, when the answer keys
// show, and the links out of it.
import type { AgentStatus, AgentStatusValue, Project } from '../types';
import { CHAT_PROVIDER_ID } from '../providers/registry';
import { sortHome, statusLabel, waitingLabel, type InboxRow } from '../mobile/inbox';
import { repoKey } from '../utils/repoPick';
import type { Block } from './paneChat';
import type { ChatLiveStatus } from './chatLiveStatus';
import { agentLabel } from './explorerAgents';

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

export interface ChatRowName {
  /** Claude's title for the session, when the row leads with it; null to lead with the project as before. */
  title: string | null;
  /** The project, and the workstream when it is not main: under the title, or the name itself without one. */
  where: string;
}

/**
 * What a sidebar row is called. With simple-ui-session-titles-enabled and a
 * title Claude gave the session, the title leads and the project (and
 * workstream) is secondary; otherwise the row is named after the project.
 */
export function chatRowName(row: Pick<InboxRow, 'projectName' | 'workstream' | 'sessionTitle'>, titlesShown: boolean): ChatRowName {
  const title = titlesShown ? row.sessionTitle?.trim() || null : null;
  return { title, where: agentLabel(row) };
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
 * its header says; another chat reads the status pipeline, and one whose box
 * or checkout is still coming up says so rather than "Not running".
 */
export function sidebarLine(row: InboxRow, live: ChatLiveStatus | undefined, setupStatus: string | null | undefined): SidebarLine {
  if (live) {
    return {
      state: live.text,
      message: live.preview,
      glyph: live.tone === 'working' || live.tone === 'setup' ? 'working' : 'idle',
    };
  }
  if (row.status === 'not_running' && (setupStatus === 'pending' || setupStatus === 'cloning')) {
    return { state: 'Setting up…', message: null, glyph: 'working' };
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

/** The single line under the transcript saying what the agent is doing now. */
export function statusLine(i: StatusLineInput): StatusLine {
  if (i.setupLabel) return { tone: 'setup', text: `Setting up · ${i.setupLabel}` };
  if (i.offline) return { tone: 'offline', text: "The box's agent is offline · showing the last capture" };
  const message = i.message?.trim() || null;
  switch (i.status) {
    case 'working': {
      const spin = i.spinner?.replace(/^[✻✶✳✢·*]\s*/, '').trim() || null;
      return { tone: 'working', text: message ? `Working · ${message}` : spin ?? 'Working' };
    }
    case 'waiting':
      return { tone: 'waiting', text: message ? `${waitingLabel(i.waitingReason)} · ${message}` : waitingLabel(i.waitingReason) };
    case 'idle':
      return { tone: 'idle', text: 'Done · your turn' };
    default:
      return { tone: 'off', text: 'Not running' };
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

/** The same session in the classic workspace (the deep link ProjectContext reads). */
export function fullUiHref(projectId: string | null | undefined, workstream = 'main'): string {
  if (!projectId) return '/';
  const q = new URLSearchParams({ project: projectId });
  if (workstream !== 'main') q.set('ws', workstream);
  return `/?${q.toString()}`;
}

/**
 * Where an automation run's conversation opens: the simple UI when this user
 * has it (simple-ui-enabled), else the run's workstream in the workspace.
 * /chat redirects to / without the flag, so a link there would lose the run.
 */
export function runConversationHref(projectId: string, workstream: string, simpleUi: boolean): string {
  return simpleUi ? chatHref(projectId, workstream) : fullUiHref(projectId, workstream);
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
 * than in its pane: its agent workflow, else the project's main one, is the
 * chat provider.
 */
export function isSdkChat(project: Pick<Project, 'workflows' | 'workstreams'>, workstream: string): boolean {
  const ws = project.workstreams.find(w => w.name === workstream);
  const agents = project.workflows.filter(w => w.type === 'agent');
  const own = ws ? agents.find(w => w.workstreamId === ws.id) : undefined;
  const main = project.workstreams.find(w => w.name === 'main');
  const fallback = agents.find(w => main && w.workstreamId === main.id) ?? agents[0];
  return (own ?? fallback)?.provider === CHAT_PROVIDER_ID;
}
