// The four words a session's status leads with, on every surface:
//the chat's
// sidebar, header and status line, the phone layout, /m and the push
// notifications. This is the only place they are spelled; every status line
// is one of them, then optionally " · " and why.
//
//   Working      termag or the agent is doing something: a turn, a tool, a
//                review, or setting up the box or clone
//   Needs you    nothing moves until you act: an approval, a question, a
//                review that's ready, a turn that failed
//   Idle         it finished its turn and waits for your next message
//   Not running  no agent is running
import type { RowStateKind } from './rowState';

export type StatusWord = 'Working' | 'Needs you' | 'Idle' | 'Not running';

export const STATUS_WORDS: readonly StatusWord[] = ['Working', 'Needs you', 'Idle', 'Not running'];

/** The word for a row's mark (chat/rowState.ts): one answer per kind. */
export function statusWordFor(kind: RowStateKind): StatusWord {
  switch (kind) {
    case 'working': return 'Working';
    case 'approval':
    case 'unread':
    case 'error': return 'Needs you';
    case 'done': return 'Idle';
    case 'off': return 'Not running';
  }
}

const SEP = ' · ';

/** A status line: the word, then why when there is a detail. */
export function statusText(word: StatusWord, detail?: string | null): string {
  const d = detail?.trim();
  return d ? `${word}${SEP}${d}` : word;
}

/** The word a status line leads with, or null when it leads with none of the four. */
export function leadWord(text: string): StatusWord | null {
  return STATUS_WORDS.find(w => text === w || text.startsWith(`${w}${SEP}`)) ?? null;
}

/** The line under a chat that finished: the transcript's alone says whose turn it is. */
export const DONE_YOUR_TURN = statusText('Idle', 'your turn');

/**
 * A status line as the header and the sidebar say it: the word alone for a
 * plain finished turn ("Idle"), whose "your turn" is the transcript's line;
 * anything else as it is.
 */
export function rowStatusText(text: string): string {
  return text === DONE_YOUR_TURN ? 'Idle' : text;
}

/** A spinner's or phase's verb as a detail: "Thinking…" reads "thinking…" after the word. */
export function asDetail(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}
