// What an open SDK chat says about itself, for the sidebar: the status line
// under its transcript and its last assistant text. The open chat's view
// publishes it (pages/chat/SdkChatView.tsx) and the sidebar reads it, so the
// row and the header never disagree; a chat that is not open falls back to
// the status pipeline (chat/simpleChat.ts sidebarLine).
import { useSyncExternalStore } from 'react';

export interface ChatLiveStatus {
  tone: 'idle' | 'working' | 'error' | 'setup';
  text: string;
  /** The last assistant text, one line; null before Claude has said anything. */
  preview: string | null;
}

let current: ReadonlyMap<string, ChatLiveStatus> = new Map();
const listeners = new Set<() => void>();

export function chatLiveKey(projectId: string, workstream: string): string {
  return `${projectId}|${workstream}`;
}

/** Publish (or with null, withdraw) what the chat `key` shows. */
export function publishChatStatus(key: string, status: ChatLiveStatus | null): void {
  const prev = current.get(key);
  if (status && prev && prev.tone === status.tone && prev.text === status.text && prev.preview === status.preview) return;
  if (!status && !prev) return;
  const next = new Map(current);
  if (status) next.set(key, status); else next.delete(key);
  current = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useChatLiveStatuses(): ReadonlyMap<string, ChatLiveStatus> {
  return useSyncExternalStore(subscribe, () => current);
}
