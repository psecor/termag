import { describe, it, expect } from 'vitest';
import { parseFireworksModels } from './fireworksGateway';
import { backendChoices, claudeTierLabel, isModelFor, modelChoicesFor } from './modelChoices';

const KIMI = 'accounts/fireworks/models/kimi-k3';
const FAST = 'accounts/fireworks/routers/kimi-k3-fast';
const FW = parseFireworksModels({ models: [{ id: KIMI, label: 'Kimi K3', context: 1048576 }, { id: FAST }] });
const GATEWAY = {
  CLAUDE_GATEWAY_URL: 'https://claude-gateway.termag.example.com',
  CLAUDE_BEDROCK_REGION: 'us-east-2',
  CLAUDE_BEDROCK_MODELS: 'opus=us.anthropic.claude-opus-5-5,sonnet=us.anthropic.claude-sonnet-5-5,haiku=us.anthropic.claude-haiku-4-5-20251001-v1:0',
};
const LABELLED = [{ id: 'opus', label: 'Opus 5.5' }, { id: 'sonnet', label: 'Sonnet 5.5' }, { id: 'haiku', label: 'Haiku 4.5' }];

describe('claudeTierLabel', () => {
  it("names a tier the way the simple UI's model picker does, from the gateway's pinned profile", () => {
    expect(claudeTierLabel('opus', 'us.anthropic.claude-opus-5-5')).toBe('Opus 5.5');
    expect(claudeTierLabel('haiku', 'us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('Haiku 4.5');
    expect(claudeTierLabel('sonnet', 'us.anthropic.claude-sonnet-6')).toBe('Sonnet 6');
    expect(claudeTierLabel('opus', undefined)).toBe('Opus');
  });
});

describe('modelChoicesFor', () => {
  it('offers Claude Code its tier aliases on its default backend, labelled from the gateway when there is one', () => {
    expect(modelChoicesFor('claude', null, null, GATEWAY)).toEqual(LABELLED);
    expect(modelChoicesFor('claude', null, null, {}).map(m => m.label)).toEqual(['Opus', 'Sonnet', 'Haiku']);
  });

  it("offers Claude Code and pi the viewer's fireworks-models list on Fireworks, and nothing with it off", () => {
    const want = [{ id: KIMI, label: 'Kimi K3', context: 1048576 }, { id: FAST, label: 'kimi-k3-fast' }];
    expect(modelChoicesFor('claude', 'fireworks', FW)).toEqual(want);
    expect(modelChoicesFor('pi', 'fireworks', FW)).toEqual(want);
    expect(modelChoicesFor('claude', 'fireworks', null)).toEqual([]);
  });

  it('offers nothing beyond the default elsewhere: pi on its catalog, Cursor', () => {
    expect(modelChoicesFor('pi', null, FW)).toEqual([]);
    expect(modelChoicesFor('cursor', 'fireworks', FW)).toEqual([]);
  });
});

describe('isModelFor', () => {
  it('takes null everywhere, and otherwise only a listed model for that harness and backend', () => {
    expect(isModelFor('cursor', null, null, null)).toBe(true);
    expect(isModelFor('claude', null, 'sonnet', null)).toBe(true);
    expect(isModelFor('claude', 'fireworks', 'sonnet', FW)).toBe(false);
    expect(isModelFor('claude', null, KIMI, FW)).toBe(false);
    expect(isModelFor('pi', 'fireworks', FAST, FW)).toBe(true);
    expect(isModelFor('pi', 'fireworks', FAST, null)).toBe(false);
  });
});

describe('backendChoices', () => {
  it("offers each harness that has a choice its default and Fireworks while the viewer's list has models", () => {
    const got = backendChoices(FW, GATEWAY);
    expect(Object.keys(got)).toEqual(['claude', 'pi', 'claude-chat']);
    expect(got.claude).toEqual([
      { id: null, label: 'Default', models: LABELLED },
      { id: 'fireworks', label: 'Fireworks', models: modelChoicesFor('claude', 'fireworks', FW) },
    ]);
    // The simple UI chat's picker: the same models as a Claude Code pane.
    expect(got['claude-chat']).toEqual(got.claude);
    expect(got.pi.map(b => [b.id, b.models.length])).toEqual([[null, 0], ['fireworks', 2]]);
  });

  it('offers no Fireworks backend while Fireworks is off for the viewer', () => {
    const claudeOnly = [{ id: null, label: 'Default', models: LABELLED }];
    expect(backendChoices(null, GATEWAY)).toEqual({ claude: claudeOnly, 'claude-chat': claudeOnly });
  });
});
