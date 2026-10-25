// Phone chrome for the simple UI: the conversation list opens over a chat
// instead of sitting beside it, and a chat's header is one row with its
// actions under ⋮. Desktop (mode docked) renders none of this. Also the side
// panel's toggle (chat/sidePanel.ts), on every width.
import React, { createContext, useContext } from 'react';
import { useContextMenu, type MenuAction } from './ContextMenu';
import type { ChatHistoryMode } from '../../chat/chatLayout';

export interface ChatChrome {
  mode: ChatHistoryMode;
  historyOpen: boolean;
  openHistory: () => void;
  closeHistory: () => void;
  /** The side panel, where simple-ui-side-panel-enabled is on; else absent. */
  sidePanel?: { open: boolean; toggle: () => void };
}

const Ctx = createContext<ChatChrome>({
  mode: 'docked',
  historyOpen: false,
  openHistory: () => {},
  closeHistory: () => {},
});

export function ChatChromeProvider({ value, children }: { value: ChatChrome; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChatChrome(): ChatChrome {
  return useContext(Ctx);
}

/** Opens the conversation list. Rendered only while that list is a drawer. */
export function ChatHistoryButton() {
  const { mode, historyOpen, openHistory } = useChatChrome();
  if (mode !== 'drawer') return null;
  return (
    <button
      type="button"
      className="btn-ghost chat-history-btn"
      aria-expanded={historyOpen}
      aria-controls="chat-conversations"
      onClick={openHistory}
    >
      Sessions
    </button>
  );
}

/** Opens and shuts the side panel (files, terminal, browser). Rendered only where the panel is on. */
export function SidePanelButton() {
  const { sidePanel } = useChatChrome();
  if (!sidePanel) return null;
  return (
    <button
      type="button"
      className={`btn-ghost chat-side-toggle ${sidePanel.open ? 'active' : ''}`}
      aria-expanded={sidePanel.open}
      aria-controls="chat-side-panel"
      onClick={sidePanel.toggle}
      title={`${sidePanel.open ? 'Hide' : 'Show'} tools (Ctrl+Alt+B)`}
    >
      Tools
    </button>
  );
}

/** A phone's ⋮ for a chat header's actions. */
export function ChatMoreButton({ label, actions }: { label: string; actions: MenuAction[] }) {
  const more = useContextMenu();
  return (
    <>
      <button type="button" className="btn-ghost chat-more-btn" aria-label="More actions" aria-haspopup="menu" aria-expanded={more.openKey === 'more'}
        onPointerDown={e => { e.currentTarget.dataset.pointer = e.pointerType; }}
        onClick={e => more.open(e, label, actions, 'more')}>
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle cx="8" cy="3.5" r="1.4" fill="currentColor" /><circle cx="8" cy="8" r="1.4" fill="currentColor" /><circle cx="8" cy="12.5" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {more.menu}
    </>
  );
}
