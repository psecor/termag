// In-chat recovery when the full UI's Claude still has this session.
// No terminal is shown, and nothing here tells the person to type into one.
import React from 'react';
import { TERMINAL_HOLD_VIEW } from './terminalHold';

export function TerminalHoldNotice({ busy, onReturn, onFullUi }: {
  busy: boolean;
  onReturn: () => void;
  onFullUi: () => void;
}) {
  return (
    <div className="chat-hold" role="note">
      <span>{TERMINAL_HOLD_VIEW.text}</span>
      <span className="chat-hold-actions">
        <button type="button" className="btn-tiny" disabled={busy} onClick={onReturn}>{TERMINAL_HOLD_VIEW.returnLabel}</button>
        <button type="button" className="btn-tiny" disabled={busy} onClick={onFullUi}>{TERMINAL_HOLD_VIEW.fullUiLabel}</button>
      </span>
    </div>
  );
}
