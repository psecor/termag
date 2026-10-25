// Two things at the end of an SDK chat's transcript that ask the user to act:
// messages Stop took back before they went ("Not sent", with Send and
// Discard, so they never come back glued to the next message), and a turn
// that ended on an error (Retry sends its prompt again).
import React from 'react';
import { errorHint } from '../../chat/sdkChat';

export function UnsentMessages({ texts, onSend, onDiscard, disabled }: {
  texts: readonly string[];
  onSend: (index: number) => void;
  onDiscard: (index: number) => void;
  disabled?: boolean;
}) {
  return (
    <>
      {texts.map((text, i) => (
        <div key={`unsent:${i}:${text}`} className="sdk-user sdk-unsent" data-pending="">
          <div className="sdk-user-bubble">{text}</div>
          <div className="sdk-user-note">Not sent: you stopped the turn before it went.</div>
          <div className="sdk-unsent-actions">
            <button type="button" className="btn-tiny sdk-unsent-send" disabled={disabled} onClick={() => onSend(i)}>Send</button>
            <button type="button" className="btn-tiny sdk-unsent-discard" onClick={() => onDiscard(i)}>Discard</button>
          </div>
        </div>
      ))}
    </>
  );
}

export function ChatError({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const hint = errorHint(text);
  return (
    <div className="sdk-error" role="alert">
      {hint && <div className="sdk-error-hint">{hint}</div>}
      <div className={hint ? 'sdk-error-raw' : undefined}>{text}</div>
      {onRetry && <button type="button" className="btn-tiny sdk-error-retry" onClick={onRetry}>Retry</button>}
    </div>
  );
}
