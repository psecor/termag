import { describe, expect, it } from 'vitest';
import { chatModelOptions } from '../chat/composer';
import { automationModelBody, automationModelId, automationModelOptions } from './automationModel';

const KIMI = 'accounts/fireworks/models/kimi-k3';

describe('automationModelId', () => {
  it('reads the view as the pickers do: no model on Claude is Sonnet, as a run with none starts', () => {
    expect(automationModelId({})).toBe('sonnet');
    expect(automationModelId({ backend: null, model: null })).toBe('sonnet');
    expect(automationModelId({ backend: null, model: 'opus' })).toBe('opus');
    expect(automationModelId({ backend: 'fireworks', model: KIMI })).toBe(`fireworks:${KIMI}`);
    expect(automationModelId({ backend: 'fireworks', model: null })).toBe('fireworks:');
  });
});

describe('automationModelOptions', () => {
  const options = chatModelOptions([{ id: KIMI, label: 'Kimi K3' }]);
  it('is the pickers\' options when the current choice is one of them', () => {
    expect(automationModelOptions('opus', options)).toBe(options);
  });
  it('keeps a choice the owner is no longer offered, so it still shows', () => {
    expect(automationModelOptions('fireworks:accounts/fireworks/models/glm-5p3', options).at(-1)).toEqual({ id: 'fireworks:accounts/fireworks/models/glm-5p3', label: 'glm-5p3', fireworks: true });
    expect(automationModelOptions('fireworks:', options).at(-1)).toEqual({ id: 'fireworks:', label: 'Fireworks default', fireworks: true });
  });
});

describe('automationModelBody', () => {
  it('names both keys, so a tier moves an automation off Fireworks', () => {
    expect(automationModelBody('haiku')).toEqual({ backend: null, model: 'haiku' });
    expect(automationModelBody(`fireworks:${KIMI}`)).toEqual({ backend: 'fireworks', model: KIMI });
  });
});
