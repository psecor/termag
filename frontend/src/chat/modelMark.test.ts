// Which maker's mark a session's card wears (chat/modelMark.ts): the model, not the harness.
import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { modelMarkFor } from './modelMark';

const project = (...workflows: Array<Record<string, unknown>>) => ({ workflows: workflows.map(w => ({ type: 'agent', ...w })) }) as unknown as Pick<Project, 'workflows'>;

describe('modelMarkFor', () => {
  it("reads a Fireworks model's maker from its name", () => {
    const p = project({ workstreamId: 'w1', provider: 'claude-chat', backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k3' });
    expect(modelMarkFor(p, 'w1', 'claude-chat')).toEqual({ maker: 'kimi', label: 'Kimi' });
    expect(modelMarkFor(project({ backend: 'fireworks', model: 'accounts/fireworks/models/glm-5' }), null, null)).toEqual({ maker: 'glm', label: 'GLM' });
    expect(modelMarkFor(project({ backend: 'fireworks', model: 'accounts/fireworks/models/deepseek-v4' }), null, null).maker).toBe('deepseek');
    expect(modelMarkFor(project({ backend: 'fireworks', model: 'accounts/fireworks/models/qwen3-coder' }), null, null).maker).toBe('qwen');
    expect(modelMarkFor(project({ backend: 'fireworks', model: 'accounts/fireworks/models/llama-v4' }), null, null).maker).toBe('llama');
  });

  it("falls back to Fireworks for a model it doesn't know", () => {
    expect(modelMarkFor(project({ backend: 'fireworks', model: 'accounts/fireworks/models/something-new' }), null, null))
      .toEqual({ maker: 'fireworks', label: 'Fireworks' });
  });

  it("is the harness's own maker otherwise, Claude included", () => {
    expect(modelMarkFor(project({ provider: 'claude-chat' }), null, 'claude-chat')).toEqual({ maker: 'claude', label: 'Claude' });
    expect(modelMarkFor(project({ provider: 'codex' }), null, 'codex')).toEqual({ maker: 'codex', label: 'Codex' });
    expect(modelMarkFor(project(), null, 'cursor-chat')).toEqual({ maker: 'cursor', label: 'Cursor' });
    expect(modelMarkFor(project(), null, 'devin-chat')).toEqual({ maker: 'devin', label: 'Devin' });
    expect(modelMarkFor(project(), null, 'devin').maker).toBe('devin');
    expect(modelMarkFor(undefined, null, 'mystery')).toEqual({ maker: 'other', label: 'mystery' });
    expect(modelMarkFor(undefined, null, null)).toEqual({ maker: 'other', label: 'Agent' });
  });

  it("uses the session's own workflow before the checkout's first", () => {
    const p = project(
      { workstreamId: 'main', provider: 'claude-chat' },
      { workstreamId: 'w2', provider: 'claude-chat', backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k3' },
    );
    expect(modelMarkFor(p, 'w2', 'claude-chat').maker).toBe('kimi');
    expect(modelMarkFor(p, 'main', 'claude-chat').maker).toBe('claude');
    expect(modelMarkFor(p, 'unknown', 'claude-chat').maker).toBe('claude');
  });
});
