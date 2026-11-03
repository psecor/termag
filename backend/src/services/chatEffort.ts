/**
 * The effort a simple-UI chat's turn runs at: Claude Code's `--effort`
 * (agent/chat-runner.js turnArgs). Nothing is stored: the composer sends its
 * choice with every message, and Default is no value, so the turn runs at what
 * Claude Code picks for the model.
 *
 * A value reaches the box only with the sender's chat-effort-enabled, on a box
 * whose runner advertises chat-effort-v1, for a chat on Claude's own models
 * (not an ask's, not another backend's). Anything else is dropped, never
 * refused: the message still goes, at the default effort.
 */

export const CHAT_EFFORT_FLAG = 'chat-effort-enabled';
export const CHAT_EFFORT_CAPABILITY = 'chat-effort-v1';

export const CHAT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ChatEffort = (typeof CHAT_EFFORTS)[number];

/** A level the CLI takes, or null for anything else (Default included). */
export function chatEffortFrom(raw: unknown): ChatEffort | null {
  return typeof raw === 'string' && (CHAT_EFFORTS as readonly string[]).includes(raw) ? raw as ChatEffort : null;
}

export interface ChatEffortContext {
  flagOn: boolean;
  capabilities: readonly string[];
  /** An ask's chat runs at the default effort (agent/ask-chat.js). */
  ask: boolean;
  /** The chat's model backend; only Claude's own models take an effort. */
  backend: string | null;
}

/** Whether this viewer's composer offers an effort for this chat. */
export function chatEffortInput(c: ChatEffortContext): boolean {
  return c.flagOn && !c.ask && !c.backend && c.capabilities.includes(CHAT_EFFORT_CAPABILITY);
}

/** The effort a send carries to the box, or null to run at the default. */
export function chatEffortForSend(raw: unknown, c: ChatEffortContext): ChatEffort | null {
  return chatEffortInput(c) ? chatEffortFrom(raw) : null;
}
