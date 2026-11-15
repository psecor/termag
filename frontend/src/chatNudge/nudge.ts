// Lab's nudge toward termag's chat, behind chat-ui-nudge-enabled:
// who sees it, and its copy.

import type { UiMode } from '../chat/uiMode';

export const CHAT_NUDGE_COPY = {
  title: "Try termag's chat (recommended)",
  description: "It's the easiest way to work with your agents: one chat per session, with a terminal, files or a browser beside it when you need one. Switching makes it your default.",
  switch: 'Switch to chat',
  dismiss: 'Not now',
  spotlight: "You can switch to termag's chat here anytime.",
  spotlightDone: 'Got it',
} as const;

/**
 * Whether Lab shows the toast: the flag is on, the server says it hasn't been
 * answered (the field is absent while the server's flag is off, so nothing
 * shows), and the person's kept choice is Lab. Someone whose choice is the
 * chat and who came to Lab on a deep link isn't asked again.
 */
export function shouldShowChatNudge(i: { on: boolean; dismissed: boolean | undefined; mode: UiMode }): boolean {
  return i.on && i.dismissed === false && i.mode === 'full';
}
