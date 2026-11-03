// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoPick } from '../../utils/repoPick';
import { toggleRepo, type RepoSelection } from '../../utils/multiRepo';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../services/api', () => ({ githubReposApi: { list: mocks.list } }));

import { RepoPicker } from './RepoPicker';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATALOG = {
  status: 'ok',
  groups: [{ owner: 'acme', kind: 'org', status: 'ok', repos: [{ fullName: 'acme/api', defaultBranch: 'main' }, { fullName: 'acme/web', defaultBranch: 'trunk' }] }],
};

const THREE = {
  status: 'ok',
  groups: [{ owner: 'acme', kind: 'org', status: 'ok', repos: [
    { fullName: 'acme/api', defaultBranch: 'main' },
    { fullName: 'acme/docs', defaultBranch: 'main' },
    { fullName: 'acme/web', defaultBranch: 'trunk' },
  ] }],
};

let root: Root;
let host: HTMLDivElement;
let picks: RepoPick[];

function Harness({ initial }: { initial: RepoPick }) {
  const [pick, setPick] = useState<RepoPick>(initial);
  const [open, setOpen] = useState(false);
  return <RepoPicker pick={pick} onPick={p => { picks.push(p); setPick(p); }} open={open} onOpenChange={setOpen} />;
}

function MultiHarness() {
  const [selection, setSelection] = useState<RepoSelection>({ pick: { kind: 'empty' }, more: [] });
  const [open, setOpen] = useState(true);
  return (
    <RepoPicker
      pick={selection.pick}
      more={selection.more}
      onPick={p => setSelection({ pick: p, more: [] })}
      onToggle={repo => setSelection(s => toggleRepo(s, repo))}
      open={open}
      onOpenChange={setOpen}
    />
  );
}

async function renderMulti() {
  await act(async () => { root.render(<MultiHarness />); });
}

async function render(initial: RepoPick = { kind: 'empty' }) {
  await act(async () => { root.render(<Harness initial={initial} />); });
}

