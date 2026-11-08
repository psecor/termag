// Whether the full UI's session lists show ask chats, and which rows they
// are. An ask run takes a worktree-less `ask-<thread>` workstream on its
// target project (backend services/askChat.ts); its conversation lives in
// the simple UI, so in the workspace the row has no pane to open — noise
// unless the setting (Settings → Appearance, `sidebarAskChats`) shows them.
import type { InboxRow } from '../mobile/inbox';
import type { Workstream } from '../types';

/**
 * An ask thread's own chat: the workstream the orchestrator makes for it,
 * named `ask-<thread id>` (backend services/agentMessages.ts
 * askChatWorkstreamName).
 */
const ASK_CHAT_WORKSTREAM = /^ask-[a-z0-9]{8,40}$/;

export function isAskChatWorkstream(name: string): boolean {
  return ASK_CHAT_WORKSTREAM.test(name);
}

/** Whether a workstream is an ask thread's chat: by its record, else by the `ask-<thread>` name the orchestrator gives it. */
export function isAskChatWorkstreamWs(ws: Pick<Workstream, 'name' | 'askThread'>): boolean {
  return Boolean(ws.askThread) || isAskChatWorkstream(ws.name);
}

/**
 * The workstreams the sidebar lists under a project. Ask chats are dropped
 * unless the setting shows them — but one that is the workstream on screen
 * stays, so the session being looked at never drops out of the sidebar (the
 * MetaTerm rule, utils/metatermVisibility.ts). "On screen" is the active
 * project's selection; a remembered selection on a project that is closed
 * does not count (Devin's review).
 */
export function sidebarWorkstreams(
  workstreams: readonly Workstream[],
  showAskChats: boolean,
  onScreenWorkstream: string | null | undefined,
): Workstream[] {
  if (showAskChats) return [...workstreams];
  return workstreams.filter(ws => !isAskChatWorkstreamWs(ws) || ws.name === onScreenWorkstream);
}

/** The home rows without the ask chats (the status strip's popovers, the ⌘K palette). */
export function withoutAskChats(rows: readonly InboxRow[]): InboxRow[] {
  return rows.filter(r => !(r.askThreadId || isAskChatWorkstream(r.workstream)));
}
