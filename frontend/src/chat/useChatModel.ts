// The model an open chat's composer shows: what the chat runs on now (its
// history's `model`), or a pick that has not been sent yet. A pick rides on
// the next message (backend routes/chat.ts), which makes it the chat's model
// from that turn on; until then it is kept in this browser, so a reload
// still shows it.
//
// Until history reports, the control is not ready: the display is a
// placeholder, not a guess at the tier (a Sonnet/Opus/Haiku session must not
// look like it is running on a different one), and a choice is not stored.
// A message sent in that window omits `model`, so the backend keeps the
// project's tier.
import { useCallback, useEffect, useState } from 'react';
import { chatModelFromWire, isChatModel, type ChatModelId } from './composer';

const key = (chatId: string) => `termag.chatModel.${chatId}`;

export function readModelPick(chatId: string): ChatModelId | null {
  try {
    const v = localStorage.getItem(key(chatId));
    return v && isChatModel(v) ? v : null;
  } catch { return null; }
}

function writeModelPick(chatId: string, id: ChatModelId | null) {
  try {
    if (id) localStorage.setItem(key(chatId), id);
    else localStorage.removeItem(key(chatId));
  } catch { /* the pick still holds for this page */ }
}

/**
 * What the composer shows for the model control. A pending pick wins; else
 * the known tier; else null (history has not reported yet).
 */
export function chatModelView(pick: ChatModelId | null, current: ChatModelId | null): ChatModelId | null {
  return pick ?? current;
}

/**
 * Whether the control may store a choice. Until history has reported, a
 * click must not create a pick (the wrong tier would look selected and
 * switch the session on the next send).
 */
export function chatModelCanChoose(known: boolean): boolean {
  return known;
}

export function useChatModel(chatId: string) {
  const [current, setCurrent] = useState<ChatModelId | null>(null);
  const [known, setKnown] = useState(false);
  const [pick, setPick] = useState<ChatModelId | null>(() => readModelPick(chatId));
  useEffect(() => {
    setCurrent(null);
    setKnown(false);
    setPick(readModelPick(chatId));
  }, [chatId]);

  const choose = useCallback((id: ChatModelId) => {
    if (!chatModelCanChoose(known) || current == null) return;
    const next = id === current ? null : id;
    setPick(next);
    writeModelPick(chatId, next);
  }, [chatId, current, known]);

  /** The history said what the chat runs on (its `model` and `backend`). Absent model → Sonnet. */
  const reported = useCallback((wire: unknown, backend?: unknown) => {
    setCurrent(chatModelFromWire(wire, backend) ?? 'sonnet');
    setKnown(true);
  }, []);

  /** A message carrying `id` went in: it is the chat's model now. */
  const sent = useCallback((id: ChatModelId) => {
    setCurrent(id);
    setKnown(true);
    setPick(p => (p === id ? null : p));
    if (readModelPick(chatId) === id) writeModelPick(chatId, null);
  }, [chatId]);

  return {
    model: chatModelView(pick, current),
    pick,
    /** History has reported; the control may change the model. */
    ready: known,
    choose,
    reported,
    sent,
  };
}
