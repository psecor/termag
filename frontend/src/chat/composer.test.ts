import { describe, expect, it } from 'vitest';
import {
  CHAT_MODELS, chatAgentName, chatModelFromWire, chatModelLabel, chatModelOptions, chatModelWire, chatModelTakesPdfs, claudeModelForCreate, isChatModel, modelFamily, newChatCreateFields, repoListView, repoTriggerLabel, REPO_EMPTY, REPO_LOAD_ERROR, REPO_LOAD_ERROR_NO_PASTE,
} from './composer';
import { catalogFromWire, degradedCatalog, type RepoPick } from '../utils/repoPick';

const listed: RepoPick = { kind: 'listed', fullName: 'acme/web', defaultBranch: 'main' };

describe('new chat model and repository', () => {
  it('offers the three Claude tiers termag accepts, and no Auto', () => {
    expect(CHAT_MODELS.map(m => m.id)).toEqual(['opus', 'sonnet', 'haiku']);
    expect(CHAT_MODELS.map(m => m.label)).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5']);
    expect(claudeModelForCreate('sonnet')).toBe('sonnet');
    expect(claudeModelForCreate('opus')).toBe('opus');
  });

  it('builds a start from a listed repository and the chosen model', () => {
    expect(newChatCreateFields(listed, 'haiku')).toEqual({
      repoUrl: 'https://github.com/acme/web.git',
      defaultBranch: 'main',
      claudeModel: 'haiku',
    });
    expect(newChatCreateFields(listed, 'sonnet')).toMatchObject({ claudeModel: 'sonnet' });
    expect(repoTriggerLabel(listed)).toBe('acme/web');
  });

  it('accepts a pasted GitHub URL and refuses anything that is not a repository', () => {
    const pasted: RepoPick = { kind: 'pasted', url: 'https://github.com/acme/other' };
    expect(newChatCreateFields(pasted, 'opus')).toEqual({
      repoUrl: 'https://github.com/acme/other',
      defaultBranch: null,
      claudeModel: 'opus',
    });
    expect(repoTriggerLabel(pasted)).toBe('acme/other');
    expect(newChatCreateFields({ kind: 'pasted', url: 'not a url' }, 'opus')).toBeNull();
    expect(newChatCreateFields({ kind: 'empty' }, 'opus')).toBeNull();
    expect(newChatCreateFields({ kind: 'starter', templateId: 'x', url: 'https://github.com/acme/web' }, 'opus')).toBeNull();
  });
});

describe('repository list states', () => {
  const row = { fullName: 'acme/web', defaultBranch: 'main' };
  const group = { owner: 'acme', kind: 'user', status: 'ok', repos: [row] };

  it('is loading until a catalog arrives, then ready', () => {
    expect(repoListView(null)).toEqual({ kind: 'loading' });
    expect(repoListView(catalogFromWire({ status: 'ok', groups: [group] }))).toEqual({ kind: 'ready' });
  });

  it('says when the list failed or the account has no repositories', () => {
    expect(repoListView(degradedCatalog())).toEqual({ kind: 'error', text: REPO_LOAD_ERROR });
    expect(repoListView(catalogFromWire({ status: 'ok', groups: [] }))).toEqual({ kind: 'empty' });
    expect(REPO_EMPTY).toMatch(/Paste a URL/);
    const reconnect = catalogFromWire({ status: 'reconnect', reconnect: { sentence: 'Reconnect GitHub in Settings' } });
    expect(repoListView(reconnect)).toEqual({ kind: 'error', text: 'Reconnect GitHub in Settings' });
  });

  it('offers no paste where there is no paste field', () => {
    expect(repoListView(degradedCatalog(), false)).toEqual({ kind: 'error', text: REPO_LOAD_ERROR_NO_PASTE });
    expect(REPO_LOAD_ERROR_NO_PASTE).not.toMatch(/Paste/);
    const reconnect = catalogFromWire({ status: 'reconnect', reconnect: { sentence: 'Reconnect GitHub in Settings' } });
    expect(repoListView(reconnect, false)).toEqual({ kind: 'error', text: 'Reconnect GitHub in Settings' });
  });
});

