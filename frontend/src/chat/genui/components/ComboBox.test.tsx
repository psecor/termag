// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
// React Aria's overlays read a CSP nonce through CSS.escape, which jsdom lacks.
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
const { default: GenUiSurface } = await import('../GenUiSurface');
const { parseActionMessage } = await import('../action');
const { default: ComboBox, COMBOBOX_TEXT_MAX } = await import('./ComboBox');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const options = [
  { value: 'termag', label: 'termag', description: 'The orchestrator' },
  { value: 'atrium', label: 'atrium' },
  { value: 'js-core', label: 'JavaScript SDK core' },
];
const base = { label: 'Repository', options };

/** A ComboBox bound to /pick, a Send button that sends the surface's state, and one that sets /pick from elsewhere. */
async function draw(props: object, state: Record<string, unknown> = {}) {
  const sends: string[] = [];
  const spec = JSON.stringify({
    root: 'main', state,
    elements: {
      main: { type: 'Stack', props: {}, children: ['cb', 'send', 'reset'] },
      cb: { type: 'ComboBox', props: { ...base, value: { $bindState: '/pick' }, ...props }, children: [] },
      send: { type: 'Button', props: { label: 'Send' }, children: [], on: { press: { action: 'submit' } } },
      reset: { type: 'Button', props: { label: 'Use atrium' }, children: [], on: { press: { action: 'setState', params: { statePath: '/pick', value: 'atrium' } } } },
    },
  });
  const block = { type: 'code' as const, lang: 'spec', text: spec, open: false };
  await act(async () => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={{ send: async t => { sends.push(t); return true; }, sent: new Map(), ready: true }} fallback={null} />));
  return sends;
}
const input = () => host.querySelector('input[role="combobox"]') as HTMLInputElement;
async function type(text: string) {
  await act(async () => {
    input().focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function send(sends: string[]) {
  await act(async () => { ([...host.querySelectorAll('button')].find(b => b.textContent === 'Send') as HTMLButtonElement).click(); });
  return parseActionMessage(sends[sends.length - 1])?.context;
}

describe('ComboBox', () => {
  it('takes up to 200 options with unique values, and a typed value no longer than the input allows', () => {
    expect(ComboBox.props.safeParse({ ...base, value: 'atrium', placeholder: 'Search…', isRequired: true }).success).toBe(true);
    expect(ComboBox.props.safeParse({ ...base, value: null }).success).toBe(true);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `r${i}`, label: `Repo ${i}` }));
    expect(ComboBox.props.safeParse({ label: 'Repo', options: many(200) }).success).toBe(true);
    expect(ComboBox.props.safeParse({ label: 'Repo', options: many(201) }).success).toBe(false);
    expect(ComboBox.props.safeParse({ ...base, options: [...options, { value: 'atrium', label: 'Again' }] }).success).toBe(false);
    expect(ComboBox.props.safeParse({ ...base, options: [] }).success).toBe(false);
    expect(ComboBox.props.safeParse({ ...base, allowsCustomValue: true, value: 'x'.repeat(COMBOBOX_TEXT_MAX) }).success).toBe(true);
    expect(ComboBox.props.safeParse({ ...base, allowsCustomValue: true, value: 'x'.repeat(COMBOBOX_TEXT_MAX + 1) }).success).toBe(false);
  });

  it('draws a labelled combobox showing the chosen option\'s label', async () => {
    await draw({ description: 'Where the session runs' }, { pick: 'js-core' });
    expect(host.querySelector('.genui-bad')).toBeNull();
    expect(input().value).toBe('JavaScript SDK core');
    const labelledBy = input().getAttribute('aria-labelledby')!.split(' ');
    expect(labelledBy.map(id => document.getElementById(id)?.textContent)).toContain('Repository');
    expect(host.textContent).toContain('Where the session runs');
    expect(host.querySelector('button[aria-label="Show options"]')).not.toBeNull();
  });

  it('filters as the person types, and binds the picked option\'s value', async () => {
    const sends = await draw({});
    await type('java');
    const shown = [...document.querySelectorAll('[role="option"]')];
    expect(shown.map(o => o.textContent)).toEqual(['JavaScript SDK core']);
    await act(async () => { (shown[0] as HTMLElement).click(); });
    expect(input().value).toBe('JavaScript SDK core');
    expect(await send(sends)).toEqual({ pick: 'js-core' });
  });

  it('with allowsCustomValue, binds what was typed', async () => {
    const sends = await draw({ allowsCustomValue: true }, { pick: 'feature/old' });
    expect(input().value).toBe('feature/old');
    expect(input().maxLength).toBe(COMBOBOX_TEXT_MAX);
    await type('feature/new-thing');
    expect(input().value).toBe('feature/new-thing');
    expect(await send(sends)).toEqual({ pick: 'feature/new-thing' });
  });

  it('with allowsCustomValue, binds an option\'s value when its label is typed', async () => {
    const sends = await draw({ allowsCustomValue: true });
    await type('JavaScript SDK core');
    expect(await send(sends)).toEqual({ pick: 'js-core' });
  });

  it('with allowsCustomValue, shows a picked option\'s label', async () => {
    const sends = await draw({ allowsCustomValue: true });
    await type('atr');
    await act(async () => { (document.querySelector('[role="option"]') as HTMLElement).click(); });
    expect(input().value).toBe('atrium');
    expect(await send(sends)).toEqual({ pick: 'atrium' });
  });

  it('with allowsCustomValue, shows a value set from elsewhere over what was typed', async () => {
    await draw({ allowsCustomValue: true });
    await type('something else');
    await act(async () => { ([...host.querySelectorAll('button')].find(b => b.textContent === 'Use atrium') as HTMLButtonElement).click(); });
    expect(input().value).toBe('atrium');
  });

  it('keeps a chosen value while the person types to filter, and clears it only with an empty field', async () => {
    const sends = await draw({}, { pick: 'atrium' });
    await type('java');
    expect(await send(sends)).toEqual({ pick: 'atrium' });
  });

  it('keeps a chosen value while the field is being retyped, then clears it once empty', async () => {
    const sends = await draw({}, { pick: 'atrium' });
    await type('');
    expect(await send(sends)).toEqual({ pick: null });
  });

  it('with allowsCustomValue, binds the option picked even when an earlier one shares its label', async () => {
    const twins = [{ value: 'a1', label: 'Same' }, { value: 'a2', label: 'Same', description: 'the other' }];
    const sends = await draw({ allowsCustomValue: true, options: twins });
    await type('Sa');
    const shown = [...document.querySelectorAll('[role="option"]')];
    await act(async () => { (shown[1] as HTMLElement).click(); });
    expect(await send(sends)).toEqual({ pick: 'a2' });
  });

  it('is disabled once the surface has answered', async () => {
    const sends = await draw({}, { pick: 'atrium' });
    await send(sends);
    expect(input().disabled).toBe(true);
  });
});
