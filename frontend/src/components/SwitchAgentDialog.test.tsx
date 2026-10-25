// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwitchAgentDialog } from './SwitchAgentDialog';
import { resetBackendChoicesForTests } from '../providers/useBackendChoices';

const KIMI = 'accounts/fireworks/models/kimi-k3';
const menus = vi.hoisted(() => ({ providers: {} as Record<string, unknown> }));
vi.mock('../services/api', () => ({ providersApi: { models: async () => ({ providers: menus.providers }) } }));

const MENUS = {
  claude: [
    { id: null, label: 'Default', models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }] },
    { id: 'fireworks', label: 'Fireworks', models: [{ id: KIMI, label: 'kimi-k3' }] },
  ],
  pi: [{ id: null, label: 'Default', models: [] }, { id: 'fireworks', label: 'Fireworks', models: [{ id: KIMI, label: 'kimi-k3' }] }],
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  menus.providers = MENUS;
  resetBackendChoicesForTests();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(props: Partial<React.ComponentProps<typeof SwitchAgentDialog>> = {}) {
  const onSwitch = vi.fn();
  await act(async () => {
    root.render(<SwitchAgentDialog title="termag" current="claude" busy={false} onSwitch={onSwitch} onCancel={vi.fn()} {...props} />);
  });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  return onSwitch;
}

const select = (id: string) => document.getElementById(id) as HTMLSelectElement | null;
const options = (id: string) => [...select(id)!.options].map(o => o.textContent);
async function choose(id: string, value: string) {
  await act(async () => {
    const el = select(id)!;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
const submit = () => document.querySelector('button[type="submit"]') as HTMLButtonElement;

describe('SwitchAgentDialog: inference and model', () => {
  it('a new model for the running agent is a switch; the same one is not', async () => {
    const onSwitch = await render();
    await choose('switch-agent-select', 'claude');
    expect(options('switch-model')).toEqual(['Default (running now)', 'Opus', 'Sonnet']);
    expect(submit().disabled).toBe(true);
    await choose('switch-model', 'sonnet');
    await act(async () => { submit().click(); });
    expect(onSwitch).toHaveBeenCalledWith('claude', null, 'sonnet');
  });

  it('opens on another agent, so a confirm without a pick never moves the running one onto the defaults', async () => {
    const onSwitch = await render({ currentBackend: 'fireworks', currentModel: KIMI });
    expect(select('switch-agent-select')!.value).not.toBe('claude');
    await act(async () => { submit().click(); });
    expect(onSwitch.mock.calls[0][0]).not.toBe('claude');
  });

  it('moves the running agent onto another backend and model, starting from what runs now', async () => {
    const onSwitch = await render({ currentBackend: 'fireworks', currentModel: KIMI });
    await choose('switch-agent-select', 'claude');
    expect(select('switch-backend')!.value).toBe('fireworks');
    expect(options('switch-model')).toEqual(['Default', 'kimi-k3 (running now)']);
    expect(submit().disabled).toBe(true);
    await choose('switch-backend', '');
    expect(select('switch-model')!.value).toBe('');
    await act(async () => { submit().click(); });
    expect(onSwitch).toHaveBeenCalledWith('claude', null, null);
  });

  it('another agent starts on its defaults, and one with no choices shows neither field', async () => {
    const onSwitch = await render({ currentBackend: 'fireworks', currentModel: KIMI });
    await choose('switch-agent-select', 'pi');
    expect(select('switch-backend')!.value).toBe('');
    expect(select('switch-model')).toBeNull();
    await choose('switch-agent-select', 'cursor');
    expect(select('switch-backend')).toBeNull();
    await act(async () => { submit().click(); });
    expect(onSwitch).toHaveBeenCalledWith('cursor', null, null);
  });
});
