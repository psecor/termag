// @vitest-environment jsdom
// The phone client's tab bar: Sessions, Search, and Chat, the way to the simple UI.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TabBar } from './TabBar';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function show(at: string) {
  act(() => root.render(<MemoryRouter initialEntries={[at]}><TabBar attention={2} /></MemoryRouter>));
}

describe('TabBar', () => {
  it('has Sessions, Search and Chat, and Chat opens the simple UI', () => {
    show('/m');
    const tabs = [...host.querySelectorAll('.m-tabbar-item')];
    expect(tabs.map(t => t.querySelector('.m-tabbar-label')?.textContent)).toEqual(['Sessions', 'Search', 'Chat']);
    expect(tabs.map(t => t.getAttribute('href'))).toEqual(['/m', '/m/search', '/chat']);
  });

  it('never marks Chat active: it leaves the phone client', () => {
    show('/m/search');
    const active = [...host.querySelectorAll('.m-tabbar-item.active')].map(t => t.querySelector('.m-tabbar-label')?.textContent);
    expect(active).toEqual(['Search']);
  });
});
