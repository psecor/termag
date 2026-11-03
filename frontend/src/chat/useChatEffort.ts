// The effort an open chat's composer sends (backend services/chatEffort.ts).
// Nothing keeps it on the server: the choice is this browser's, per chat, and
// rides on every message, so it holds from the next message on until it is
// changed. New session writes the new chat's choice here before its first
// message goes (pages/chat/NewChat.tsx).
import { useCallback, useEffect, useState } from 'react';
import { isChatEffort, type ChatEffortId } from './composer';

const key = (chatId: string) => `termag.chatEffort.${chatId}`;

export function readEffortPick(chatId: string): ChatEffortId {
  try {
    const v = localStorage.getItem(key(chatId));
    return isChatEffort(v) ? v : 'default';
  } catch { return 'default'; }
}

export function writeEffortPick(chatId: string, id: ChatEffortId) {
  try {
    if (id === 'default') localStorage.removeItem(key(chatId));
    else localStorage.setItem(key(chatId), id);
  } catch { /* the choice still holds for this page */ }
}

/**
 * Whether the composer should say a change waits for the next message: only
 * once a message from this page has gone at another effort.
 */
export function chatEffortPending(effort: ChatEffortId, sent: ChatEffortId | null): boolean {
  return sent != null && sent !== effort;
}

export function useChatEffort(chatId: string) {
  const [effort, setEffort] = useState<ChatEffortId>(() => readEffortPick(chatId));
  const [sentWith, setSentWith] = useState<ChatEffortId | null>(null);
  useEffect(() => {
    setEffort(readEffortPick(chatId));
    setSentWith(null);
  }, [chatId]);

  const choose = useCallback((id: ChatEffortId) => {
    setEffort(id);
    writeEffortPick(chatId, id);
  }, [chatId]);

  /** A message went in at `id`. */
  const sent = useCallback((id: ChatEffortId) => setSentWith(id), []);

  return { effort, choose, sent, pending: chatEffortPending(effort, sentWith) };
}
