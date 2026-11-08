// A pane chat's restart notices (chat/chatNotices.ts), read when the chat
// opens and again whenever its agent's status changes: a relaunch moves it,
// so the line a tool update just printed shows without a reload. Read twice on
// a change, now and NOTICE_RECHECK_MS later, in case the status moved before
// the server had stored the line (Bugbot on #1301).
import { useEffect, useState } from 'react';
import { chatApi } from '../services/api';
import { parseChatNotice, type ChatNotice } from './chatNotices';

export const NOTICE_RECHECK_MS = 5000;

export function useChatNotices(projectId: string | null, workstream: string, refreshKey: unknown): ChatNotice[] {
  const [notices, setNotices] = useState<ChatNotice[]>([]);
  useEffect(() => { setNotices([]); }, [projectId, workstream]);
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    const read = () => chatApi.notices(projectId, workstream)
      .then(r => { if (live) setNotices((Array.isArray(r?.notices) ? r.notices : []).map(parseChatNotice).filter((x): x is ChatNotice => x !== null)); })
      // Best effort: a chat without its notices is still the chat.
      .catch(() => {});
    void read();
    const again = setTimeout(() => { void read(); }, NOTICE_RECHECK_MS);
    return () => { live = false; clearTimeout(again); };
  }, [projectId, workstream, refreshKey]);
  return notices;
}
