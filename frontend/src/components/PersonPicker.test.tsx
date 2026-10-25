// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const search = vi.hoisted(() => vi.fn());
vi.mock('../services/api', () => ({ usersApi: { search } }));

import { listPlacement, PersonPicker, PERSON_SEARCH_DEBOUNCE_MS } from './PersonPicker';
import { RECENT_PEOPLE_KEY } from '../utils/recentPeople';

let root: Root;
let el: HTMLDivElement;
const changes: [string, string | undefined][] = [];
const onSubmit = vi.fn();

function Harness() {
  const [value, setValue] = useState('');
  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit(value); }}>
      <PersonPicker value={value} onChange={(email, name) => { changes.push([email, name]); setValue(email); }} ariaLabel="Email" />
    </form>
  );
}

const input = () => el.querySelector('input') as HTMLInputElement;
const options = () => [...document.querySelectorAll('[role=option]')].map(o => o.querySelector('.person-picker-email')!.textContent);
const key = (k: string) => act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
async function type(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => { setter.call(input(), value); input().dispatchEvent(new Event('input', { bubbles: true })); });
}
const settle = () => act(async () => { vi.advanceTimersByTime(PERSON_SEARCH_DEBOUNCE_MS); await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers();
  search.mockReset();
  changes.length = 0;
  onSubmit.mockReset();
  localStorage.clear();
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); vi.useRealTimers(); });

const mount = () => act(() => root.render(<Harness />));

describe('PersonPicker', () => {
  it('offers this browser\'s recent people on focus, before anything is typed or asked', async () => {
    localStorage.setItem(RECENT_PEOPLE_KEY, JSON.stringify([
      { email: 'gus@x.test', displayName: 'Gus', at: 2 }, { email: 'ada@x.test', displayName: 'Ada Lovelace', at: 1 },
    ]));
    mount();
    await act(async () => { input().focus(); });
    expect(options()).toEqual(['gus@x.test', 'ada@x.test']);
    expect(input().getAttribute('aria-expanded')).toBe('true');
    await type('l');
    expect(options()).toEqual(['ada@x.test']);
    await settle();
    expect(search).not.toHaveBeenCalled();
  });

  it('asks the server after a pause, recent people first and nobody twice, and fills in the pick', async () => {
    localStorage.setItem(RECENT_PEOPLE_KEY, JSON.stringify([{ email: 'sam@x.test', displayName: 'Sam', at: 1 }]));
    search.mockResolvedValue([{ email: 'SAM@x.test', displayName: 'Sam' }, { email: 'samir@x.test', displayName: 'Samir K' }]);
    mount();
    await act(async () => { input().focus(); });
    await type('s');
    await type('sa');
    expect(search).not.toHaveBeenCalled();
    await settle();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('sa');
    expect(options()).toEqual(['sam@x.test', 'samir@x.test']);
    await key('ArrowDown');
    await key('Enter');
    expect(changes[changes.length - 1]).toEqual(['samir@x.test', 'Samir K']);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(document.querySelector('[role=listbox]')).toBeNull();
  });

  it('lets a slow early answer never replace a later one', async () => {
    let early!: (v: unknown) => void;
    search.mockImplementationOnce(() => new Promise(r => { early = r; }));
    search.mockResolvedValueOnce([{ email: 'gwen@x.test', displayName: 'Gwen' }]);
    mount();
    await act(async () => { input().focus(); });
    await type('gu');
    await settle();
    await type('gw');
    await settle();
    await act(async () => { early([{ email: 'gus@x.test', displayName: 'Gus' }]); await Promise.resolve(); });
    expect(options()).toEqual(['gwen@x.test']);
  });

  it('submits whatever is typed when no suggestion is highlighted, and Escape closes only the list', async () => {
    search.mockResolvedValue([{ email: 'zed@x.test', displayName: 'Zed' }]);
    mount();
    await act(async () => { input().focus(); });
    await type('ze');
    await settle();
    let escapeKeptDialog = false;
    el.addEventListener('keydown', e => { if (e.key === 'Escape') escapeKeptDialog = e.defaultPrevented; });
    await key('Escape');
    expect(escapeKeptDialog).toBe(true);
    expect(document.querySelector('[role=listbox]')).toBeNull();
    await type('nobody@x.test');
    await settle();
    await act(async () => { (el.querySelector('form') as HTMLFormElement).requestSubmit(); });
    expect(onSubmit).toHaveBeenCalledWith('nobody@x.test');
  });

  it('shows no list that only repeats what was typed, and none when the search fails', async () => {
    search.mockResolvedValueOnce([{ email: 'ada@x.test', displayName: 'Ada' }]).mockRejectedValueOnce(new Error('429'));
    mount();
    await act(async () => { input().focus(); });
    await type('ada@x.test');
    await settle();
    expect(document.querySelector('[role=listbox]')).toBeNull();
    await type('bo');
    await settle();
    expect(document.querySelector('[role=listbox]')).toBeNull();
  });

  it('places the list under the field, or over it when the room below is short and more is above', () => {
    const at = (top: number) => ({ left: 10, top, bottom: top + 30, width: 300 });
    expect(listPlacement(at(100), 800)).toEqual({ left: 10, width: 300, top: 134, maxHeight: 260 });
    expect(listPlacement(at(700), 800)).toEqual({ left: 10, width: 300, bottom: 104, maxHeight: 260 });
    expect(listPlacement(at(100), 280)).toEqual({ left: 10, width: 300, top: 134, maxHeight: 142 }); // short below, but less above
    expect(listPlacement(at(40), 120)).toEqual({ left: 10, width: 300, top: 74, maxHeight: 80 });
  });

  it('puts the list on <body>, out of any scrolling pane the field sits in', async () => {
    search.mockResolvedValue([{ email: 'kim@x.test', displayName: 'Kim' }]);
    mount();
    await act(async () => { input().focus(); });
    await type('ki');
    await settle();
    const list = document.querySelector('[role=listbox]') as HTMLElement;
    expect(list.parentElement).toBe(document.body);
    expect(el.contains(list)).toBe(false);
    expect(input().getAttribute('aria-controls')).toBe(list.id);
  });

  it('a click on a suggestion picks it', async () => {
    search.mockResolvedValue([{ email: 'kim@x.test', displayName: 'Kim' }]);
    mount();
    await act(async () => { input().focus(); });
    await type('ki');
    await settle();
    await act(async () => { (document.querySelector('[role=option]') as HTMLElement).click(); });
    expect(changes[changes.length - 1]).toEqual(['kim@x.test', 'Kim']);
  });
});
