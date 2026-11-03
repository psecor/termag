// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
const { default: GenUiSurface } = await import('../GenUiSurface');
const { default: Breadcrumbs } = await import('./Breadcrumbs');

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

function draw(props: object) {
  const text = JSON.stringify({ root: 'b', elements: { b: { type: 'Breadcrumbs', props, children: [] } } });
  act(() => root.render(<GenUiSurface block={{ type: 'code', lang: 'spec', text, open: false }} itemKey="r" streaming={false} chat={null} fallback={null} />));
}

const items = (...labels: string[]) => labels.map((label, i) => ({ id: `i${i}`, label }));

describe('Breadcrumbs', () => {
  it('takes 1 to 8 items, each an id and a label, and nothing to link to', () => {
    expect(Breadcrumbs.props.safeParse({ items: items('termag') }).success).toBe(true);
    expect(Breadcrumbs.props.safeParse({ items: [] }).success).toBe(false);
    expect(Breadcrumbs.props.safeParse({ items: items('1', '2', '3', '4', '5', '6', '7', '8', '9') }).success).toBe(false);
    expect(Breadcrumbs.props.safeParse({ items: [{ id: 'a' }] }).success).toBe(false);
    expect(Breadcrumbs.props.safeParse({ items: [{ id: 'a', label: 'x'.repeat(101) }] }).success).toBe(false);
  });

  it('draws plain labels with a separator between them, the last one current', () => {
    draw({ items: items('termag', 'frontend', 'chat', 'GenUiSurface.tsx') });
    expect(host.querySelector('.genui-bad')).toBeNull();
    const crumbs = [...host.querySelectorAll('ol.genui-breadcrumbs > li')];
    expect(crumbs.map(li => li.textContent)).toEqual(['termag', 'frontend', 'chat', 'GenUiSurface.tsx']);
    expect(crumbs.map(li => li.hasAttribute('data-current'))).toEqual([false, false, false, true]);
    expect(crumbs.map(li => !!li.querySelector('svg[data-icon="slash"]'))).toEqual([true, true, true, false]);
    expect(host.querySelector('[aria-current="location"]')?.textContent).toBe('GenUiSurface.tsx');
    expect(host.querySelectorAll('.genui-breadcrumbs :is(a, [role="link"], button)')).toHaveLength(0);
  });

  it('draws every item when ids repeat, even one spelled like another\'s fallback key', () => {
    draw({ items: [{ id: 'x', label: 'src' }, { id: 'x', label: 'src' }, { id: 'x#1', label: 'chat' }] });
    expect([...host.querySelectorAll('ol.genui-breadcrumbs > li')].map(li => li.textContent)).toEqual(['src', 'src', 'chat']);
  });

  it('is named for a screen reader, "Location" unless the spec says what it locates', () => {
    draw({ items: items('termag', 'chat') });
    expect(host.querySelector('ol.genui-breadcrumbs')?.getAttribute('aria-label')).toBe('Location');
    draw({ label: 'Where the flag lives', items: items('Checkout', 'Production') });
    expect(host.querySelector('ol.genui-breadcrumbs')?.getAttribute('aria-label')).toBe('Where the flag lives');
  });
});
