// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const { default: GenUiSurface } = await import('../GenUiSurface');
const { default: Accordion } = await import('./Accordion');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const sections = [{ id: 'one', title: 'First' }, { id: 'two', title: 'Second' }, { id: 'three', title: 'Third' }];
function draw(props: object) {
  const text = JSON.stringify({
    root: 'a',
    elements: {
      a: { type: 'Accordion', props, children: ['p1', 'p2', 'p3'] },
      p1: { type: 'Text', props: { text: 'Panel one' }, children: [] },
      p2: { type: 'Text', props: { text: 'Panel two' }, children: [] },
      p3: { type: 'Text', props: { text: 'Panel three' }, children: [] },
    },
  });
  const block = { type: 'code' as const, lang: 'spec', text, open: false };
  act(() => root.render(<GenUiSurface block={block} itemKey="r" streaming={false} chat={null} fallback={null} />));
}
const triggers = () => [...host.querySelectorAll('.genui-accordion-trigger')] as HTMLButtonElement[];
const expanded = () => triggers().filter(b => b.getAttribute('aria-expanded') === 'true').map(b => b.textContent);

describe('Accordion', () => {
  it('takes 1 to 12 sections, each with its own id', () => {
    const ok = (p: object) => Accordion.props.safeParse(p).success;
    expect(ok({ sections })).toBe(true);
    expect(ok({ sections, allowsMultipleExpanded: true, defaultExpanded: ['one', 'two'] })).toBe(true);
    expect(ok({ sections: [] })).toBe(false);
    expect(ok({ sections: Array.from({ length: 13 }, (_, i) => ({ id: `s${i}`, title: `S${i}` })) })).toBe(false);
    expect(ok({ sections: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] })).toBe(false);
    expect(ok({ sections: [{ id: 'a', title: '' }] })).toBe(false);
  });

  it('puts child N in section N, and opens the default one', () => {
    draw({ sections, defaultExpanded: ['two'] });
    expect(host.querySelector('.genui-bad')).toBeNull();
    expect(triggers().map(b => b.textContent)).toEqual(['First', 'Second', 'Third']);
    expect(expanded()).toEqual(['Second']);
    const panels = [...host.querySelectorAll('.genui-accordion-section')].map(s => s.querySelector('.genui-accordion-panel')?.textContent);
    expect(panels).toEqual(['Panel one', 'Panel two', 'Panel three']);
    // Each trigger is in a heading and controls its panel.
    const t = triggers()[1];
    expect(t.closest('h5')).not.toBeNull();
    expect(document.getElementById(t.getAttribute('aria-controls')!)?.textContent).toBe('Panel two');
  });

  it('opens one section at a time unless it allows several', async () => {
    draw({ sections, defaultExpanded: ['one', 'two'] });
    expect(expanded()).toEqual(['First']);
    await act(async () => { triggers()[2].click(); });
    expect(expanded()).toEqual(['Third']);
  });

  it('keeps several open when it allows several', async () => {
    draw({ sections, allowsMultipleExpanded: true, defaultExpanded: ['one', 'two'] });
    expect(expanded()).toEqual(['First', 'Second']);
    await act(async () => { triggers()[2].click(); });
    expect(expanded()).toEqual(['First', 'Second', 'Third']);
    await act(async () => { triggers()[0].click(); });
    expect(expanded()).toEqual(['Second', 'Third']);
  });

  it('starts all closed with no defaultExpanded', () => {
    draw({ sections });
    expect(expanded()).toEqual([]);
  });
});
