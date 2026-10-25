// The composer's mic button and the note under the box while dictating
// (chat/useDictation.ts). Neither renders where dictation is not available.
import React from 'react';
import { dictationShortcutLabel } from './dictation';
import type { DictationControl } from './useDictation';

const SHORTCUT = dictationShortcutLabel(typeof navigator !== 'undefined' ? navigator.platform : undefined);

function MicIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <rect x="7" y="2.5" width="6" height="10" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" />
    </svg>
  );
}

export function DictationButton({ dictation, disabled, className = 'chat-icon-btn chat-mic' }: {
  dictation: DictationControl;
  disabled?: boolean;
  className?: string;
}) {
  if (!dictation.available) return null;
  const { listening, blocked, state } = dictation;
  const label = listening ? 'Stop dictating' : 'Dictate';
  const title = blocked && !listening
    ? 'Microphone blocked for this site. Allow it in the browser to dictate.'
    : listening
      ? `Stop dictating (${SHORTCUT}) · Esc puts the text back`
      : `Dictate (${SHORTCUT}). Your browser's speech service, or a model on this device where the browser has none, turns speech into text; you review it before sending.`;
  return (
    <button
      type="button"
      className={className}
      data-state={state}
      aria-pressed={listening}
      aria-label={label}
      title={title}
      disabled={!listening && (disabled || blocked)}
      // Keep the cursor in the composer, so Enter and Esc still reach it.
      onMouseDown={e => e.preventDefault()}
      onClick={dictation.toggle}
    >
      <MicIcon />
    </button>
  );
}

/** "Listening…" with how to finish, or why dictation stopped. */
export function DictationNote({ dictation, className = 'chat-composer-note' }: { dictation: DictationControl; className?: string }) {
  if (!dictation.available) return null;
  if (dictation.listening) {
    return (
      <div className={`${className} chat-dictation-note`} role="status" aria-live="polite">
        <span className="chat-dictation-dot" aria-hidden="true" />
        {dictation.state === 'starting' ? 'Starting the microphone…' : dictation.state === 'stopping' ? 'Finishing…' : 'Listening… click the mic to stop, Esc to discard'}
        {dictation.loading != null && ` · loading the speech model (first time only), ${Math.round(dictation.loading * 100)}%`}
      </div>
    );
  }
  if (dictation.error) return <div className={className} data-error="" role="alert">{dictation.error}</div>;
  return null;
}
