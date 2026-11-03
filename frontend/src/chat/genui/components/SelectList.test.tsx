// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const { default: GenUiSurface } = await import('../GenUiSurface');
const { parseActionMessage } = await import('../action');
const { default: SelectList } = await import('./SelectList');

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
  { value: 'small', label: 'Small', description: '2 vCPU, 8 GB' },
  { value: 'medium', label: 'Medium', description: '4 vCPU, 16 GB' },
  { value: 'large', label: 'Large' },
];
const base = { label: 'Box size', options };

/** A SelectList bound to /pick, and a Send button that sends the surface's state. */
async function draw(props: object, state: Record<string, unknown> = {}) {
  const sends: string[] = [];
  const spec = JSON.stringify({
    root: 'main', state,
    elements: {
      main: { type: 'Stack', props: {}, children: ['sl', 'send'] },
      sl: { type: 'SelectList', props: { ...base, value: { $bindState: '/pick' }, ...props }, children: [] },
      send: { type: 'Button', props: { label: 'Send' }, children: [], on: { press: { action: 'submit' } } },
    },
  });
  const block = { type: 'code' as const, lang: 'spec', text: spec, open: false };
  await act(async () => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={{ send: async t => { sends.push(t); return true; }, sent: new Map(), ready: true }} fallback={null} />));
  return sends;
}
const items = () => [...host.querySelectorAll('[role="listbox"] [role="option"]')] as HTMLElement[];
const selected = () => items().map(o => o.getAttribute('aria-selected'));
const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };
const option = (label: string) => items().find(o => o.textContent?.startsWith(label))!;
const send = async (sends: string[]) => {
  await press([...host.querySelectorAll('button')].find(b => b.textContent === 'Send')!);
  return parseActionMessage(sends[0])?.context;
};

describe('SelectList', () => {
  it('takes up to 50 options with unique values, and a value or a list of them', () => {
    expect(SelectList.props.safeParse({ ...base, value: 'small' }).success).toBe(true);
    expect(SelectList.props.safeParse({ ...base, selectionMode: 'multiple', value: ['small', 'large'] }).success).toBe(true);
    expect(SelectList.props.safeParse({ ...base, value: null }).success).toBe(true);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `o${i}`, label: `Option ${i}` }));
    expect(SelectList.props.safeParse({ label: 'L', options: many(50) }).success).toBe(true);
    expect(SelectList.props.safeParse({ label: 'L', options: many(51) }).success).toBe(false);
    expect(SelectList.props.safeParse({ ...base, options: [...options, { value: 'small', label: 'Again' }] }).success).toBe(false);
    expect(SelectList.props.safeParse({ ...base, selectionMode: 'some' }).success).toBe(false);
  });

  it('draws an inline list named by its label, each option with its description', async () => {
    await draw({}, { pick: 'medium' });
    expect(host.querySelector('.genui-bad')).toBeNull();
    expect(host.querySelector('[role="listbox"]')?.getAttribute('aria-label')).toBe('Box size');
    expect(items().map(o => o.textContent)).toEqual(['Small2 vCPU, 8 GB', 'Medium4 vCPU, 16 GB', 'Large']);
    expect(selected()).toEqual(['false', 'true', 'false']);
  });

  it('binds the one picked option in single mode', async () => {
    const sends = await draw({}, { pick: 'medium' });
    await press(option('Large'));
    expect(selected()).toEqual(['false', 'false', 'true']);
    // Pressed again, it stays picked, as a radio would.
    await press(option('Large'));
    expect(selected()).toEqual(['false', 'false', 'true']);
    expect(await send(sends)).toEqual({ pick: 'large' });
    expect(items().every(o => o.getAttribute('aria-disabled') === 'true')).toBe(true);
  });

  it('binds every picked option, in the list\'s order, in multiple mode', async () => {
    const sends = await draw({ selectionMode: 'multiple' }, { pick: ['large'] });
    expect(host.querySelector('[role="listbox"]')?.getAttribute('aria-multiselectable')).toBe('true');
    await press(option('Small'));
    expect(selected()).toEqual(['true', 'false', 'true']);
    expect(await send(sends)).toEqual({ pick: ['small', 'large'] });
  });

  it('reads a value of the other shape as the mode needs it', async () => {
    await draw({ selectionMode: 'multiple' }, { pick: 'medium' });
    expect(selected()).toEqual(['false', 'true', 'false']);
    act(() => root.unmount());
    root = createRoot(host);
    await draw({}, { pick: ['large', 'small'] });
    expect(selected()).toEqual(['false', 'false', 'true']);
  });
});
