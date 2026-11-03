// What a session's row says about its agent under the chrome refresh:
// one of six states, from the same live
// status the sidebar's words come from (simpleChat.sidebarLine), so the mark
// and the words never disagree. Unseen is the sidebar's (pages/chat/simpleData.tsx):
// the session came to rest after this browser last had it on screen.
//
//
//   working   a spinner            a turn is running, or the box sets it up
//   approval  an amber dot         it waits for a permission
//   unread    a blue dot           your turn: it asked something, a review is ready, or
//                                  it finished since you last looked (unseen)
//   error     a red dot            the turn stopped on an error (rate limited, failed)
//   done      nothing              it finished and has been seen
//   off       nothing (dimmed)     the agent isn't running
import type { ChatLiveStatus } from './chatLiveStatus';
import type { InboxRow } from '../mobile/inbox';
import { sidebarLine } from './simpleChat';

export type RowStateKind = 'working' | 'approval' | 'unread' | 'error' | 'done' | 'off';

export interface RowState {
  kind: RowStateKind;
  /** The words for it, as the sidebar has always shown them. */
  text: string;
  /** The agent's last words, when there are any. */
  message: string | null;
}

type Row = Pick<InboxRow, 'status' | 'waitingReason' | 'band' | 'ring' | 'review' | 'message'>;

export function chatRowState(
  row: Row, live: ChatLiveStatus | undefined, setupStatus: string | null | undefined, unseen = false,
): RowState {
  const line = sidebarLine(row as InboxRow, live, setupStatus);
  const text = line.state;
  const message = line.message ?? null;
  // An open chat's live status is where the words come from, so it alone decides
  // the mark too, whatever the hooks last said.
  if (live) {
    if (live.tone === 'error') return { kind: 'error', text, message };
    return { kind: line.glyph === 'working' ? 'working' : 'done', text, message };
  }
  if (line.glyph === 'working') return { kind: 'working', text, message };
  if (row.status === 'waiting') return { kind: row.waitingReason === 'approval' ? 'approval' : 'unread', text, message };
  if (row.band === 'attention') return { kind: 'unread', text, message };
  if (unseen) return { kind: 'unread', text: `${text} · unseen`, message };
  if (line.glyph === 'not_running') return { kind: 'off', text, message };
  return { kind: 'done', text, message };
}
