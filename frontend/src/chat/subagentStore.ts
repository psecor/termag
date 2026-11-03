// The open chats' subagents (chat/subagents.ts subagentsOf), by chat
// (`${projectId}|${workstream}`), for what shows them outside the chat's own
// view: the side panel's agent tab (pages/chat/AgentTab.tsx). The chat view
// publishes its list once its history is in, as its state changes, and clears
// it when it goes: no list is a chat not open or still loading, not one with none.
import { useSyncExternalStore } from 'react';
import type { SubagentView } from './subagents';

const lists = new Map<string, readonly SubagentView[]>();
// The subagent whose agent tab is on screen, by chat: its row in the chat says so.
const shown = new Map<string, string>();
const listeners = new Set<() => void>();

export const subagentStore = {
  publish(chat: string, list: readonly SubagentView[] | null): void {
    if (list === null ? !lists.has(chat) : lists.get(chat) === list) return;
    if (list === null) lists.delete(chat);
    else lists.set(chat, list);
    for (const l of listeners) l();
  },
  get(chat: string): readonly SubagentView[] | null {
    return lists.get(chat) ?? null;
  },
  setShown(chat: string, id: string | null): void {
    if ((shown.get(chat) ?? null) === id) return;
    if (id === null) shown.delete(chat);
    else shown.set(chat, id);
    for (const l of listeners) l();
  },
  shown(chat: string): string | null {
    return shown.get(chat) ?? null;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

/** A chat's subagents as its view last published them; null while it isn't open or its history loads. */
export function useChatSubagents(chat: string | null): readonly SubagentView[] | null {
  return useSyncExternalStore(subagentStore.subscribe, () => (chat ? subagentStore.get(chat) : null));
}

/** The subagent whose agent tab is on screen beside this chat, or null. */
export function useShownSubagent(chat: string): string | null {
  return useSyncExternalStore(subagentStore.subscribe, () => subagentStore.shown(chat));
}
