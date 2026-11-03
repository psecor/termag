// What an SDK chat's history answer draws above and in its composer: the
// trust note, the model and effort in the picker, the attach button. Each
// arrives with GET …/chat, so drawn from the answer alone they pop in when
// it lands and push the composer. Kept per chat for this page load, a switch
// back draws them at once and the answer only corrects them; a chat opened
// the first time reserves their space while it loads instead.
import type { ChatTrust } from '../services/api';
import { chatModelFromWire, type ChatModelId } from './composer';

export interface ComposerChrome {
  trust: ChatTrust | null;
  canTrust: boolean;
  imageInput: boolean;
  /** The attach button takes PDFs too (an agent with chat-pdfs-v1). */
  pdfInput: boolean;
  effortInput: boolean;
  /** The model the history said the chat runs on. */
  model: ChatModelId | null;
}

export const noChrome: ComposerChrome = { trust: null, canTrust: false, imageInput: false, pdfInput: false, effortInput: false, model: null };

const byChat = new Map<string, ComposerChrome>();

/** The composer's part of a history answer (`model` as useChatModel reads it: absent is Sonnet). */
export function chromeFromHistory(h: { trust?: ChatTrust | null; canTrust?: boolean; imageInput?: boolean; pdfInput?: boolean; effortInput?: boolean; model?: unknown; backend?: unknown }): ComposerChrome {
  return {
    trust: h.trust ?? null,
    canTrust: Boolean(h.canTrust),
    imageInput: h.imageInput === true,
    pdfInput: h.imageInput === true && h.pdfInput === true,
    effortInput: h.effortInput === true,
    model: chatModelFromWire(h.model, h.backend) ?? 'sonnet',
  };
}

export function rememberChrome(chatId: string, chrome: ComposerChrome): void {
  byChat.set(chatId, chrome);
}

/** Updates what is kept for a chat already kept (say, trusted from this view). */
export function updateRememberedChrome(chatId: string, patch: Partial<ComposerChrome>): void {
  const prev = byChat.get(chatId);
  if (prev) byChat.set(chatId, { ...prev, ...patch });
}

export function rememberedChrome(chatId: string): ComposerChrome | null {
  return byChat.get(chatId) ?? null;
}

/** For tests: forget every chat. */
export function forgetChrome(): void {
  byChat.clear();
}

/**
 * What the composer draws before and after a history answer: the answer's
 * once there is one, else what this page kept for the chat. `reserve` is a
 * first open's load (nothing kept): the trust note's line and the attach
 * button hold their space, empty, so the answer fills them in place.
 */
export function composerChrome(i: { live: ComposerChrome | null; remembered: ComposerChrome | null; loading: boolean }): { chrome: ComposerChrome; reserve: boolean } {
  const chrome = i.live ?? i.remembered ?? noChrome;
  return { chrome, reserve: i.loading && !i.live && !i.remembered };
}
