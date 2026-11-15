// The box a session runs on, as a quiet pill: a muted outline, the name, and
// a small dot in its box's colour, the same colour the full UI gives that
// box's projects (utils/boxColor.ts). The colour is only the dot's, so the
// pill never reads as a warning or a focused field. The simple UI's sidebar,
// its conversation header and its ⌘K results show it.
import React from 'react';
import { boxStripeColor } from '../utils/boxColor';

export function BoxPill({ instanceId, label, className = '' }: { instanceId: string | null | undefined; label: string; className?: string }) {
  const color = boxStripeColor(instanceId);
  return (
    <span className={`chat-box-tag ${className}`.trim()} title={`Runs on ${label}`} style={color ? { '--chat-box': color } as React.CSSProperties : undefined}>
      {color && <span className="chat-box-tag-dot" aria-hidden="true" />}
      <span className="chat-box-tag-name">{label}</span>
    </span>
  );
}
