// The open chats' asks (chat/asks.ts askViews), by chat
// (`${projectId}|${workstream}`), for what shows them outside the chat's own
// view: the side panel's ask tab (pages/chat/AskTab.tsx). The chat view
// publishes its views as they change and clears them when it goes, as it does
// its subagents (chat/subagentStore.ts): no views is a chat not open, not one
// with no asks.
import { useSyncExternalStore } from 'react';
import type { AskView } from './asks';

const views = new Map<string, ReadonlyMap<string, AskView>>();
const listeners = new Set<() => void>();

export const askStore = {
  publish(chat: string, list: ReadonlyMap<string, AskView> | null): void {
    if (list === null ? !views.has(chat) : views.get(chat) === list) return;
    if (list === null) views.delete(chat);
    else views.set(chat, list);
    for (const l of listeners) l();
  },
  get(chat: string): ReadonlyMap<string, AskView> | null {
    return views.get(chat) ?? null;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

/** A chat's ask views as its view last published them; null while it isn't open. */
export function useChatAskViews(chat: string | null): ReadonlyMap<string, AskView> | null {
  return useSyncExternalStore(askStore.subscribe, () => (chat ? askStore.get(chat) : null));
}

/** An ask tab is an agent tab (chat/panelTabs.ts) whose id is the thread's, marked: `ask:<thread>`. */
export const askTabId = (thread: string): string => `ask:${thread}`;
export const askThreadOf = (tabId: string | null | undefined): string | null => (tabId?.startsWith('ask:') ? tabId.slice(4) : null);
