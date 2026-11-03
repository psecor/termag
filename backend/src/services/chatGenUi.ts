/**
 * Generative UI's agent side (The
 * agent's prompt): a simple-UI chat turn is told how to draw UI in a reply
 * (a ```spec fence over the catalog) and what an answer from it looks like,
 * by a system prompt the runner appends (agent/chat-runner.js turnArgs).
 *
 * The prompt is generated from the browser's own catalog
 * (frontend/src/chat/genui/prompt.ts) into chatGenUiPrompt.generated.ts, so
 * it ships with the frontend that draws it, and is sent with each send rather
 * than kept on the box: a box on an older agent never describes a catalog the
 * browser has moved on from.
 *
 * It goes only with the sender's chat-generative-ui-enabled, to a runner
 * advertising chat-genui-v1, for a chat on Claude's own models (not an ask's,
 * not another backend's). Anything else sends no prompt; the message still goes.
 *
 * With the sender's chat-generative-ui-hint-enabled, a runner that also
 * advertises chat-genui-v2 gets the hint as well (CHAT_GEN_UI_HINT, a few
 * hundred tokens): its turns carry only the hint, and the whole prompt is a
 * file the agent reads before its first UI. Off, or an older runner, every
 * turn appends the whole prompt, as before.
 */
import { CHAT_GEN_UI_HINT, CHAT_GEN_UI_PROMPT } from './chatGenUiPrompt.generated';

export const CHAT_GENUI_FLAG = 'chat-generative-ui-enabled';
export const CHAT_GENUI_HINT_FLAG = 'chat-generative-ui-hint-enabled';
export const CHAT_GENUI_CAPABILITY = 'chat-genui-v1';
/** The runner puts the prompt in a file and gives each turn only the hint (agent/chat-runner.js). */
export const CHAT_GENUI_REFERENCE_CAPABILITY = 'chat-genui-v2';
export { CHAT_GEN_UI_HINT, CHAT_GEN_UI_PROMPT };

export interface ChatGenUiContext {
  flagOn: boolean;
  capabilities: readonly string[];
  /** An ask's turn runs with nobody watching it (agent/ask-chat.js): no UI to answer. */
  ask: boolean;
  /** The chat's model backend; only Claude's own models are told about generative UI. */
  backend: string | null;
}

/** Whether this send's turn gets the generative UI prompt. */
export function chatGenUiForSend(c: ChatGenUiContext): boolean {
  return c.flagOn && !c.ask && !c.backend && c.capabilities.includes(CHAT_GENUI_CAPABILITY);
}

/**
 * What a send carries for generative UI, given the runner's capabilities and
 * whether the sender has chat-generative-ui-hint-enabled: nothing, the whole
 * prompt, or the prompt (to file) and the hint (to append).
 */
export function genUiFields(capabilities: readonly string[], hint: boolean): { genUiPrompt?: string; genUiHint?: string } {
  if (!capabilities.includes(CHAT_GENUI_CAPABILITY)) return {};
  return hint && capabilities.includes(CHAT_GENUI_REFERENCE_CAPABILITY)
    ? { genUiPrompt: CHAT_GEN_UI_PROMPT, genUiHint: CHAT_GEN_UI_HINT }
    : { genUiPrompt: CHAT_GEN_UI_PROMPT };
}
