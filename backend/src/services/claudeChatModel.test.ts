import { describe, expect, it } from 'vitest';
import { chatTurnChoice, claudeLaunchModel, claudeModelArg, parseClaudeChatModel, resolvedChatTier, storedChatChoice } from './claudeChatModel';

const PINS = {
  CLAUDE_GATEWAY_URL: 'https://gateway.example/bedrock',
  CLAUDE_BEDROCK_REGION: 'us-east-2',
  CLAUDE_BEDROCK_MODELS: 'opus=us.anthropic.claude-opus-5-5,sonnet=us.anthropic.claude-sonnet-5-5,haiku=us.anthropic.claude-haiku-4-5-20251001-v1:0',
  CLAUDE_DEFAULT_MODEL: 'opus',
};

describe('parseClaudeChatModel', () => {
  it('treats an unset value as no stored tier, not Auto', () => {
    expect(parseClaudeChatModel(undefined)).toEqual({ ok: true, model: null });
    expect(parseClaudeChatModel(null)).toEqual({ ok: true, model: null });
    expect(parseClaudeChatModel('')).toEqual({ ok: true, model: null });
  });

  it('accepts the three tiers and nothing else, including the retired "auto"', () => {
    expect(parseClaudeChatModel('opus')).toEqual({ ok: true, model: 'opus' });
    expect(parseClaudeChatModel('sonnet')).toEqual({ ok: true, model: 'sonnet' });
    expect(parseClaudeChatModel('haiku')).toEqual({ ok: true, model: 'haiku' });
    expect(parseClaudeChatModel('auto').ok).toBe(false);
    expect(parseClaudeChatModel('us.anthropic.claude-opus-5-5').ok).toBe(false);
    expect(parseClaudeChatModel('claude-3').ok).toBe(false);
  });
});

describe('resolvedChatTier', () => {
  it('defaults an unset or unreadable stored value to Sonnet', () => {
    expect(resolvedChatTier(undefined)).toBe('sonnet');
    expect(resolvedChatTier(null)).toBe('sonnet');
    expect(resolvedChatTier('')).toBe('sonnet');
    expect(resolvedChatTier('auto')).toBe('sonnet');
    expect(resolvedChatTier('gpt')).toBe('sonnet');
  });

  it('otherwise keeps the stored tier', () => {
    expect(resolvedChatTier('opus')).toBe('opus');
    expect(resolvedChatTier('haiku')).toBe('haiku');
  });
});

describe('claudeLaunchModel', () => {
  it('uses the alias when the gateway is off', () => {
    expect(claudeLaunchModel('sonnet', {})).toBe('sonnet');
    expect(claudeLaunchModel('opus', {})).toBe('opus');
  });

  it('resolves a tier to the pinned profile the gateway allowlist accepts', () => {
    expect(claudeLaunchModel('opus', PINS)).toBe('us.anthropic.claude-opus-5-5');
    expect(claudeLaunchModel('sonnet', PINS)).toBe('us.anthropic.claude-sonnet-5-5');
    expect(claudeLaunchModel('haiku', PINS)).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(claudeModelArg(claudeLaunchModel('haiku', PINS))).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
  });
});

describe('claudeModelArg', () => {
  it('drops a model string that is not an alias or a US Anthropic profile', () => {
    expect(claudeModelArg('opus')).toBe('opus');
    expect(claudeModelArg('global.anthropic.claude-sonnet-5-5')).toBeNull();
    expect(claudeModelArg('opus;rm')).toBeNull();
    expect(claudeModelArg('auto')).toBeNull();
    expect(claudeModelArg(null)).toBeNull();
  });
});

const tier = (model: string | null) => ({ backend: null, model });
const KIMI = 'accounts/fireworks/models/kimi-k3';
const FW = { defaultModel: KIMI, fastModel: KIMI, models: [{ id: KIMI, label: 'Kimi K3' }, { id: 'accounts/fireworks/models/glm-5', label: 'GLM 5' }] };

