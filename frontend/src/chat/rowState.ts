// What a session's row says about its agent under the chrome refresh:
// one of six states, from the same live:
// one of six marks, from the same live
// status the sidebar's words come from (simpleChat.sidebarLine), so the mark
// and the words never disagree: each mark has one status word
// (chat/statusWords.ts statusWordFor).
//
//   working   a spinner            Working: a turn, a tool, a review, or the box sets it up
//   approval  an amber dot         Needs you: it waits for a permission
//   unread    a blue dot           Needs you: it asked something, or a review is ready
//   error     a red dot            Needs you: the turn stopped on an error (rate limited, failed)
//   done      nothing              Idle: it finished its turn
//   off       nothing (dimmed)     Not running: the agent isn't running
//
// Unseen is a dot, not a state: a session that came to rest after this browser
// last had it on screen (pages/chat/simpleData.tsx) keeps
// its kind (done or off) and its word, with " · unread" and the blue dot.
import type { ChatLiveStatus } from './chatLiveStatus';
import type { InboxRow } from '../mobile/inbox';
import { sidebarLine } from './simpleChat';

export type RowStateKind = 'working' | 'approval' | 'unread' | 'error' | 'done' | 'off';

export interface RowState {
  kind: RowStateKind;
  /** The words for it: one of the four status words, then why. */
  text: string;
  /** The agent's last words, when there are any. */
  message: string | null;
  /** It came to rest since this browser last showed it: the mark draws the blue dot. Only a done or off row is unseen. */
  unseen: boolean;
}

type Row = Pick<InboxRow, 'status' | 'waitingReason' | 'band' | 'ring' | 'review' | 'message'>;

/**
 * The live status the redesigned sidebar reads a row by: the open chat's, unless its box
 * is down while the session waits on you. A box that parks leaves the hooks' last word standing (nothing moves a
 * waiting status when it stops), and a chat on a stopped box knows nothing newer, so a question, an approval or a
 * review that's ready still needs you there: the open session never reads, or files under, Not running. With the box
 * up the live chat still decides alone, as it knows better than the hooks (chatRowState).
 */
export function liveUnlessWaiting(row: Pick<Row, 'status' | 'band'>, live: ChatLiveStatus | undefined): ChatLiveStatus | undefined {
  return live?.tone === 'off' && (row.status === 'waiting' || row.band === 'attention') ? undefined : live;
}

export function chatRowState(
  row: Row, live: ChatLiveStatus | undefined, setupStatus: string | null | undefined, unseen = false,
): RowState {
  const line = sidebarLine(row as InboxRow, live, setupStatus);
  const text = line.state;
  const message = line.message ?? null;
  const state = (kind: RowStateKind): RowState => ({ kind, text, message, unseen: false });
  // An open chat's live status is where the words come from, so it alone decides
  // the mark too, whatever the hooks last said.
  if (live) {
    if (live.tone === 'error') return state('error');
    if (line.glyph === 'not_running') return state('off');
    return state(line.glyph === 'working' ? 'working' : 'done');
  }
  // The order statusLabel's words take (mobile/inbox.ts): needing you first,
  // a finished review included, then working, a Devin review included.
  if (row.status === 'waiting') return state(row.waitingReason === 'approval' ? 'approval' : 'unread');
  if (row.band === 'attention') return state('unread');
  if (line.glyph === 'working' || row.ring === 'reviewing') return state('working');
  const kind: RowStateKind = line.glyph === 'not_running' ? 'off' : 'done';
  return unseen ? { kind, text: `${text} · unread`, message, unseen: true } : state(kind);
}
