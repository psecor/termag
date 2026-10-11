// Keys the browser terminal sends differently from xterm.js's default encoding.
//
// xterm.js encodes Enter and Shift+Enter as the same bare CR (it only looks at
// Alt), so an agent CLI cannot tell them apart and Shift+Enter submits instead
// of inserting a newline. ESC CR is what xterm already sends for Alt+Enter and
// what Claude Code's own VS Code terminal setup sends for Shift+Enter; Claude
// Code treats it as "insert newline", and tmux on the boxes passes it through
// (verified end to end through a tmux client pty). In a plain shell it is an
// unbound Meta-Enter, so the ctrl pane is unaffected.
export const SHIFT_ENTER_SEQUENCE = '\x1b\r';

export interface KeyEventLike {
  type: string;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** The bytes to send for a key xterm.js would encode ambiguously, or null to let xterm handle it. */
export function customKeySequence(ev: KeyEventLike): string | null {
  if (ev.type !== 'keydown') return null;
  if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) return SHIFT_ENTER_SEQUENCE;
  return null;
}
