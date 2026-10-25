import { describe, it, expect } from 'vitest';
import { fireworksContext, fireworksDelivery, getFireworksGatewayConfig, parseFireworksModels } from './fireworksGateway';

const KIMI = 'accounts/fireworks/models/kimi-k3';
const FAST = 'accounts/fireworks/routers/kimi-k3-fast';
const DS = 'accounts/fireworks/models/deepseek-v4p1-flash';

describe('getFireworksGatewayConfig and fireworksDelivery', () => {
  it('needs an https base, and a box gets only that: no model list', () => {
    const cfg = getFireworksGatewayConfig({ FIREWORKS_GATEWAY_URL: 'https://claude-gateway.termag.example.com/fireworks/' });
    expect(cfg).toEqual({ baseUrl: 'https://claude-gateway.termag.example.com/fireworks' });
    expect(fireworksDelivery(cfg!)).toEqual({ baseUrl: 'https://claude-gateway.termag.example.com/fireworks' });
    expect(getFireworksGatewayConfig({ FIREWORKS_GATEWAY_URL: 'http://x/fireworks' })).toBeNull();
    expect(getFireworksGatewayConfig({})).toBeNull();
  });
});

describe('parseFireworksModels (the fireworks-models flag)', () => {
  it('reads models, routers included, with labels and context windows, and the default and fast picks', () => {
    expect(parseFireworksModels({
      default: KIMI, fast: DS,
      models: [{ id: KIMI, label: 'Kimi K3', context: 1048576 }, { id: FAST }, { id: DS, context: 512000 }],
    })).toEqual({
      models: [
        { id: KIMI, label: 'Kimi K3', context: 1048576 },
        { id: FAST, label: 'kimi-k3-fast', context: null },
        { id: DS, label: 'deepseek-v4p1-flash', context: 512000 },
      ],
      defaultModel: KIMI, fastModel: DS,
    });
  });

  it('drops what it cannot use, and fills default and fast from the list', () => {
    const got = parseFireworksModels({
      default: 'accounts/fireworks/models/glm-9', fast: 7,
      models: [{ id: 'gpt-5' }, { id: KIMI, context: 'big' }, { id: KIMI }, { id: DS, context: 12.5 }, null, 'x'],
    });
    expect(got).toEqual({
      models: [{ id: KIMI, label: 'kimi-k3', context: null }, { id: DS, label: 'deepseek-v4p1-flash', context: null }],
      defaultModel: KIMI, fastModel: KIMI,
    });
  });

  it('is null, so nothing is allowed, for the flag off (its fallback) or a value with no usable model', () => {
    for (const v of [null, undefined, 'x', {}, { models: [] }, { models: [{ id: 'gpt-5' }] }]) expect(parseFireworksModels(v)).toBeNull();
  });

  it('looks a context window up by id', () => {
    const fw = parseFireworksModels({ models: [{ id: KIMI, context: 1048576 }, { id: DS }] })!;
    expect([fireworksContext(fw, KIMI), fireworksContext(fw, DS), fireworksContext(fw, FAST)]).toEqual([1048576, null, null]);
  });
});
