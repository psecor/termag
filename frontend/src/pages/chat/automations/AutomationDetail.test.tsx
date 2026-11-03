// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationView } from '../../../services/api';
import type { AutomationDetailView } from '../../../chat/useAutomation';
import { automation, run } from '../../../chat/automationsView.fixtures';
import { setFlagValues } from '../../../flags';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));

const api = vi.hoisted(() => ({
  list: vi.fn(), get: vi.fn(), update: vi.fn(), runNow: vi.fn(), stopRun: vi.fn(), retireRun: vi.fn(), remove: vi.fn(),
}));
vi.mock('../../../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../services/api')>()),
  automationsApi: api,
  // The model picker's options (chat/useChatModelOptions.ts): Claude's tiers, and one Fireworks model.
  providersApi: { models: async () => ({ providers: { 'claude-chat': [
    { id: null, label: 'Default', models: [] },
    { id: 'fireworks', label: 'Fireworks', models: [{ id: 'accounts/fireworks/models/kimi-k3', label: 'Kimi K3' }] },
  ] } }) },
}));

import { AutomationsProvider } from '../../../chat/useAutomations';
import { AutomationDetailRoute } from './AutomationDetail';

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

const a: AutomationView = automation({ id: 'a1', projectId: 'p1', projectName: 'alpha' });
const b: AutomationView = automation({ id: 'a2', projectId: 'p2', projectName: 'beta' });
const detail = (v: AutomationView, runs = [run({ automationId: v.id })]): AutomationDetailView => ({ ...v, runs });

let navigate: NavigateFunction;
function Nav() { navigate = useNavigate(); return null; }

let root: Root;
let host: HTMLDivElement;
async function mount(path: string) {
  await act(async () => root.render(
    <MemoryRouter initialEntries={[path]}>
      <AutomationsProvider>
        <Nav />
        <Routes>
          <Route path="/chat/automations/:id" element={<AutomationDetailRoute />} />
          <Route path="*" element={<p className="elsewhere">elsewhere</p>} />
        </Routes>
      </AutomationsProvider>
    </MemoryRouter>,
  ));
}
const title = () => host.querySelector('.chat-title-name')?.textContent;
const button = (text: string) => [...host.querySelectorAll('button')].find(el => el.textContent === text) as HTMLButtonElement | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // React Aria escapes ids with CSS.escape, which jsdom lacks (as BoxSizePicker.test.tsx), for the model Select.
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
  setFlagValues({ 'simple-ui-automations-enabled': true, 'automations-enabled': true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  for (const fn of Object.values(api)) fn.mockReset();
  api.list.mockResolvedValue([a, b]);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setFlagValues(undefined);
});

