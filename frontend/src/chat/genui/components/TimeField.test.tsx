// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const { default: GenUiSurface } = await import('../GenUiSurface');
const { parseActionMessage } = await import('../action');
const { default: TimeField, hhmm } = await import('./TimeField');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

/** A TimeField bound to /at, and a Send button that sends the surface's state. */
async function draw(props: object, state: Record<string, unknown> = {}) {
  const sends: string[] = [];
  const spec = JSON.stringify({
    root: 'main', state,
    elements: {
      main: { type: 'Stack', props: {}, children: ['tf', 'send'] },
      tf: { type: 'TimeField', props: { label: 'Start', value: { $bindState: '/at' }, ...props }, children: [] },
      send: { type: 'Button', props: { label: 'Send' }, children: [], on: { press: { action: 'submit' } } },
    },
  });
  const block = { type: 'code' as const, lang: 'spec', text: spec, open: false };
  await act(async () => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={{ send: async t => { sends.push(t); return true; }, sent: new Map(), ready: true }} fallback={null} />));
  return sends;
}
const segment = (type: string) => host.querySelector(`[role="spinbutton"][data-type="${type}"]`) as HTMLElement;

describe('TimeField', () => {
  it('takes HH:MM on a 24-hour clock', () => {
    for (const ok of ['00:00', '09:30', '17:05', '23:59']) expect(TimeField.props.safeParse({ label: 'Start', value: ok }).success).toBe(true);
    for (const bad of ['9:30', '24:00', '12:60', '09:30:00', '9:30 AM']) expect(TimeField.props.safeParse({ label: 'Start', value: bad }).success).toBe(false);
    expect(TimeField.props.safeParse({ label: 'Start', value: null, isRequired: true, description: 'Local time' }).success).toBe(true);
  });

  it('writes a time as HH:MM, without seconds', () => {
    expect(hhmm({ hour: 9, minute: 5 })).toBe('09:05');
    expect(hhmm({ hour: 23, minute: 30 })).toBe('23:30');
  });

  it('draws hours and minutes from the bound value, under its label', async () => {
    await draw({ description: 'Your local time' }, { at: '17:05' });
    expect(host.querySelector('.genui-bad')).toBeNull();
    // In the locale's own clock: "5 PM" in en-US, "17" on a 24-hour one.
    expect(['5 PM', '17']).toContain(segment('hour').getAttribute('aria-valuetext'));
    expect(segment('minute').textContent).toBe('05');
    expect(host.querySelector('[role="spinbutton"][data-type="second"]')).toBeNull();
    const group = host.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-labelledby')?.split(' ').map(id => document.getElementById(id)?.textContent)).toContain('Start');
    expect(host.textContent).toContain('Your local time');
  });

  it('binds a time changed with the keyboard, and is disabled once answered', async () => {
    const sends = await draw({}, { at: '09:30' });
    const minute = segment('minute');
    await act(async () => { minute.focus(); minute.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    await act(async () => { ([...host.querySelectorAll('button')].find(b => b.textContent === 'Send') as HTMLButtonElement).click(); });
    expect(parseActionMessage(sends[0])?.context).toEqual({ at: '09:31' });
    expect(segment('minute').getAttribute('aria-disabled')).toBe('true');
  });

  it('draws empty segments for no value', async () => {
    await draw({}, { at: null });
    expect(segment('hour').getAttribute('aria-valuetext')).toBe('Empty');
    expect(segment('minute').getAttribute('aria-valuetext')).toBe('Empty');
  });
});