describe('Fireworks models in the chat picker', () => {
  const KIMI = 'accounts/fireworks/models/kimi-k3';
  const id = `fireworks:${KIMI}`;

  it('sends a Fireworks pick as its model and backend, and a tier as itself', () => {
    expect(chatModelWire(id)).toEqual({ model: KIMI, backend: 'fireworks' });
    expect(chatModelTakesPdfs(id)).toBe(false);
    expect(chatModelTakesPdfs('sonnet')).toBe(true);
    expect(chatModelTakesPdfs(null)).toBe(true);
    expect(chatModelWire('sonnet')).toEqual({ model: 'sonnet' });
  });

  it("reads a history's model and backend, and nothing it cannot show", () => {
    expect(chatModelFromWire(KIMI, 'fireworks')).toBe(id);
    expect(chatModelFromWire('haiku')).toBe('haiku');
    // A Fireworks chat whose model is unknown is still on Fireworks, not on a Claude tier.
    expect(chatModelFromWire('haiku', 'fireworks')).toBe('fireworks:');
    expect(chatModelFromWire(null, 'fireworks')).toBe('fireworks:');
    expect(chatModelLabel('fireworks:')).toBe('Fireworks');
    expect(chatModelOptions([{ id: KIMI, label: 'Kimi K3' }]).some(o => o.id === 'fireworks:')).toBe(false);
    expect(isChatModel('fireworks:')).toBe(false);
    expect(chatModelFromWire(KIMI)).toBeNull();
    expect(isChatModel(id)).toBe(true);
    expect(isChatModel('fireworks:opus;rm')).toBe(false);
  });

  it("lists Claude's tiers, then the viewer's Fireworks models by their labels", () => {
    const options = chatModelOptions([{ id: KIMI, label: 'Kimi K3' }]);
    expect(options.map(o => o.label)).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5', 'Kimi K3']);
    expect(options[options.length - 1]).toEqual({ id, label: 'Kimi K3', fireworks: true });
    expect(chatModelLabel(id, options)).toBe('Kimi K3');
    expect(chatModelLabel(id)).toBe('kimi-k3');
  });

  it("keeps the viewer's Fireworks models in the flag's order", () => {
    const glmFlash = 'accounts/fireworks/models/glm-5p3-flash';
    const options = chatModelOptions([{ id: glmFlash, label: 'GLM 5.3 Flash' }, { id: KIMI, label: 'Kimi K3' }]);
    expect(options.filter(o => o.fireworks).map(o => o.label)).toEqual(['GLM 5.3 Flash', 'Kimi K3']);
  });

  it('addresses the composer to the chosen model: Claude on a tier, the Fireworks model by name without its version', () => {
    const options = chatModelOptions([{ id: KIMI, label: 'Kimi K3' }]);
    expect(chatAgentName('opus', options)).toBe('Claude');
    expect(chatAgentName('haiku')).toBe('Claude');
    expect(chatAgentName(id, options)).toBe('Kimi');
    // No label: the id's last segment, still without the version.
    expect(chatAgentName(id)).toBe('kimi');
    // Not yet known, or a Fireworks chat whose model the history could not say: no name rather than a wrong one.
    expect(chatAgentName(null, options)).toBeNull();
    expect(chatAgentName('fireworks:', options)).toBeNull();
  });

  it("drops a model label's version for the placeholder", () => {
    expect(modelFamily('Kimi K3')).toBe('Kimi');
    expect(modelFamily('Kimi K2.5')).toBe('Kimi');
    expect(modelFamily('DeepSeek V4.1 Flash')).toBe('DeepSeek');
    expect(modelFamily('GLM 5.3')).toBe('GLM');
    expect(modelFamily('MiniMax M3')).toBe('MiniMax');
    expect(modelFamily('GLM-4.6')).toBe('GLM');
    expect(modelFamily('Qwen3 Coder')).toBe('Qwen');
    expect(modelFamily('Llama 3.3 70B Instruct')).toBe('Llama');
    // Nothing to drop, or nothing left once it is dropped: the label as it is.
    expect(modelFamily('Mixtral')).toBe('Mixtral');
    expect(modelFamily('4o')).toBe('4o');
  });

  it("starts a chat on Fireworks through its agent's backend, with no Claude tier", () => {
    const listed = { kind: 'listed', fullName: 'acme/widget', url: 'https://github.com/acme/widget.git', defaultBranch: 'main' } as never;
    expect(claudeModelForCreate(id)).toBeNull();
    expect(newChatCreateFields(listed, id)).toMatchObject({ claudeModel: null, backend: 'fireworks', model: KIMI });
    expect(newChatCreateFields(listed, 'opus')).not.toHaveProperty('backend');
  });
});

describe('effort', () => {
  it('sends a level and nothing for Default, and labels each', async () => {
    const { chatEffortWire, chatEffortLabel, isChatEffort, chatModelTakesEffort } = await import('./composer');
    expect(chatEffortWire('default')).toBeNull();
    expect(chatEffortWire('xhigh')).toBe('xhigh');
    expect(chatEffortLabel('xhigh')).toBe('Extra high');
    expect(isChatEffort('max')).toBe(true);
    expect(isChatEffort('eleven')).toBe(false);
    expect(chatModelTakesEffort('opus')).toBe(true);
    expect(chatModelTakesEffort('fireworks:accounts/fireworks/models/kimi-k3')).toBe(false);
  });
});