const trigger = () => host.querySelector<HTMLButtonElement>('.chat-compose-repo-btn')!;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  picks = [];
  mocks.list.mockReset().mockResolvedValue(CATALOG);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('RepoPicker', () => {
  it('loads the catalog once, names the pick, and lists repositories by owner when open', async () => {
    await render();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith(false);
    expect(trigger().textContent).toBe('Choose a repository');
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    await click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.chat-compose-owner')?.textContent).toBe('acme');
    expect([...host.querySelectorAll('[role="option"]')].map(o => o.textContent)).toEqual(['acme/api', 'acme/web']);
  });

  it('picks a listed repository and closes', async () => {
    await render();
    await click(trigger());
    await click(host.querySelectorAll('[role="option"]')[1]);
    expect(picks).toEqual([{ kind: 'listed', fullName: 'acme/web', defaultBranch: 'trunk' }]);
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(trigger().textContent).toBe('acme/web');
  });

  it('filters by the search', async () => {
    await render();
    await click(trigger());
    type(host.querySelector<HTMLInputElement>('input[aria-label="Search repositories"]')!, 'WEB');
    expect([...host.querySelectorAll('[role="option"]')].map(o => o.textContent)).toEqual(['acme/web']);
  });

  it('turns a pasted URL into a pick, and an emptied one back into none', async () => {
    await render();
    await click(trigger());
    const url = host.querySelector<HTMLInputElement>('input[aria-label="Repository URL"]')!;
    type(url, 'https://github.com/acme/tools');
    type(url, '  ');
    expect(picks).toEqual([{ kind: 'pasted', url: 'https://github.com/acme/tools' }, { kind: 'empty' }]);
  });

  it('opens with a pasted pick in the URL field', async () => {
    await render({ kind: 'pasted', url: 'https://github.com/acme/tools' });
    await click(trigger());
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Repository URL"]')!.value).toBe('https://github.com/acme/tools');
  });

  it('offers a retry when the catalog cannot load, and refreshes on it', async () => {
    mocks.list.mockRejectedValueOnce(new Error('down'));
    await render();
    await click(trigger());
    const retry = host.querySelector('.chat-compose-retry');
    expect(retry).not.toBeNull();
    await click(retry!);
    expect(mocks.list).toHaveBeenLastCalledWith(true);
    expect(host.querySelectorAll('[role="option"]')).toHaveLength(2);
  });

  it('has no Selected group or multi-select without onToggle, even with a pick', async () => {
    await render({ kind: 'listed', fullName: 'acme/web', defaultBranch: 'trunk' });
    await click(trigger());
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(host.querySelectorAll('[role="listbox"]')).toHaveLength(1);
    expect(host.querySelector('[role="listbox"]')!.hasAttribute('aria-multiselectable')).toBe(false);
    expect(host.querySelector('[data-lp-indicator="checkbox"]')).toBeNull();
    expect([...host.querySelectorAll('[role="option"]')].map(o => o.textContent)).toEqual(['acme/api', 'acme/web']);
  });

  describe('with onToggle (LaunchPad ListBox)', () => {
    const section = (name: string) => [...host.querySelectorAll('[role="group"]')]
      .find(g => document.getElementById(g.getAttribute('aria-labelledby') ?? '')?.textContent === name);
    const namesIn = (el: Element | undefined) => [...(el?.querySelectorAll('[role="option"]') ?? [])].map(o => o.textContent);
    const selectedNames = () => namesIn(section('Selected'));
    const listedNames = () => namesIn(section('acme'));
    const row = (fullName: string) => host.querySelector<HTMLElement>(`[role="option"][data-repo="${fullName}"]`)!;
    const toggle = (fullName: string) => click(row(fullName));
    const listbox = () => host.querySelector('[role="listbox"]');
    const search = () => host.querySelector<HTMLInputElement>('input[aria-label="Search repositories"]')!;
    const key = (el: Element, k: string, init: KeyboardEventInit = {}) => act(() => {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true, ...init }));
    });
    const focusRow = (fullName: string) => act(() => { row(fullName).focus(); });

    beforeEach(() => {
      mocks.list.mockResolvedValue(THREE);
      // React Aria escapes ids with CSS.escape, which jsdom lacks.
      const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
      if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
    });

    it('is one multi-select listbox, whose rows carry LaunchPad\'s check box', async () => {
      await renderMulti();
      expect(host.querySelectorAll('[role="listbox"]')).toHaveLength(1);
      expect(listbox()!.getAttribute('aria-multiselectable')).toBe('true');
      expect(row('acme/web').getAttribute('aria-selected')).toBe('false');
      expect(row('acme/web').querySelector('[data-lp-indicator="checkbox"]')).not.toBeNull();
      expect(row('acme/web').querySelector('[data-lp-indicator="checkbox"] svg')).toBeNull();
      await toggle('acme/web');
      expect(row('acme/web').getAttribute('aria-selected')).toBe('true');
      expect(row('acme/web').querySelector('[data-lp-indicator="checkbox"] svg')).not.toBeNull();
    });

    it('toggles on a click anywhere on the row and keeps the menu open', async () => {
      await renderMulti();
      await toggle('acme/web');
      expect(listbox()).not.toBeNull();
      expect(trigger().textContent).toBe('acme/web');
      await toggle('acme/api');
      expect(listbox()).not.toBeNull();
      expect(trigger().textContent).toBe('acme/web + api');
      await toggle('acme/web');
      expect(trigger().textContent).toBe('acme/api');
    });

    it('pins chosen repositories in a Selected section at the top in the order chosen, and returns an unchosen one to its owner', async () => {
      await renderMulti();
      expect(section('Selected')).toBeUndefined();

      await toggle('acme/web');
      await toggle('acme/api');
      expect(selectedNames()).toEqual(['acme/web', 'acme/api']);
      expect(listedNames()).toEqual(['acme/docs']);

      await toggle('acme/web');
      expect(selectedNames()).toEqual(['acme/api']);
      expect(listedNames()).toEqual(['acme/docs', 'acme/web']);
    });

    it('keeps the Selected section whole while the search filters the list', async () => {
      await renderMulti();
      await toggle('acme/web');
      type(search(), 'api');
      expect(selectedNames()).toEqual(['acme/web']);
      expect(listedNames()).toEqual(['acme/api']);
    });

    it('toggles the focused row with Space or Enter, and focus follows it into and out of Selected', async () => {
      await renderMulti();
      await focusRow('acme/docs');
      key(row('acme/docs'), ' ');
      expect(selectedNames()).toEqual(['acme/docs']);
      expect(document.activeElement).toBe(row('acme/docs'));
      key(row('acme/docs'), 'Enter');
      expect(section('Selected')).toBeUndefined();
      expect(document.activeElement).toBe(row('acme/docs'));
      expect(listbox()).not.toBeNull();
    });

    it('moves between the search and the rows with the arrow keys', async () => {
      await renderMulti();
      search().focus();
      key(search(), 'ArrowDown');
      expect(document.activeElement).toBe(row('acme/api'));
      key(document.activeElement!, 'ArrowDown');
      expect(document.activeElement).toBe(row('acme/docs'));
      key(document.activeElement!, 'End');
      expect(document.activeElement).toBe(row('acme/web'));
      key(document.activeElement!, 'Home');
      expect(document.activeElement).toBe(row('acme/api'));
      key(document.activeElement!, 'ArrowUp');
      expect(document.activeElement).toBe(search());
    });

    it('ignores a select-all', async () => {
      await renderMulti();
      await focusRow('acme/api');
      key(row('acme/api'), 'a', { ctrlKey: true });
      expect(section('Selected')).toBeUndefined();
      expect(trigger().textContent).toBe('Choose a repository');
    });

    it('closes on Enter in the search, keeping the choice, and returns focus to the pill', async () => {
      await renderMulti();
      await toggle('acme/web');
      await toggle('acme/api');
      key(search(), 'Enter');
      expect(listbox()).toBeNull();
      expect(trigger().textContent).toBe('acme/web + api');
      expect(document.activeElement).toBe(trigger());
    });

    it('closes on Escape from a row without clearing the choice', async () => {
      await renderMulti();
      await toggle('acme/web');
      await focusRow('acme/web');
      key(row('acme/web'), 'Escape');
      expect(listbox()).toBeNull();
      expect(trigger().textContent).toBe('acme/web');
      expect(document.activeElement).toBe(trigger());
    });

    it('lists an owner it could not read below the rows, with its note', async () => {
      mocks.list.mockResolvedValue({
        status: 'ok',
        groups: [THREE.groups[0], { owner: 'locked', kind: 'org', status: 'sso-required', repos: [] }],
      });
      await renderMulti();
      expect(listbox()!.textContent).not.toContain('locked');
      const owner = [...host.querySelectorAll('.chat-compose-owner')].find(o => o.textContent === 'locked');
      expect(owner).toBeDefined();
      expect(owner!.nextElementSibling?.classList.contains('chat-compose-note')).toBe(true);
      expect(owner!.nextElementSibling?.textContent).not.toBe('');
    });
  });
});
