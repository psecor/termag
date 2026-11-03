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
const { default: DateRangePicker } = await import('./DateRangePicker');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

/** A DateRangePicker bound to /period, and a Send button that sends the surface's state. */
async function draw(props: object, state: Record<string, unknown> = {}) {
  const sends: string[] = [];
  const spec = JSON.stringify({
    root: 'main', state,
    elements: {
      main: { type: 'Stack', props: {}, children: ['dr', 'send'] },
      dr: { type: 'DateRangePicker', props: { label: 'Period', value: { $bindState: '/period' }, ...props }, children: [] },
      send: { type: 'Button', props: { label: 'Send' }, children: [], on: { press: { action: 'submit' } } },
    },
  });
  const block = { type: 'code' as const, lang: 'spec', text: spec, open: false };
  await act(async () => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={{ send: async t => { sends.push(t); return true; }, sent: new Map(), ready: true }} fallback={null} />));
  return sends;
}
/** The day segments, start's then end's. */
const days = () => [...host.querySelectorAll('[role="spinbutton"][data-type="day"]')] as HTMLElement[];
const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label)!;

describe('DateRangePicker', () => {
  it('takes a start and an end, as YYYY-MM-DD', () => {
    expect(DateRangePicker.props.safeParse({ label: 'Period', value: { start: '2026-10-01', end: '2026-10-28' }, min: '2026-01-01', isRequired: true }).success).toBe(true);
    expect(DateRangePicker.props.safeParse({ label: 'Period', value: { start: '2026-10-28', end: '2026-10-28' } }).success).toBe(true);
    expect(DateRangePicker.props.safeParse({ label: 'Period', value: null }).success).toBe(true);
    // An end before its start is the field's to show as invalid, never a reason to stop drawing it.
    expect(DateRangePicker.props.safeParse({ label: 'Period', value: { start: '2026-10-28', end: '2026-10-01' } }).success).toBe(true);
    expect(DateRangePicker.props.safeParse({ label: 'Period', value: { start: '10/01/2026', end: '2026-10-28' } }).success).toBe(false);
    expect(DateRangePicker.props.safeParse({ label: 'Period', value: { start: '2026-10-01' } }).success).toBe(false);
    expect(DateRangePicker.props.safeParse({ label: 'Period', max: 'today' }).success).toBe(false);
  });

  it('draws both dates from the bound value, under its label', async () => {
    await draw({ description: 'Up to 90 days' }, { period: { start: '2026-10-01', end: '2026-10-28' } });
    expect(host.querySelector('.genui-bad')).toBeNull();
    expect(days().map(d => d.textContent)).toEqual(['1', '28']);
    expect(host.querySelector('[role="group"]')?.getAttribute('aria-labelledby')?.split(' ').map(id => document.getElementById(id)?.textContent)).toContain('Period');
    expect(host.textContent).toContain('Up to 90 days');
  });

  it('keeps drawing the field when the end comes before the start, so the person can fix it there', async () => {
    await draw({}, { period: { start: '2026-10-28', end: '2026-10-01' } });
    expect(host.querySelector('.genui-bad')).toBeNull();
    expect(days().map(d => d.textContent)).toEqual(['28', '1']);
    expect(host.querySelector('[role="group"]')).not.toBeNull();
  });

  it('draws empty fields for no value, or for a date that does not exist', async () => {
    await draw({}, { period: { start: '2026-02-30', end: '2026-03-02' } });
    expect(host.querySelector('.genui-bad')).toBeNull();
    expect(days().map(d => d.getAttribute('aria-valuetext'))).toEqual(['Empty', 'Empty']);
  });

  it('binds a range picked on the calendar', async () => {
    const sends = await draw({ min: '2026-10-01', max: '2026-10-31' }, { period: { start: '2026-10-01', end: '2026-10-28' } });
    await press(button('Open calendar'));
    const cell = (day: string) => [...document.querySelectorAll('[role="gridcell"] [role="button"]')].find(c => c.textContent === day)!;
    expect(document.querySelector('[role="dialog"] [role="grid"]')).not.toBeNull();
    await press(cell('5'));
    await press(cell('9'));
    await press(button('Send'));
    expect(parseActionMessage(sends[0])?.context).toEqual({ period: { start: '2026-10-05', end: '2026-10-09' } });
  });

  it('binds a date typed with the keyboard', async () => {
    const sends = await draw({}, { period: { start: '2026-10-01', end: '2026-10-28' } });
    const end = days()[1];
    await act(async () => { end.focus(); end.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); });
    await press(button('Send'));
    expect(parseActionMessage(sends[0])?.context).toEqual({ period: { start: '2026-10-01', end: '2026-10-29' } });
    expect(days().every(d => d.getAttribute('aria-disabled') === 'true')).toBe(true);
  });
});
