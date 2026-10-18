// Simple-UI chat events from the status socket (ProjectContext) to the chat
// view that shows that chat (pages/chat/SdkChatView.tsx).

export interface ChatFrame {
  type: 'chat';
  projectId: string;
  workstream: string;
  turnId: string | null;
  /** The event's line in its turn's log, from 1; null from an agent before durable turns. */
  seq?: number | null;
  event: unknown;
}

type Listener = (frame: ChatFrame) => void;
const listeners = new Set<Listener>();
const reconnectListeners = new Set<() => void>();

export const chatEvents = {
  publish(frame: ChatFrame): void {
    for (const fn of listeners) fn(frame);
  },
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
  // The status socket (re)opened: frames may have been dropped while it was
  // down, so the open chat view refetches its history to settle `running`.
  notifyReconnect(): void {
    for (const fn of reconnectListeners) fn();
  },
  subscribeReconnect(fn: () => void): () => void {
    reconnectListeners.add(fn);
    return () => { reconnectListeners.delete(fn); };
  },
};
