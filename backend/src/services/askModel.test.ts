import { describe, expect, it } from 'vitest';
import { askChoiceOf, askFireworksRefusal, askModelOf, isFireworksAskModel, parseAskModel, resolveFireworksAskModel } from './askModel';

const KIMI = 'accounts/fireworks/models/kimi-k3';
const GLM = 'accounts/fireworks/models/glm-5p3';
const LISTED = { models: [{ id: KIMI, label: 'Kimi K3', context: 262144 }, { id: GLM, label: 'GLM 5.3', context: null }], defaultModel: GLM, fastModel: KIMI };
const ALL_CAPS = ['ask-chat-v1', 'ask-backend-v1', 'chat-backend-v1', 'fireworks-v1'];

describe('parseAskModel', () => {
  it('takes a tier, fireworks or fireworks:<id>, and nothing else', () => {
    expect(parseAskModel(undefined)).toEqual({ ok: true, model: null });
    expect(parseAskModel('opus')).toEqual({ ok: true, model: 'opus' });
    expect(parseAskModel('fireworks')).toEqual({ ok: true, model: 'fireworks' });
    expect(parseAskModel('fireworks:kimi-k3')).toEqual({ ok: true, model: 'fireworks:kimi-k3' });
    expect(parseAskModel(`fireworks:${KIMI}`)).toEqual({ ok: true, model: `fireworks:${KIMI}` });
    for (const bad of ['fireworks:', 'fireworks:a b', 'fireworks:$(x)', 'openai:gpt-5', 'Opus', 7]) expect(parseAskModel(bad).ok).toBe(false);
  });
});

describe('askChoiceOf / askModelOf', () => {
  it('round-trips a tier and a Fireworks model through a chat\'s stored choice', () => {
    expect(askChoiceOf('haiku')).toEqual({ backend: null, model: 'haiku' });
    expect(askChoiceOf(`fireworks:${KIMI}`)).toEqual({ backend: 'fireworks', model: KIMI });
    expect(askChoiceOf(null)).toBeNull();
    expect(askModelOf({ backend: 'fireworks', model: KIMI })).toBe(`fireworks:${KIMI}`);
    expect(askModelOf({ backend: 'fireworks', model: null })).toBe('fireworks');
    expect(askModelOf({ backend: null, model: 'sonnet' })).toBe('sonnet');
    expect(askModelOf({ backend: null, model: null })).toBeNull();
    expect(isFireworksAskModel(`fireworks:${KIMI}`)).toBe(true);
    expect(isFireworksAskModel('opus')).toBe(false);
  });
});

describe('resolveFireworksAskModel', () => {
  it('resolves the full id, its last segment, or the default; refuses anything off the list', () => {
    expect(resolveFireworksAskModel('fireworks:kimi-k3', LISTED, 'devbox')).toEqual({ ok: true, model: `fireworks:${KIMI}`, id: KIMI });
    expect(resolveFireworksAskModel(`fireworks:${GLM}`, LISTED, 'devbox')).toEqual({ ok: true, model: `fireworks:${GLM}`, id: GLM });
    expect(resolveFireworksAskModel('fireworks', LISTED, 'devbox')).toEqual({ ok: true, model: `fireworks:${GLM}`, id: GLM });
    expect(resolveFireworksAskModel('fireworks:minimax-m3', LISTED, 'devbox')).toEqual({ ok: false, error: 'minimax-m3 is not one of your Fireworks models on devbox: fireworks:kimi-k3, fireworks:glm-5p3' });
    expect(resolveFireworksAskModel('fireworks:kimi-k3', null, 'devbox')).toMatchObject({ ok: false, error: expect.stringContaining('fireworks-models lists no Fireworks models for you on devbox') });
  });
  it('matches a full id exactly: another account\'s model with the same last segment is not it', () => {
    const replacement = 'accounts/beta/models/kimi-k3';
    const replaced = { models: [{ id: replacement, label: 'Kimi K3', context: 262144 }], defaultModel: replacement, fastModel: replacement };
    // A short name still resolves to whatever ends that way; a full id the thread stored must be listed as itself.
    expect(resolveFireworksAskModel('fireworks:kimi-k3', replaced, 'devbox')).toEqual({ ok: true, model: `fireworks:${replacement}`, id: replacement });
    expect(resolveFireworksAskModel(`fireworks:${KIMI}`, replaced, 'devbox')).toEqual({ ok: false, error: `${KIMI} is not one of your Fireworks models on devbox: fireworks:kimi-k3` });
  });
});

describe('askFireworksRefusal', () => {
  const facts = { box: 'devbox', modelChoiceOn: true, fireworksOn: true, gatewayConfigured: true, caps: ALL_CAPS };
  it('is null when everything the orchestrator can see allows it, and while the box is not connected', () => {
    expect(askFireworksRefusal(facts)).toBeNull();
    expect(askFireworksRefusal({ ...facts, caps: null })).toBeNull();
  });
  it('names each reason, flags first, then the gateway, then the box\'s missing capabilities', () => {
    expect(askFireworksRefusal({ ...facts, modelChoiceOn: false })).toContain('ask-model-choice-enabled');
    expect(askFireworksRefusal({ ...facts, fireworksOn: false })).toContain('ask-fireworks-enabled');
    expect(askFireworksRefusal({ ...facts, gatewayConfigured: false })).toContain('no Fireworks gateway');
    expect(askFireworksRefusal({ ...facts, caps: ['ask-chat-v1'] })).toContain('it lacks ask-backend-v1, chat-backend-v1, fireworks-v1');
  });
});
