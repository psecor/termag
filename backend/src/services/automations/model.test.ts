import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ prisma: {} }));

import { modelView, namesModelChoice, parseModelChoice } from './model';

const fireworks = {
  models: [{ id: 'accounts/fireworks/models/kimi-k3', label: 'Kimi K3' }],
  defaultModel: 'accounts/fireworks/models/kimi-k3',
  fastModel: 'accounts/fireworks/models/kimi-k3',
};

describe('namesModelChoice', () => {
  it('is a model change only when the body names backend or model', () => {
    expect(namesModelChoice({ prompt: 'x' })).toBe(false);
    expect(namesModelChoice({ model: 'opus' })).toBe(true);
    expect(namesModelChoice({ backend: null })).toBe(true);
  });
});

describe('parseModelChoice', () => {
  it('takes a Claude tier on the default backend, and null as Sonnet', () => {
    expect(parseModelChoice({ model: 'opus' }, 'claude-chat', null)).toEqual({ ok: true, choice: { backend: null, model: 'opus' } });
    expect(parseModelChoice({ backend: null, model: 'haiku' }, 'claude-chat', null)).toEqual({ ok: true, choice: { backend: null, model: 'haiku' } });
    expect(parseModelChoice({ backend: '', model: null }, 'claude-chat', null)).toEqual({ ok: true, choice: { backend: null, model: null } });
  });

  it('refuses a model that is not a tier on the default backend', () => {
    expect(parseModelChoice({ model: 'gpt-9' }, 'claude-chat', null)).toEqual({ ok: false, error: 'that model is not offered for that agent and backend' });
    expect(parseModelChoice({ model: 'accounts/fireworks/models/kimi-k3' }, 'claude-chat', fireworks).ok).toBe(false);
    expect(parseModelChoice({ model: 42 }, 'claude-chat', null).ok).toBe(false);
  });

  it('takes one of the owner\'s Fireworks models, or the flag default with none named', () => {
    expect(parseModelChoice({ backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k3' }, 'claude-chat', fireworks))
      .toEqual({ ok: true, choice: { backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k3' } });
    expect(parseModelChoice({ backend: 'fireworks' }, 'claude-chat', fireworks)).toEqual({ ok: true, choice: { backend: 'fireworks', model: null } });
  });

  it('refuses Fireworks while it is off for the owner, a model off their list, and a backend the agent cannot run on', () => {
    expect(parseModelChoice({ backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k3' }, 'claude-chat', null))
      .toEqual({ ok: false, error: 'Fireworks models are not on for you' });
    expect(parseModelChoice({ backend: 'fireworks', model: 'accounts/fireworks/models/glm-5p3' }, 'claude-chat', fireworks).ok).toBe(false);
    expect(parseModelChoice({ backend: 'fireworks', model: 'opus' }, 'claude-chat', fireworks).ok).toBe(false);
    expect(parseModelChoice({ backend: 'bedrock' }, 'claude-chat', fireworks)).toEqual({ ok: false, error: 'that agent cannot run on that model backend' });
  });
});

describe('modelView', () => {
  it('reads main\'s row as the chat does: a non-tier on the default backend is no choice', () => {
    expect(modelView(null)).toEqual({ chatProvider: null, backend: null, model: null });
    expect(modelView({ id: 'wf', provider: 'claude-chat', backend: null, model: 'opus' })).toEqual({ chatProvider: 'claude-chat', backend: null, model: 'opus' });
    expect(modelView({ id: 'wf', provider: 'claude-chat', backend: null, model: 'nonsense' })).toEqual({ chatProvider: 'claude-chat', backend: null, model: null });
    expect(modelView({ id: 'wf', provider: 'claude-chat', backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k3' }))
      .toEqual({ chatProvider: 'claude-chat', backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k3' });
  });
});