describe('storedChatChoice', () => {
  it("reads the workstream's row: a tier on the default backend, any model on fireworks", () => {
    expect(storedChatChoice(null, 'sonnet')).toEqual(tier('sonnet'));
    expect(storedChatChoice(null, null)).toEqual(tier(null));
    expect(storedChatChoice('fireworks', KIMI)).toEqual({ backend: 'fireworks', model: KIMI });
  });

  it('reads an unreadable default-backend value, or the retired "auto", as no tier (Sonnet at launch)', () => {
    expect(storedChatChoice(null, 'gpt')).toEqual(tier(null));
    expect(storedChatChoice(null, 'auto')).toEqual(tier(null));
    expect(storedChatChoice('elsewhere', 'opus')).toEqual(tier('opus'));
  });
});

describe('chatTurnChoice', () => {
  it('keeps the stored choice when the message names no model or backend', () => {
    expect(chatTurnChoice(tier('sonnet'), {}, null)).toEqual({ ok: true, choice: tier('sonnet'), changed: false });
    expect(chatTurnChoice({ backend: 'fireworks', model: KIMI }, {}, null)).toEqual({ ok: true, choice: { backend: 'fireworks', model: KIMI }, changed: false });
  });

  it('switches the next turn to the tier the message carries', () => {
    expect(chatTurnChoice(tier('opus'), { model: 'haiku' }, null)).toEqual({ ok: true, choice: tier('haiku'), changed: true });
  });

  it('refuses a model that is not one of the three tiers on the default backend, including the retired "auto"', () => {
    expect(chatTurnChoice(tier('opus'), { model: 'auto' }, null).ok).toBe(false);
    expect(chatTurnChoice(tier('opus'), { model: 'us.anthropic.claude-opus-5-5' }, null).ok).toBe(false);
    expect(chatTurnChoice(tier('opus'), { model: 42 }, null).ok).toBe(false);
  });

  it('keeps the stored tier for an empty model, and comes back from Fireworks with none (Sonnet at launch)', () => {
    expect(chatTurnChoice(tier('opus'), { model: '' }, null)).toEqual({ ok: true, choice: tier('opus'), changed: false });
    expect(chatTurnChoice(tier(null), { model: '' }, null)).toEqual({ ok: true, choice: tier(null), changed: false });
    expect(chatTurnChoice({ backend: 'fireworks', model: KIMI }, { backend: '' }, null)).toEqual({ ok: true, choice: tier(null), changed: true });
  });

  it('reports no change when the message repeats the stored tier', () => {
    expect(chatTurnChoice(tier('sonnet'), { model: 'sonnet' }, null)).toEqual({ ok: true, choice: tier('sonnet'), changed: false });
  });
  it("moves onto Fireworks with one of the sender's models, and back to a tier", () => {
    expect(chatTurnChoice(tier('opus'), { backend: 'fireworks', model: KIMI }, FW)).toEqual({ ok: true, choice: { backend: 'fireworks', model: KIMI }, changed: true });
    expect(chatTurnChoice(tier(null), { backend: 'fireworks', model: 'auto' }, FW)).toEqual({ ok: true, choice: { backend: 'fireworks', model: null }, changed: true });
    expect(chatTurnChoice({ backend: 'fireworks', model: KIMI }, { model: 'sonnet' }, null)).toEqual({ ok: true, choice: tier('sonnet'), changed: true });
  });

  it('refuses Fireworks while it is off for the sender, a model not on their list, and another backend', () => {
    expect(chatTurnChoice(tier(null), { backend: 'fireworks', model: KIMI }, null)).toEqual({ ok: false, error: 'Fireworks models are not on for you' });
    expect(chatTurnChoice(tier(null), { backend: 'fireworks', model: 'accounts/fireworks/models/other' }, FW).ok).toBe(false);
    expect(chatTurnChoice(tier(null), { backend: 'bedrock', model: 'opus' }, FW).ok).toBe(false);
  });
});
