// "Load earlier" state for one conversation pane:
// plain chunks of the pane output log, paged backward byte by byte. Pure
// state transitions, unit tested; Conversation.tsx renders them.
import { sessionsApi } from '../services/api';

export type HistoryChunk = Awaited<ReturnType<typeof sessionsApi.history>>;

export interface PaneHistoryState {
  /** Earlier chunks, oldest first; rendered above the transcript in order. */
  chunks: Array<{ text: string; startByte: number }>;
  /** The offset the next earlier page reads before; null until one loads. */
  before: number | null;
  loading: boolean;
  /** Nothing earlier: startByte reached 0, or the box records no history. */
  exhausted: boolean;
  error: 'unavailable' | 'failed' | null;
}

export const initialPaneHistory: PaneHistoryState = {
  chunks: [],
  before: null,
  loading: false,
  exhausted: false,
  error: null,
};

// The pane log is the raw stream, SGR and cursor movement included; a plain
// earlier-output section wants none of it. CSI, OSC (to BEL or ST), and every
// other two-byte escape.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_].*?\x1b\\|\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

export function loadEarlierStart(s: PaneHistoryState): PaneHistoryState {
  if (s.loading || s.exhausted) return s;
  return { ...s, loading: true, error: null };
}

export function loadEarlierDone(s: PaneHistoryState, chunk: HistoryChunk): PaneHistoryState {
  const page = { text: stripAnsi(chunk.content), startByte: chunk.startByte };
  return {
    chunks: [page, ...s.chunks],
    before: chunk.startByte,
    loading: false,
    // The agent says 0 when the log's beginning is reached. An empty page
    // (a line longer than the chunk cap) still moved backward — only the
    // offset decides exhaustion.
    exhausted: chunk.startByte <= 0,
    error: null,
  };
}

export function loadEarlierFail(s: PaneHistoryState, status: number | undefined): PaneHistoryState {
  // 404 (no log on the box yet) and 501 (the box's agent predates the RPC)
  // will not change on a retry: give up quietly. Anything else keeps the
  // button, the tap being free.
  if (status === 404 || status === 501) return { ...s, loading: false, exhausted: true, error: null };
  return { ...s, loading: false, error: 'failed' };
}
