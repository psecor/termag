// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoPick } from '../utils/repoPick';
import { RepoPicker } from './RepoPicker';

const repos = ['proj-jumpy-badger', 'chess', 'doodler', 'swing', 'agi', 'nextjs2', 'nextjs-boilerplate'];

vi.mock('../services/api', () => ({
  projectsApi: { templates: vi.fn(async () => []) },
  githubReposApi: {
    list: vi.fn(async () => ({
      status: 'ok',
      groups: [{ owner: 'zane', kind: 'user', status: 'ok', repos: repos.map(n => ({ fullName: `zane/${n}`, defaultBranch: 'main' })) }],
    })),
  },
}));

let root: Root;
let host: HTMLDivElement;
const picks: RepoPick[] = [];

function Harness({ dropdown }: { dropdown: boolean }) {
  const [value, setValue] = useState<RepoPick>({ kind: 'empty' });
  return <RepoPicker dropdown={dropdown} value={value} onChange={next => { picks.push(next); setValue(next); }} showPaste={false} />;
}

async function render(dropdown = true) {
  await act(async () => { root.render(<Harness dropdown={dropdown} />); });
}

const search = () => host.querySelector<HTMLInputElement>('#npf-repo-search')!;
const options = () => [...host.querySelectorAll('[role="option"]')].map(o => o.textContent);

function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), text);
    search().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** Presses a key in the search field; true when the picker left it to the form (not prevented). */
function key(k: string): boolean {
  let passed = false;
  act(() => { passed = search().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
  return passed;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  picks.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('RepoPicker dropdown', () => {
  it('lists no repositories until the search field is focused, then all of them, sorted, one per row', async () => {
    await render();
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(host.querySelectorAll('.npf-repo').length).toBe(1); // only "empty"

    act(() => search().focus());
    expect(search().getAttribute('aria-expanded')).toBe('true');
    expect(options()).toEqual([
      'zane/agi', 'zane/chess', 'zane/doodler', 'zane/nextjs-boilerplate', 'zane/nextjs2', 'zane/proj-jumpy-badger', 'zane/swing',
    ]);
  });

  it('narrows the list as you type and picks with a click', async () => {
    await render();
    act(() => search().focus());
    type('next');
    expect(options()).toEqual(['zane/nextjs-boilerplate', 'zane/nextjs2']);
    type('nothing-like-it');
    expect(options()).toEqual([]);
    expect(host.querySelector('[role="listbox"]')!.textContent).toContain('No repositories match');

    type('chess');
    act(() => (host.querySelector('[role="option"]') as HTMLElement).click());
    expect(picks[picks.length - 1]).toEqual({ kind: 'listed', fullName: 'zane/chess', defaultBranch: 'main' });
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(search().value).toBe('zane/chess');
  });

  it('moves with the arrow keys, picks with Enter and closes with Escape', async () => {
    await render();
    act(() => search().focus());
    expect(search().getAttribute('aria-activedescendant')).toBeNull();
    key('ArrowDown');
    key('ArrowDown');
    key('ArrowDown');
    expect(search().getAttribute('aria-activedescendant')).toBe('npf-repo-option-2');
    key('Enter');
    expect(picks[picks.length - 1]).toMatchObject({ kind: 'listed', fullName: 'zane/doodler' });

    act(() => search().blur());
    act(() => search().focus());
    // Reopened on the chosen repository: everything is listed again, the choice marked.
    expect(options().length).toBe(repos.length);
    expect(host.querySelector('[aria-selected="true"]')!.textContent).toBe('zane/doodler');
    key('Escape');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(search().value).toBe('zane/doodler');
  });

  it('reopens on the chosen repository, so Enter keeps it and submits the form', async () => {
    await render();
    act(() => search().focus());
    type('swing');
    expect(key('Enter')).toBe(false);
    expect(picks).toEqual([{ kind: 'listed', fullName: 'zane/swing', defaultBranch: 'main' }]);

    act(() => search().blur());
    act(() => search().focus());
    expect(host.querySelector('.npf-combo-option.is-active')!.textContent).toBe('zane/swing');
    expect(key('Enter')).toBe(true);
    expect(picks.length).toBe(1);
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(search().value).toBe('zane/swing');

    // Reopened from the keyboard, moving off the choice and pressing Enter picks the new row.
    key('ArrowUp');
    expect(host.querySelector('.npf-combo-option.is-active')!.textContent).toBe('zane/swing');
    key('ArrowUp');
    expect(key('Enter')).toBe(false);
    expect(picks[picks.length - 1]).toMatchObject({ fullName: 'zane/proj-jumpy-badger' });
  });

  it('picks nothing on Enter before a repository is highlighted', async () => {
    await render();
    act(() => search().focus());
    expect(key('Enter')).toBe(true);
    expect(picks).toEqual([]);
  });

  it('highlights the choice again when the typed text is cleared', async () => {
    await render();
    act(() => search().focus());
    type('chess');
    key('Enter');
    act(() => search().blur());
    act(() => search().focus());
    type('agi');
    expect(host.querySelector('.npf-combo-option.is-active')!.textContent).toBe('zane/agi');
    type('');
    expect(host.querySelector('.npf-combo-option.is-active')!.textContent).toBe('zane/chess');
    expect(key('Enter')).toBe(true);
    expect(picks.length).toBe(1);
  });

  it('closes when the field loses focus', async () => {
    await render();
    act(() => search().focus());
    act(() => search().blur());
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });

  it('keeps the inline list without the dropdown prop', async () => {
    await render(false);
    expect(host.querySelector('[role="combobox"]')).toBeNull();
    expect(host.querySelectorAll('.npf-repos .npf-repo').length).toBe(repos.length);
  });
});
