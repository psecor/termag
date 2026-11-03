import { describe, expect, it } from 'vitest';
import { CHAT_GEN_UI_HINT, CHAT_GEN_UI_PROMPT, CHAT_GENUI_CAPABILITY, CHAT_GENUI_REFERENCE_CAPABILITY, chatGenUiForSend } from './chatGenUi';
import { chatSendRpcPayload } from './chatRunner';

const capable = { flagOn: true, capabilities: [CHAT_GENUI_CAPABILITY], ask: false, backend: null };

describe('chatGenUiForSend', () => {
  it('needs the sender\'s flag, a runner with chat-genui-v1, and a chat on Claude\'s own models, not an ask\'s', () => {
    expect(chatGenUiForSend(capable)).toBe(true);
    expect(chatGenUiForSend({ ...capable, flagOn: false })).toBe(false);
    expect(chatGenUiForSend({ ...capable, capabilities: ['chat-runner-v1'] })).toBe(false);
    expect(chatGenUiForSend({ ...capable, ask: true })).toBe(false);
    expect(chatGenUiForSend({ ...capable, backend: 'fireworks' })).toBe(false);
  });
});

describe('the generative UI prompt on a send', () => {
  const target = {
    chatKey: 'k', cwd: '/home/u/p', projectId: 'p', workstream: 'main', workstreamId: 'w',
    requireCheckout: false, permissionMode: 'bypassPermissions',
  };

  it('is the generated catalog prompt, carried only when asked for and the runner can take it', () => {
    expect(CHAT_GEN_UI_PROMPT).toContain('GENERATIVE UI (termag):');
    expect(CHAT_GEN_UI_PROMPT).toContain('```ui-action');
    expect(chatSendRpcPayload(target, 'hi', [CHAT_GENUI_CAPABILITY], { genUi: true }).genUiPrompt).toBe(CHAT_GEN_UI_PROMPT);
    expect(chatSendRpcPayload(target, 'hi', [], { genUi: true })).not.toHaveProperty('genUiPrompt');
    expect(chatSendRpcPayload(target, 'hi', [CHAT_GENUI_CAPABILITY], {})).not.toHaveProperty('genUiPrompt');
  });

  it('comes with the hint for a runner that files the prompt (chat-genui-v2) when the sender has the hint flag, and alone otherwise', () => {
    expect(CHAT_GEN_UI_HINT.startsWith('GENERATIVE UI (termag):\n')).toBe(true);
    expect(CHAT_GEN_UI_HINT).toContain('{{GEN_UI_REFERENCE}}');
    expect(CHAT_GEN_UI_HINT.length * 5).toBeLessThan(CHAT_GEN_UI_PROMPT.length);
    const both = [CHAT_GENUI_CAPABILITY, CHAT_GENUI_REFERENCE_CAPABILITY];
    expect(chatSendRpcPayload(target, 'hi', both, { genUi: true, genUiHint: true })).toMatchObject({ genUiPrompt: CHAT_GEN_UI_PROMPT, genUiHint: CHAT_GEN_UI_HINT });
    // The sender's chat-generative-ui-hint-enabled off: the whole prompt, as before.
    const off = chatSendRpcPayload(target, 'hi', both, { genUi: true });
    expect(off.genUiPrompt).toBe(CHAT_GEN_UI_PROMPT);
    expect(off).not.toHaveProperty('genUiHint');
    expect(chatSendRpcPayload(target, 'hi', [CHAT_GENUI_CAPABILITY], { genUi: true, genUiHint: true })).not.toHaveProperty('genUiHint');
    // v2 alone is no runner of generative UI at all: v1 says it reads the prompt.
    expect(chatSendRpcPayload(target, 'hi', [CHAT_GENUI_REFERENCE_CAPABILITY], { genUi: true, genUiHint: true })).not.toHaveProperty('genUiPrompt');
    expect(chatSendRpcPayload(target, 'hi', both, { genUiHint: true })).not.toHaveProperty('genUiHint');
  });
});
