// The names a person sees on the phone's special keys, shared by the two key
// bars: the phone client's under a chat transcript (chat/quickKeys.ts, tmux key
// names through send-keys) and the simple UI's under its terminal overlay
// (utils/terminalKeyBar.ts, raw bytes down the terminal's WebSocket). Only the
// labels and titles are shared; each bar keeps its own transport.
export interface KeyLabel {
  label: string;
  title: string;
}

export const KEY_LABELS = {
  enter: { label: 'Enter', title: 'Press Enter' },
  escape: { label: 'Esc', title: 'Press Escape' },
  tab: { label: 'Tab', title: 'Press Tab' },
  up: { label: '↑', title: 'Arrow up' },
  down: { label: '↓', title: 'Arrow down' },
  left: { label: '←', title: 'Arrow left' },
  right: { label: '→', title: 'Arrow right' },
  interrupt: { label: '^C', title: 'Ctrl-C (interrupt)' },
} as const satisfies Record<string, KeyLabel>;