describe('AutomationDetail', () => {
  it('a slow fetch for the automation shown before keeps off the one the URL names now', async () => {
    const slowA = deferred<AutomationDetailView>();
    const runNowA = deferred<unknown>();
    api.get.mockImplementation((id: string) => (id === 'p1' ? slowA.promise : Promise.resolve(detail(b, []))));
    api.runNow.mockReturnValue(runNowA.promise);
    await mount('/chat/automations/p1');
    expect(title()).toBe('alpha'); // from the list, while its detail is out
    await act(async () => button('Run now')!.click());
    await act(async () => navigate('/chat/automations/p2'));
    expect(title()).toBe('beta');
    // A's detail, and the reload after its Run now, land after the page moved on.
    await act(async () => slowA.resolve(detail(a)));
    await act(async () => runNowA.resolve({}));
    expect(title()).toBe('beta');
    expect(host.textContent).not.toContain('Run started');
    expect(button('Run now')!.disabled).toBe(false);
    expect(api.get.mock.calls.map(c => c[0])).toEqual(['p1', 'p2']);
  });

  it('a failed run-history load is an inline error; the header, facts and actions stay', async () => {
    api.get.mockRejectedValue({ response: { data: { error: 'box unreachable' } } });
    await mount('/chat/automations/p1');
    expect(title()).toBe('alpha');
    expect(button('Run now')).toBeDefined();
    expect(host.querySelector('.chat-auto-facts')?.textContent).toContain('Runs');
    const history = host.querySelector('[aria-label="Run history"]')!;
    expect(history.querySelector('[role="alert"]')?.textContent).toContain('Could not load the runs: box unreachable');
    api.get.mockResolvedValue(detail(a, [run({ automationId: 'a1', summary: 'all quiet' })]));
    await act(async () => (history.querySelector('.sdk-error-retry') as HTMLButtonElement).click());
    expect(history.querySelector('[role="alert"]')).toBeNull();
    expect(history.textContent).toContain('all quiet');
  });

  it('says when its box could not be started', async () => {
    const failing = { ...a, boxStartFailures: { count: 6, since: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), lastError: 'Insufficient capacity.' } };
    api.list.mockResolvedValue([failing, b]);
    api.get.mockResolvedValue(detail(failing));
    await mount('/chat/automations/p1');
    expect(host.querySelector('.chat-auto-warn')?.textContent).toBe("Couldn't start its box 6 times, first 2h ago (Insufficient capacity.)");
  });

  it('a failed refresh keeps the runs it had', async () => {
    api.get.mockResolvedValueOnce(detail(a, [run({ automationId: 'a1', summary: 'all quiet' })]))
      .mockRejectedValueOnce(new Error('network'));
    await mount('/chat/automations/p1');
    api.update.mockResolvedValue(a);
    // Pause reloads; that reload fails.
    const more = host.querySelector('.chat-more-btn') as HTMLButtonElement;
    await act(async () => more.click());
    const pause = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.startsWith('Pause schedule')) as HTMLElement;
    await act(async () => pause.click());
    expect(api.update).toHaveBeenCalledWith('a1', { enabled: false });
    const history = host.querySelector('[aria-label="Run history"]')!;
    expect(history.textContent).toContain('all quiet');
    expect(history.querySelector('[role="alert"]')?.textContent).toContain('Could not refresh the runs');
  });

  it('shows the whole-page error only when neither the detail nor the list knows the automation', async () => {
    api.get.mockRejectedValue({ response: { data: { error: 'Automation not found' } } });
    await mount('/chat/automations/nope');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Automation not found');
    expect(title()).toBeUndefined();
  });

  it('Run now says why a refused run did not start', async () => {
    api.get.mockResolvedValue(detail(a, []));
    api.runNow.mockRejectedValue({ response: { status: 409, data: { decision: { kind: 'skip', reason: 'box_asleep' } } } });
    await mount('/chat/automations/p1');
    await act(async () => button('Run now')!.click());
    expect(api.runNow).toHaveBeenCalledWith('a1');
    expect(host.querySelector('.chat-auto-card [role="alert"]')?.textContent).toContain('Not started: box_asleep');
  });

  it('Archive asks first, then archives and goes Home: there is no list of automations to go back to', async () => {
    api.get.mockResolvedValue(detail(a, []));
    api.remove.mockResolvedValue({});
    await mount('/chat/automations/p1');
    await act(async () => (host.querySelector('.chat-more-btn') as HTMLButtonElement).click());
    const archive = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.startsWith('Archive')) as HTMLElement;
    await act(async () => archive.click());
    expect(api.remove).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll('button')].find(el => el.textContent === 'Archive') as HTMLButtonElement;
    api.list.mockResolvedValue([b]);
    await act(async () => confirm.click());
    expect(api.remove).toHaveBeenCalledWith('a1');
    expect(host.querySelector('.elsewhere')).not.toBeNull();
    expect(api.list).toHaveBeenCalledTimes(2); // reloaded, so its row leaves its space's explorer
  });

  it('shows the model the next run starts on, and the owner changes it with the model picker', async () => {
    api.get.mockResolvedValue(detail(automation({ id: 'a1', projectId: 'p1', projectName: 'alpha', backend: null, model: 'opus' }), []));
    api.update.mockResolvedValue(a);
    await mount('/chat/automations/p1');
    const trigger = host.querySelector('.chat-auto-model-button') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Opus 5.5');
    await act(async () => trigger.click());
    const options = [...document.querySelectorAll('[role="option"]')] as HTMLElement[];
    expect(options.map(o => o.textContent)).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5', 'Kimi K3']);
    await act(async () => options.find(o => o.textContent === 'Kimi K3')!.click());
    expect(api.update).toHaveBeenCalledWith('a1', { backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k3' });
    expect(host.textContent).toContain('The next run starts on Kimi K3');
  });

  it('reads an automation with no model as Sonnet, and a Claude pick moves it off Fireworks', async () => {
    api.get.mockResolvedValue(detail(automation({ id: 'a1', projectId: 'p1', projectName: 'alpha', backend: 'fireworks', model: 'accounts/fireworks/models/kimi-k3' }), []));
    api.update.mockResolvedValue(a);
    await mount('/chat/automations/p1');
    const trigger = host.querySelector('.chat-auto-model-button') as HTMLButtonElement;
    expect(trigger.textContent).toContain('Kimi K3');
    await act(async () => trigger.click());
    await act(async () => ([...document.querySelectorAll('[role="option"]')] as HTMLElement[]).find(o => o.textContent === 'Haiku 4.5')!.click());
    expect(api.update).toHaveBeenCalledWith('a1', { backend: null, model: 'haiku' });
  });

  it('hides Run now and the owner actions on a shared automation', async () => {
    const shared = automation({ id: 'a3', projectId: 'p3', projectName: 'shared', owner: false });
    api.list.mockResolvedValue([shared]);
    api.get.mockResolvedValue(detail(shared, []));
    await mount('/chat/automations/p3');
    expect(button('Run now')).toBeUndefined();
    expect(host.textContent).toContain('Shared with you');
    // The model is words, not a picker.
    expect(host.querySelector('.chat-auto-model-button')).toBeNull();
    expect(host.querySelector('.chat-auto-facts')?.textContent).toContain('Sonnet 5.5');
  });
});

describe('AutomationDetail without both flags', () => {
  it('is off', async () => {
    setFlagValues({ 'simple-ui-automations-enabled': true, 'automations-enabled': false });
    await mount('/chat/automations/p1');
    expect(api.list).not.toHaveBeenCalled();
    expect(host.textContent).toContain('not on');
  });
});
