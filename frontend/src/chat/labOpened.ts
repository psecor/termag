// lab.opened {from}: someone left the chat, or /m, for Lab, and which way out
// they took. Lab stays as the escape hatch, so each
// `from` points at something the chat still lacks.
// Recorded beside the navigation,
// once it is going ahead: a refused Open in Lab (a turn still running) sends
// nothing. ui.mode.switched {from, to} is separate and unchanged.

import { recordProductEvent } from '../observability';

export type LabOpenedFrom =
  // A session's ⋯ menu: the refreshed header's (SessionHeader), and a phone's ⋯ in the SDK and pane chats.
  | 'session-menu'
  // The old header's Open in Lab: SdkChatView's button and ChatView's link.
  | 'header'
  // "Stuck on a question? Answer it in Lab", under setup's latest from the box.
  | 'stuck-hint'
  // Open Lab in the account menu, and the old sidebar's foot link.
  | 'account-menu'
  // /m: a conversation's and a session row's Open in Lab, and the app menu's Lab.
  | 'phone'
  // ⌘K: Open Lab, and an open chat's Open in Lab.
  | 'command-menu'
  // The composer's "Claude is open in Lab" notice: Continue in Lab.
  | 'terminal-hold'
  // An archived session whose box still runs: Open in Lab, where the box can be stopped.
  | 'archived'
  // An automation's Open in Lab, to edit its schedule and prompt.
  | 'automation';

export function recordLabOpened(from: LabOpenedFrom): void {
  recordProductEvent('lab.opened', { 'termag.from': from });
}
