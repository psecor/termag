// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const search = vi.hoisted(() => vi.fn());
vi.mock('../services/api', () => ({ usersApi: { search } }));

import { TeammatePicker, type PickedPerson } from './TeammatePicker';
import { PERSON_SEARCH_DEBOUNCE_MS } from '../hooks/usePeopleSuggestions';
import { RECENT_PEOPLE_KEY } from '../utils/recentPeople';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let el: HTMLDivElement;
let current: PickedPerson[] = [];
const outerKeys: string[] = [];

function Harness({ initial = [] }: { initial?: PickedPerson[] }) {
  const [value, setValue] = useState(initial);
  current = value;
  // Stands in for the Share dialog, which closes on an Escape that reaches it.
  return <div onKeyDown={e => { if (!e.defaultPrevented) outerKeys.push(e.key); }}><TeammatePicker value={value} onChange={setValue} /></div>;
}

const input = () => el.querySelector('input') as HTMLInputElement;
const options = () => [...document.querySelectorAll('.preview-links-people-popover [role="option"]')].map(o => o.querySelector('[slot="label"]')?.textContent).filter(Boolean);
const emptyShown = () => document.querySelector('.preview-links-people-empty')?.textContent;
const tags = () => [...el.querySelectorAll('.preview-links-people-tags [role="row"]')].map(t => t.textContent);
const key = (k: string) => act(async () => {
  input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  input().dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));
});
async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })); });
}
const settle = () => act(async () => { vi.advanceTimersByTime(PERSON_SEARCH_DEBOUNCE_MS); await Promise.resolve(); await Promise.resolve(); });
const focus = () => act(async () => { input().focus(); });
const clickOption = (label: string) => act(async () => {
  const o = [...document.querySelectorAll('.preview-links-people-popover [role="option"]')].find(x => x.querySelector('[slot="label"]')?.textContent === label) as HTMLElement;
  o.click();
});

beforeEach(() => {
  vi.useFakeTimers();
  search.mockReset().mockResolvedValue([]);
  localStorage.clear();
  outerKeys.length = 0;
  current = [];
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); vi.useRealTimers(); });

const mount = (initial?: PickedPerson[]) => act(() => root.render(<Harness initial={initial} />));

