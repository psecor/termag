// Review text as termag shows it: the review
// card's own short lines, plain text with only their `code` spans drawn as
// code. GitHub's comments and descriptions go through the chat's markdown
// renderer instead (chat/Markdown.tsx, utils/prDescription.ts).
import React from 'react';

export function withCode(text: string): React.ReactNode {
  return text.split(/(`[^`\n]+`)/).map((part, i) => (part.length > 2 && part.startsWith('`') && part.endsWith('`')
    ? <code key={i}>{part.slice(1, -1)}</code>
    : <React.Fragment key={i}>{part}</React.Fragment>));
}

/** Up to two initials, for a comment's avatar. */
export function initials(login: string | null | undefined): string {
  const words = (login ?? '?').replace(/\[bot\]$/, '').split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return '?';
  return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
}
