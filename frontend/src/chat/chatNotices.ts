// The lines in a pane chat's timeline that are neither the person's nor the
// agent's: today a tool update's restart notice ("In the
// chat"), from GET /api/projects/:id/chat/notices. Pure, no React.
//
// A pane chat is a capture of the agent pane, which holds only the session
// running now, so the agent pane's notice that belongs in it is the one that
// restarted that session: the newest. It sits where that session starts, above
// the pane's blocks; another pane's restart is a note after them
// (chatNoticePlacement). Both stay across reloads: the server keeps them.

export interface ChatNotice {
  id: string;
  kind: string;
  /** The pane it was printed in: `agent`, or the workstream's `ctrl`, `review`, `data`, `data-ctrl` pane. */
  pane: string;
  text: string;
  /** ISO. */
  at: string;
}

/** How long a restart notice stays above the session it restarted. */
export const NOTICE_SHOWN_MS = 7 * 24 * 60 * 60 * 1000;

// The server's check (backend services/toolUpdate/notice.ts NOTICE_SAFE and
// chatNoticeText), again: a line that fails it is not shown.
const NOTICE_SAFE = /^[A-Za-z0-9 .,;:()[\]_+-]{1,200}$/;

/** A notice as the server sent it, or null when it is not one. */
export function parseChatNotice(v: unknown): ChatNotice | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.kind !== 'string' || typeof r.pane !== 'string' || typeof r.at !== 'string') return null;
  if (typeof r.text !== 'string' || !r.text.startsWith('[termag] ') || !NOTICE_SAFE.test(r.text)) return null;
  if (!Number.isFinite(Date.parse(r.at))) return null;
  return { id: r.id, kind: r.kind, pane: r.pane, text: r.text, at: r.at };
}

/**
 * Where a pane chat shows its notices. `session`: the newest notice printed in
 * the agent pane itself, which marks where the session the chat shows started
 * (a divider above the pane's blocks). `side`: the newest notice printed in
 * another pane of the workstream (its side terminal, Review or data pane), and
 * only one newer than `session`: that pane restarted while the agent's session
 * went on, so it is a note after the blocks, never above them, which would say
 * the agent's session restarted (Devin on #1301). Each within NOTICE_SHOWN_MS.
 */
export function chatNoticePlacement(notices: readonly ChatNotice[], now: number = Date.now()): { session: ChatNotice | null; side: ChatNotice | null } {
  const newest = (pick: (n: ChatNotice) => boolean): ChatNotice | null => {
    let best: ChatNotice | null = null;
    for (const n of notices) {
      if (!pick(n)) continue;
      const at = Date.parse(n.at);
      if (!(now - at < NOTICE_SHOWN_MS)) continue;
      if (!best || at >= Date.parse(best.at)) best = n;
    }
    return best;
  };
  const session = newest(n => n.pane === 'agent');
  const side = newest(n => n.pane !== 'agent');
  return { session, side: side && (!session || Date.parse(side.at) > Date.parse(session.at)) ? side : null };
}

/** Where a notice was printed, when not in the chat's own pane: said after it. */
export function noticePaneLabel(pane: string): string | null {
  switch (pane) {
    case 'ctrl': return 'in the side terminal';
    case 'review': return 'in the Review pane';
    case 'data': case 'data-ctrl': return 'in the data pane';
    default: return null;
  }
}
