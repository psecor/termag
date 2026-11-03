// In-chat recovery when the full UI's Claude still has this session.
// No terminal is shown, and nothing here tells the person to type into one.
import React from 'react';
import { Button } from '@launchpad-ui/components';
import { TERMINAL_HOLD_VIEW } from './terminalHold';

export function TerminalHoldNotice({ busy, onReturn, onFullUi, refresh = false }: {
  busy: boolean;
  onReturn: () => void;
  onFullUi: () => void;
  /** The chrome refresh's: LaunchPad's buttons, with the way back to this chat the primary one. */
  refresh?: boolean;
}) {
  return (
    <div className="chat-hold" role="note">
      <span>{TERMINAL_HOLD_VIEW.text}</span>
      {refresh ? (
        <span className="chat-hold-actions">
          <Button variant="primary" size="small" isDisabled={busy} onPress={onReturn}>{TERMINAL_HOLD_VIEW.returnLabel}</Button>
          <Button size="small" isDisabled={busy} onPress={onFullUi}>{TERMINAL_HOLD_VIEW.fullUiLabel}</Button>
        </span>
      ) : (
        <span className="chat-hold-actions">
          <button type="button" className="btn-tiny" disabled={busy} onClick={onReturn}>{TERMINAL_HOLD_VIEW.returnLabel}</button>
          <button type="button" className="btn-tiny" disabled={busy} onClick={onFullUi}>{TERMINAL_HOLD_VIEW.fullUiLabel}</button>
        </span>
      )}
    </div>
  );
}
