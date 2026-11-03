// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iconsNames } from '@launchpad-ui/icons';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const { default: GenUiSurface } = await import('../GenUiSurface');
const { default: EmptyState, EMPTY_STATE_ICONS } = await import('./EmptyState');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function draw(elements: Record<string, object>) {
  const text = JSON.stringify({ root: 'e', elements });
  act(() => root.render(<GenUiSurface block={{ type: 'code', lang: 'spec', text, open: false }} itemKey="r" streaming={false} chat={null} fallback={null} />));
}

describe('EmptyState', () => {
  it('takes a title, a description and an icon from its list', () => {
    expect(EmptyState.props.safeParse({ title: 'No open PRs', description: 'All merged.', icon: 'inbox' }).success).toBe(true);
    expect(EmptyState.props.safeParse({ title: 'No open PRs' }).success).toBe(true);
    expect(EmptyState.props.safeParse({ title: '' }).success).toBe(false);
    expect(EmptyState.props.safeParse({ title: 'x', icon: 'add' }).success).toBe(false);
    expect(EmptyState.props.safeParse({ title: 'x', description: 'y'.repeat(2001) }).success).toBe(false);
  });

  it('offers only icons that are in LaunchPad\'s sprite', () => {
    expect(EMPTY_STATE_ICONS.filter(name => !(iconsNames as readonly string[]).includes(name))).toEqual([]);
  });

  it('draws LaunchPad\'s empty state, with the spec\'s buttons as its actions', () => {
    draw({
      e: { type: 'EmptyState', props: { title: 'No failing checks', description: 'Every check on main passed.', icon: 'check-circle' }, children: ['b'] },
      b: { type: 'Button', props: { label: 'Run them again' }, children: [] },
    });
    expect(host.querySelector('.genui-bad')).toBeNull();
    const state = host.querySelector('.genui-emptystate')!;
    expect(state.querySelector('h5')?.textContent).toBe('No failing checks');
    expect(state.querySelector('p')?.textContent).toBe('Every check on main passed.');
    expect(state.querySelector('svg[data-icon="check-circle"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(state.querySelector('.genui-emptystate-actions[role="group"] button')?.textContent).toBe('Run them again');
  });

  it('gives the actions\' place to its own group, not to a ButtonGroup inside it', () => {
    draw({
      e: { type: 'EmptyState', props: { title: 'No boxes' }, children: ['g'] },
      g: { type: 'ButtonGroup', props: {}, children: ['b1', 'b2'] },
      b1: { type: 'Button', props: { label: 'Create a box', variant: 'primary' }, children: [] },
      b2: { type: 'Button', props: { label: 'Read the docs' }, children: [] },
    });
    const outer = host.querySelector('.genui-emptystate-actions')!;
    // LaunchPad's CSS module class for the actions area ([hash]_actions, launchpad/launchpadCss.ts).
    const place = [...outer.classList].filter(c => /_actions$/.test(c));
    expect(place).toHaveLength(1);
    const inner = outer.querySelector('.genui-buttons')!;
    expect(inner.classList.contains(place[0])).toBe(false);
    expect([...inner.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Create a box', 'Read the docs']);
  });

  it('draws no icon and no actions when the spec gives none', () => {
    draw({ e: { type: 'EmptyState', props: { title: 'Nothing here' }, children: [] } });
    expect(host.querySelector('.genui-bad')).toBeNull();
    expect(host.querySelector('.genui-emptystate svg')).toBeNull();
    expect(host.querySelector('.genui-emptystate-actions')).toBeNull();
  });

  it('draws a note for an icon off its list', () => {
    draw({ e: { type: 'EmptyState', props: { title: 'x', icon: 'delete' }, children: [] } });
    expect(host.querySelector('.genui-bad')?.textContent).toMatch(/^EmptyState could not be drawn \(icon:/);
  });
});
