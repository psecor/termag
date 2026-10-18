// The setup narration both chat views show while a chat comes up
// (chat/newChat.ts setupSteps): the box, the clone, Claude.
import React from 'react';
import type { SetupStep } from './newChat';

const STEP_MARK: Record<SetupStep['state'], string> = { done: '✓', active: '◌', pending: '○', failed: '✗' };

export function SetupSteps({ steps }: { steps: SetupStep[] }) {
  return (
    <ol className="chat-steps" aria-label="Setting up">
      {steps.map(s => (
        <li key={s.id} className="chat-step" data-state={s.state}>
          <span className="chat-step-mark" aria-hidden="true">{STEP_MARK[s.state]}</span>
          <span>{s.text}</span>
        </li>
      ))}
    </ol>
  );
}
