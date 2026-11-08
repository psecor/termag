// The keys of the simple UI's terminal key bar on a phone
// (pages/chat/TerminalKeyBar.tsx), as the bytes a terminal sends for
// them. They go down the terminal's own WebSocket, the same path as typing
// (components/Terminal.tsx sendInput), never through send-keys: the phone
// client's bar (chat/quickKeys.ts) sends tmux key names, this one raw input.
// Labels are shared through chat/keyLabels.ts.
import { KEY_LABELS } from '../chat/keyLabels';

export type BarKeyId = 'escape' | 'tab' | 'ctrl' | 'up' | 'down' | 'left' | 'right' | 'interrupt' | 'pipe' | 'tilde' | 'slash';

export interface BarKey {
  id: BarKeyId;
  label: string;
  title: string;
  /** Ctrl is a sticky modifier, a toggle; every other key sends bytes. */
  modifier?: true;
}

/** The bar, in order. The keyboard button (it only focuses the terminal) is the bar's own. */
export const TERMINAL_BAR_KEYS: readonly BarKey[] = [
  { id: 'escape', ...KEY_LABELS.escape },
  { id: 'tab', ...KEY_LABELS.tab },
  { id: 'ctrl', label: 'Ctrl', title: 'Ctrl: the next key is sent with Ctrl', modifier: true },
  { id: 'up', ...KEY_LABELS.up },
  { id: 'down', ...KEY_LABELS.down },
  { id: 'left', ...KEY_LABELS.left },
  { id: 'right', ...KEY_LABELS.right },
  { id: 'interrupt', ...KEY_LABELS.interrupt },
  { id: 'pipe', label: '|', title: 'Type |' },
  { id: 'tilde', label: '~', title: 'Type ~' },
  { id: 'slash', label: '/', title: 'Type /' },
];

export interface KeyState {
  /** Ctrl is armed: this key is sent with Ctrl. */
  ctrl: boolean;
  /**
   * The terminal is in application cursor mode (DECCKM, xterm's
   * `modes.applicationCursorKeysMode`: less, vim, a full-screen TUI), where
   * an unmodified arrow is SS3 (`ESC O A`) rather than CSI (`ESC [ A`).
   */
  appCursor: boolean;
}

const ARROW: Record<'up' | 'down' | 'left' | 'right', string> = { up: 'A', down: 'B', right: 'C', left: 'D' };
const CHAR: Record<'pipe' | 'tilde' | 'slash', string> = { pipe: '|', tilde: '~', slash: '/' };

/**
 * The control byte for `ch` typed with Ctrl, as xterm encodes it, or null
 * when Ctrl does nothing to it (the character is then sent as is).
 */
export function controlByte(ch: string): string | null {
  if (ch.length !== 1) return null;
  const c = ch.charCodeAt(0);
  if ((c >= 0x61 && c <= 0x7a) || (c >= 0x40 && c <= 0x5f)) return String.fromCharCode(c & 0x1f); // a-z, @ A-Z [ \ ] ^ _
  if (ch === ' ' || ch === '2') return '\x00';
  if (ch === '/' || ch === '-' || ch === '7') return '\x1f';
  if (ch === '?' || ch === '8') return '\x7f';
  if (ch === '3') return '\x1b';
  if (ch === '4') return '\x1c';
  if (ch === '5') return '\x1d';
  if (ch === '6' || ch === '~') return '\x1e';
  return null;
}

/** The bytes a bar key sends. Ctrl itself sends nothing (null). */
export function barKeyBytes(id: BarKeyId, state: KeyState): string | null {
  switch (id) {
    case 'ctrl': return null;
    case 'escape': return '\x1b';
    case 'tab': return '\t';
    case 'interrupt': return '\x03';
    case 'up': case 'down': case 'left': case 'right':
      // Ctrl+arrow is CSI 1;5 whatever the cursor mode (word left/right in a shell).
      if (state.ctrl) return `\x1b[1;5${ARROW[id]}`;
      return `${state.appCursor ? '\x1bO' : '\x1b['}${ARROW[id]}`;
    case 'pipe': case 'tilde': case 'slash': {
      const ch = CHAR[id];
      return state.ctrl ? controlByte(ch) ?? ch : ch;
    }
  }
}

/**
 * What the phone's keyboard typed, with Ctrl armed from the bar: its first
 * character becomes the control byte (a predictive keyboard can deliver more
 * than one at once; the rest go as typed). Input Ctrl does nothing to, such as
 * an escape sequence or a character with no control byte, passes unchanged.
 */
export function withStickyCtrl(data: string): string {
  if (data.length === 0 || data[0] === '\x1b') return data;
  const first = controlByte(data[0]);
  return first === null ? data : first + data.slice(1);
}