describe('TeammatePicker', () => {
  it('offers recent people on focus, then whoever the search finds, and picks several as tags', async () => {
    localStorage.setItem(RECENT_PEOPLE_KEY, JSON.stringify([{ email: 'gus@x.test', displayName: 'Gus Grissom', at: 1 }]));
    search.mockResolvedValue([{ email: 'ana@x.test', displayName: 'Ana Ng' }, { email: 'gus@x.test', displayName: 'Gus Grissom' }]);
    mount();
    await focus();
    expect(options()).toEqual(['Gus Grissom']);
    expect(document.querySelector('.preview-links-people-popover')?.classList.contains('lp-theme')).toBe(true);
    await clickOption('Gus Grissom');
    expect(current).toEqual([{ email: 'gus@x.test', displayName: 'Gus Grissom' }]);
    expect(input().value).toBe('');

    await type('an');
    await settle();
    expect(search).toHaveBeenCalledWith('an');
    // Gus is picked already: offered once, and not again.
    expect(options()).toEqual(['Ana Ng']);
    await key('ArrowDown');
    await key('Enter');
    expect(current.map(p => p.email)).toEqual(['gus@x.test', 'ana@x.test']);
    expect(tags()).toEqual(['Gus Grissomgus@x.test', 'Ana Ngana@x.test']);
  });

  it('removes a tag with its button, and the last one with Backspace in the empty field', async () => {
    mount([{ email: 'gus@x.test', displayName: 'Gus' }, { email: 'ana@x.test', displayName: 'Ana' }, { email: 'bo@x.test', displayName: '' }]);
    await act(async () => { (el.querySelector('.preview-links-people-tags [role="row"] button[aria-label="Remove"]') as HTMLButtonElement).click(); });
    expect(current.map(p => p.email)).toEqual(['ana@x.test', 'bo@x.test']);
    await focus();
    await type('x');
    await key('Backspace');
    expect(current).toHaveLength(2);
    await type('');
    await key('Backspace');
    expect(current.map(p => p.email)).toEqual(['ana@x.test']);
  });

  it('adds a full typed email no one matches, by Enter or its option, lowercased and once', async () => {
    mount();
    await focus();
    await type('Zed@Y.test');
    await settle();
    expect(options()).toEqual(['Add zed@y.test']);
    await key('Enter');
    expect(current).toEqual([{ email: 'zed@y.test', displayName: '' }]);
    await type('zed@y.test, Kim@y.test');
    expect(options()).toEqual(['Add kim@y.test']);
    await clickOption('Add kim@y.test');
    expect(current.map(p => p.email)).toEqual(['zed@y.test', 'kim@y.test']);
    await type('ZED@y.test');
    expect(options()).toEqual([]);
    expect(emptyShown()).toContain('type their full email');
    await key('Enter');
    expect(current.map(p => p.email)).toEqual(['zed@y.test', 'kim@y.test']);
  });

  it('a pasted email after a mouse pick is still added by Enter', async () => {
    localStorage.setItem(RECENT_PEOPLE_KEY, JSON.stringify([{ email: 'gus@x.test', displayName: 'Gus', at: 1 }]));
    mount();
    await focus();
    await clickOption('Gus');
    await type('pat@x.test');
    await key('Enter');
    expect(current.map(p => p.email)).toEqual(['gus@x.test', 'pat@x.test']);
  });

  it('takes nothing that is not an email, and offers a found person by name rather than the bare email', async () => {
    search.mockResolvedValue([{ email: 'ana@x.test', displayName: 'Ana Ng' }]);
    mount();
    await focus();
    await type('ana');
    await key('Enter');
    expect(current).toEqual([]);
    await type('ana@x.test');
    await settle();
    expect(options()).toEqual(['Ana Ng']);
    await key('Enter');
    expect(current).toEqual([{ email: 'ana@x.test', displayName: 'Ana Ng' }]);
  });

  it('Escape with something typed drops it and closes the list for good, without adding a full email or reaching the dialog', async () => {
    search.mockResolvedValue([{ email: 'kim@x.test', displayName: 'Kim' }]);
    mount();
    await focus();
    await type('ki');
    await settle();
    expect(options()).toEqual(['Kim']);
    await key('Escape');
    await settle();
    expect(input().value).toBe('');
    expect(input().getAttribute('aria-expanded')).not.toBe('true');
    expect(outerKeys).not.toContain('Escape');
    await type('kim@x.test');
    await key('Escape');
    expect(current).toEqual([]);
    expect(input().value).toBe('');
  });

  it('an Escape is over once its key is up: an email pasted afterwards is still added on blur (Bugbot, #1758)', async () => {
    localStorage.setItem(RECENT_PEOPLE_KEY, JSON.stringify([{ email: 'gus@x.test', displayName: 'Gus', at: 1 }]));
    mount();
    await focus();
    await key('Escape');
    // A context-menu paste: no key goes down.
    await type('pat@x.test');
    await act(async () => { input().blur(); });
    expect(current.map(p => p.email)).toEqual(['pat@x.test']);
  });

  it('a full email typed and left is added on blur; other text is dropped', async () => {
    mount();
    await focus();
    await type('pat@x.test');
    await act(async () => { input().blur(); });
    expect(current.map(p => p.email)).toEqual(['pat@x.test']);
    await focus();
    await type('pa');
    await act(async () => { input().blur(); });
    expect(current.map(p => p.email)).toEqual(['pat@x.test']);
    expect(input().value).toBe('');
  });

  it('Escape closes the list, and only a second one reaches the dialog', async () => {
    localStorage.setItem(RECENT_PEOPLE_KEY, JSON.stringify([{ email: 'gus@x.test', displayName: 'Gus', at: 1 }]));
    mount();
    await focus();
    expect(options()).toEqual(['Gus']);
    await key('Escape');
    expect(options()).toEqual([]);
    expect(outerKeys).not.toContain('Escape');
    await key('Escape');
    expect(outerKeys).toContain('Escape');
  });
});
