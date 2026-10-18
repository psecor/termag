// Pure pieces of the desktop chat at /chat (the simple UI): which sessions
// it lists, the one-line status under the transcript, when the answer keys
// show, and the links out of it.
import type { AgentStatus, AgentStatusValue, Project } from '../types';
import { CHAT_PROVIDER_ID } from '../providers/registry';
import { sortHome, waitingLabel, type InboxRow } from '../mobile/inbox';
import type { Block } from './paneChat';

/**
 * The chats in the sidebar: project workstreams with an agent, sorted the
 * way the phone's home list is (needs you, then running, then the rest).
 * MetaTerm and cloud sessions are not conversations the simple UI drives.
 */
export function chatRows(rows: readonly InboxRow[]): InboxRow[] {
  return sortHome(rows.filter(r => r.kind === 'normal'));
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
