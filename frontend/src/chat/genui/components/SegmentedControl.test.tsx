// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const { default: GenUiSurface } = await import('../GenUiSurface');
const { parseActionMessage } = await import('../action');
const { default: SegmentedControl } = await import('./SegmentedControl');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const options = [{ value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }];
const base = { label: 'Period', options };

/** A SegmentedControl bound to /period, and a Send button that sends the surface's state. */
async function draw(state: Record<string, unknown> = {}) {
  const sends: string[] = [];
  const spec = JSON.stringify({
    root: 'main', state,
    elements: {
      main: { type: 'Stack', props: {}, children: ['sc', 'send'] },
      sc: { type: 'SegmentedControl', props: { ...base, value: { $bindState: '/period' } }, children: [] },
      send: { type: 'Button', props: { label: 'Send' }, children: [], on: { press: { action: 'submit' } } },
    },
  });
  const block = { type: 'code' as const, lang: 'spec', text: spec, open: false };
  await act(async () => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={{ send: async t => { sends.push(t); return true; }, sent: new Map(), ready: true }} fallback={null} />));
  return sends;
}
const radios = () => [...host.querySelectorAll('[role="radiogroup"] [role="radio"]')] as HTMLButtonElement[];
const checked = () => radios().map(r => r.getAttribute('aria-checked'));
const press = async (label: string) => {
  await act(async () => { ([...host.querySelectorAll('button')].find(b => b.textContent === label) as HTMLButtonElement).click(); });
};

describe('SegmentedControl', () => {
  it('takes 2 to 6 short options with unique values', () => {
    expect(SegmentedControl.props.safeParse({ ...base, value: 'week' }).success).toBe(true);
    expect(SegmentedControl.props.safeParse({ ...base, value: null }).success).toBe(true);
    expect(SegmentedControl.props.safeParse({ ...base, options: options.slice(0, 1) }).success).toBe(false);
    const seven = Array.from({ length: 7 }, (_, i) => ({ value: `o${i}`, label: `O${i}` }));
    expect(SegmentedControl.props.safeParse({ ...base, options: seven }).success).toBe(false);
    expect(SegmentedControl.props.safeParse({ ...base, options: [{ value: 'day', label: 'A label far too long for a segment' }, options[1]] }).success).toBe(false);
    expect(SegmentedControl.props.safeParse({ ...base, options: [options[0], { value: 'day', label: 'Again' }] }).success).toBe(false);
  });

  it('draws a radio group named by its visible label, with the bound option chosen', async () => {
    await draw({ period: 'week' });
    expect(host.querySelector('.genui-bad')).toBeNull();
    const group = host.querySelector('[role="radiogroup"]')!;
    expect(document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent).toBe('Period');
    expect(radios().map(r => r.textContent)).toEqual(['Day', 'Week', 'Month']);
    expect(checked()).toEqual(['false', 'true', 'false']);
  });

  it('chooses nothing until a value is set, then binds the pressed option and keeps one chosen', async () => {
    const sends = await draw();
    expect(checked()).toEqual(['false', 'false', 'false']);
    await press('Month');
    expect(checked()).toEqual(['false', 'false', 'true']);
    // Pressing the chosen one again leaves it chosen.
    await press('Month');
    expect(checked()).toEqual(['false', 'false', 'true']);
    await press('Send');
    expect(parseActionMessage(sends[0])?.context).toEqual({ period: 'month' });
    expect(radios().every(r => r.disabled)).toBe(true);
  });
});
