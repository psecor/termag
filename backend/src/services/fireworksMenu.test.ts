// The fireworks-models flag as a Claude Code launch carries it to the box for
// /model: every listed
// model, in the flag's order, by its label. The box turns the list into the
// menu (deploy/termag-credentials launch-settings, tested in its .test.sh).
import { describe, it, expect } from 'vitest';
import { launchChoice } from './agentRuntime';
import { fireworksMenuArg, parseFireworksModels } from './fireworksGateway';
import { backendChoices, modelChoicesFor } from './modelChoices';

const id = (name: string) => `accounts/fireworks/models/${name}`;
const SEVEN = [
  { id: id('glm-5p3-flash'), label: 'GLM 5.3 Flash', context: 200000 },
  { id: id('kimi-k3'), label: 'Kimi K3', context: 1048576 },
  { id: id('deepseek-v4p1-flash'), label: 'DeepSeek V4.1 Flash', context: 1048576 },
  { id: id('glm-5p3'), label: 'GLM 5.3', context: 1048576 },
  { id: id('minimax-m3'), label: 'MiniMax M3', context: 512000 },
  { id: id('qwen4-coder'), label: 'Qwen 4 Coder' },
  { id: id('llama-5-405b'), label: 'Llama 5 405B', context: 131072 },
];

/** What `--models` decodes to for a Claude Code launch on this flag value. */
function menu(flag: unknown, picked: string | null = null): Array<{ id: string; label: string; context?: number }> {
  const l = launchChoice('claude', 'fireworks', picked, parseFireworksModels(flag));
  return JSON.parse(Buffer.from(l.models!, 'base64').toString('utf8'));
}

describe('the /model menu a Claude Code launch on Fireworks carries', () => {
  it.each([1, 2, 5, 7])('lists all %i models of the flag, in its order, labelled, with their windows', n => {
    const models = SEVEN.slice(0, n);
    expect(menu({ default: models[0].id, fast: models[n - 1].id, models })).toEqual(models);
  });

  it('keeps default and fast where the flag lists them, not first', () => {
    const got = menu({ default: id('glm-5p3'), fast: id('deepseek-v4p1-flash'), models: SEVEN.slice(0, 5) });
    expect(got.map(m => m.label)).toEqual(['GLM 5.3 Flash', 'Kimi K3', 'DeepSeek V4.1 Flash', 'GLM 5.3', 'MiniMax M3']);
  });

  it('is the same list whichever model the workstream picked', () => {
    const flag = { default: id('kimi-k3'), models: SEVEN.slice(0, 5) };
    expect(menu(flag, id('minimax-m3'))).toEqual(menu(flag));
    expect(launchChoice('claude', 'fireworks', id('minimax-m3'), parseFireworksModels(flag)).model).toBe(id('minimax-m3'));
  });

  it('lists a repeated id once (its first entry) and drops bad ones', () => {
    const got = menu({ models: [SEVEN[1], { id: id('kimi-k3'), label: 'Kimi again' }, { id: 'gpt-5' }, SEVEN[3], { label: 'no id' }] });
    expect(got).toEqual([SEVEN[1], SEVEN[3]]);
  });

  it("labels a model the flag gives no label (or a blank one) by its id's last part, and leaves out an unknown window", () => {
    const got = menu({ models: [{ id: id('kimi-k3') }, { id: id('glm-5p3'), label: '  ', context: 'big' }] });
    expect(got).toEqual([{ id: id('kimi-k3'), label: 'kimi-k3' }, { id: id('glm-5p3'), label: 'glm-5p3' }]);
  });

  it('goes to every harness on Fireworks, pi included (its provider in models.json), and to none off it', () => {
    const fw = parseFireworksModels({ models: SEVEN.slice(0, 2) });
    expect(launchChoice('claude-chat', 'fireworks', null, fw).models).toBe(fireworksMenuArg(fw!.models));
    expect(launchChoice('pi', 'fireworks', null, fw).models).toBe(fireworksMenuArg(fw!.models));
    expect(launchChoice('claude', null, null, fw).models).toBeUndefined();
  });

  it('is plain base64, which a shell takes unquoted', () => {
    expect(fireworksMenuArg(parseFireworksModels({ models: SEVEN })!.models)).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe("the list a pi launch on Fireworks carries for pi's /model", () => {
  const THREE = [
    { id: id('glm-5p3-flash'), label: 'GLM 5.3 Flash', context: 1048576 },
    { id: 'accounts/fireworks/models/deepseek-v4p1-flash-1017', label: 'DeepSeek V4.1 Flash', context: 1048576 },
    { id: id('kimi-k3'), label: 'Kimi K3', context: 1048576 },
  ];
  const pi = (flag: unknown, picked: string | null = null) => {
    const l = launchChoice('pi', 'fireworks', picked, parseFireworksModels(flag));
    return { ...l, list: JSON.parse(Buffer.from(l.models!, 'base64').toString('utf8')) };
  };

  it.each([1, 3])('lists all %i models, in the flag\'s order, with the launch on the picked one', n => {
    const got = pi({ default: THREE[0].id, models: THREE.slice(0, n) }, THREE[n - 1].id);
    expect(got.list).toEqual(THREE.slice(0, n));
    expect(got.model).toBe(THREE[n - 1].id);
    expect(got.context).toBe(1048576);
  });

  it('keeps a label with spaces whole, and leaves out a window the flag does not give', () => {
    const got = pi({ models: [{ id: id('kimi-k3'), label: 'Kimi K3 (preview, 1M)' }] });
    expect(got.list).toEqual([{ id: id('kimi-k3'), label: 'Kimi K3 (preview, 1M)' }]);
    expect(got.context).toBeUndefined();
  });
});

describe("the pickers keep the flag's order", () => {
  // The variation that lists GLM 5.3 Flash first, with neither default nor fast first.
  const fw = parseFireworksModels({ default: id('kimi-k3'), fast: id('deepseek-v4p1-flash'), models: SEVEN.slice(0, 5) });
  const order = ['GLM 5.3 Flash', 'Kimi K3', 'DeepSeek V4.1 Flash', 'GLM 5.3', 'MiniMax M3'];

  it('parseFireworksModels, the model menus and GET /api/providers/models (the simple UI chat\'s entry) alike', () => {
    expect(fw!.models.map(m => m.label)).toEqual(order);
    expect(modelChoicesFor('claude-chat', 'fireworks', fw).map(m => m.label)).toEqual(order);
    const chat = backendChoices(fw, {})['claude-chat'];
    expect(chat.find(c => c.id === 'fireworks')!.models.map(m => m.label)).toEqual(order);
  });
});
