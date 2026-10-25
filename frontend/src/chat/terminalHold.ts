// The simple UI hides the terminal. A Claude left open by "Open in full UI"
// must not be a red line that says to type /exit there. History reports
// whether that Claude is still the pane's foreground. A later poll that says
// it is gone clears a send the pane refused, so Send works again.

export const TERMINAL_HOLDS_CODE = 'terminal-holds';

export const TERMINAL_HOLD_VIEW = {
  statusText: 'Open in the full UI',
  text: 'Claude is open in the full UI, so this chat cannot send yet.',
  returnLabel: 'Return it to this chat',
  fullUiLabel: 'Continue in the full UI',
} as const;

export interface HoldState {
  /** The last history said the pane's Claude is live. */
  held: boolean;
  /** A send was refused because the pane held the session. */
  refused: boolean;
}

/**
 * Fold one history poll into the hold. `true` keeps the notice up. `false`
 * means a shell (or a dead pane) proved Claude has left: drop the refusal so
 * Send is not stuck on it. Missing — an older backend, a probe miss, or
 * another program — leaves the notice as it was. A miss is not Claude left.
 */
export function reduceHold(state: HoldState, reported: boolean | undefined): HoldState & { show: boolean } {
  if (reported === true) return { held: true, refused: state.refused, show: true };
  if (reported === false) return { held: false, refused: false, show: false };
  const show = state.held || state.refused;
  return { ...state, show };
}

/** A send failed because the pane holds the session. Other failures stay text. */
export function refusalFromSend(code: string | null): boolean {
  return code === TERMINAL_HOLDS_CODE;
}

/**
 * The header while the notice is up. "Done · your turn" would otherwise sit
 * next to a composer that cannot send. A running turn keeps its own line.
 */
export function statusBesideHold<T extends { tone: string; text: string }>(
  showing: boolean,
  running: boolean,
  status: T,
): T {
  if (showing && !running && status.tone === 'idle') return { ...status, text: TERMINAL_HOLD_VIEW.statusText };
  return status;
}
