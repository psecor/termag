// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnvironmentView } from '../../services/api';
import { EnvironmentSelect } from './EnvironmentSelect';

const base = { createdAt: '', updatedAt: '', createdBy: null, updatedBy: null, visibility: 'personal' as const, owner: null };
const environments: EnvironmentView[] = [
  { ...base, id: 'e1', name: 'full-stack', kind: 'inline', definition: { repos: [{ repo: 'acme/web' }, 'acme/api'] } },
  { ...base, visibility: 'shared', id: 'e2', name: 'shop', kind: 'pointer', file: { repo: 'acme/shop', branch: null, path: '.termag/environment.json' } },
];

let root: Root;
let host: HTMLDivElement;
let picked: Array<string | null>;
let path: string;

function Where() {
  path = useLocation().pathname;
  return null;
}

function render(list: readonly EnvironmentView[], value: string | null, menuEpoch = 0) {
  act(() => root.render(
    <MemoryRouter initialEntries={['/chat/new']}>
      <EnvironmentSelect environments={list} value={value} menuEpoch={menuEpoch} onChange={n => picked.push(n)} />
      <Where />
    </MemoryRouter>,
  ));
}

const trigger = () => host.querySelector('.chat-env-trigger') as HTMLButtonElement;
const open = () => act(() => { trigger().click(); });
/** The dialog is portaled to the body, outside the host. */
const dialog = () => document.querySelector('.chat-env-dialog') as HTMLElement | null;

/** A row's name, without its decorative mark. */
function nameOf(o: Element): string {
  const el = o.querySelector('.chat-launch-box-name')!.cloneNode(true) as HTMLElement;
  el.querySelectorAll('[aria-hidden="true"]').forEach(n => n.remove());
  return el.textContent ?? '';
}
const rows = () => [...dialog()!.querySelectorAll('.chat-launch-box')];
function row(name: string): HTMLButtonElement {
  const found = rows().find(o => nameOf(o) === name);
  if (!found) throw new Error(`missing row ${name}`);
  return found as HTMLButtonElement;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  picked = [];
  path = '';
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('EnvironmentSelect', () => {
  it('with no environment yet is still a trigger, whose dialog offers No environment and New environment', () => {
    render([], null);
    expect(trigger().textContent).toBe('No environment');
    expect(trigger().className).toContain('chat-launch-trigger');
    expect(dialog()).toBeNull();
    open();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.querySelector('h2, [id]')?.textContent).toBe('Environment');
    expect(dialog()!.querySelector('.chat-launch-dialog-note')?.textContent).toContain('repositories a session clones');
    expect(rows().map(nameOf)).toEqual(['No environment', 'New environment']);
    expect(row('No environment').getAttribute('aria-checked')).toBe('true');
    // No group heading over an empty list.
    expect(dialog()!.querySelector('.chat-menu-heading')).toBeNull();
    // New environment is an action, not a choice.
    expect(row('New environment').getAttribute('role')).toBeNull();
    expect(row('New environment').querySelector('small')?.textContent).toBe('Opens the Environments page to make one');
  });

  it('lists the personal environments, then the shared ones, each with its repositories or its file, the chosen one checked', () => {
    render([...environments].reverse(), 'shop');
    expect(trigger().textContent).toBe('shop');
    open();
    expect(rows().map(nameOf)).toEqual(['No environment', 'full-stack', 'shop', 'New environment']);
    expect([...dialog()!.querySelectorAll('.chat-menu-heading')].map(h => h.textContent)).toEqual(['Personal', 'Shared']);
    expect(row('full-stack').querySelector('small')?.textContent).toBe('acme/web, acme/api');
    expect(row('shop').querySelector('small')?.textContent).toBe('From acme/shop : default branch : .termag/environment.json');
    expect(row('shop').getAttribute('aria-checked')).toBe('true');
    expect(row('full-stack').getAttribute('aria-checked')).toBe('false');
    expect(row('No environment').getAttribute('aria-checked')).toBe('false');
  });

  it('draws no mark on any row: no swatch, dashed square or +, so nothing reads as a checkbox; the selection is the card\'s checked style', () => {
    render(environments, 'shop');
    open();
    for (const r of rows()) {
      const name = r.querySelector('.chat-launch-box-name')!;
      expect(name.querySelector('[aria-hidden="true"]'), nameOf(r)).toBeNull();
      expect(name.textContent, nameOf(r)).toBe(nameOf(r));
      // A row with no mark does not indent its line past one.
      expect(r.classList.contains('chat-launch-choice-marked'), nameOf(r)).toBe(false);
    }
    expect(dialog()!.querySelector('.space-swatch, .chat-space-plus')).toBeNull();
    expect(row('New environment').textContent).toBe('New environmentOpens the Environments page to make one');
    expect(row('shop').getAttribute('aria-checked')).toBe('true');
    expect(row('full-stack').getAttribute('aria-checked')).toBe('false');
  });

  it('picking an environment, or No environment, sets it and closes the dialog', () => {
    render(environments, null);
    open();
    act(() => { row('full-stack').click(); });
    expect(picked).toEqual(['full-stack']);
    expect(dialog()).toBeNull();
    render(environments, 'full-stack');
    open();
    act(() => { row('No environment').click(); });
    expect(picked).toEqual(['full-stack', null]);
    expect(dialog()).toBeNull();
  });

  it('New environment opens the new-environment page, and Manage environments the list', () => {
    render([], null);
    open();
    act(() => { row('New environment').click(); });
    expect(path).toBe('/chat/environments/new');
    expect(dialog()).toBeNull();
    expect(picked).toEqual([]);
    render(environments, null);
    open();
    const manage = [...dialog()!.querySelectorAll('button')].find(b => b.textContent === 'Manage environments')!;
    act(() => { manage.click(); });
    expect(path).toBe('/chat/environments');
    expect(dialog()).toBeNull();
  });

  it('Done closes it unchanged, and so does a bump of the page\'s menu epoch', () => {
    render(environments, null);
    open();
    const done = [...dialog()!.querySelectorAll('button')].find(b => b.textContent === 'Done')!;
    act(() => { done.click(); });
    expect(dialog()).toBeNull();
    expect(picked).toEqual([]);
    open();
    render(environments, null, 1);
    expect(dialog()).toBeNull();
  });

  it('does not open while disabled', () => {
    act(() => root.render(
      <MemoryRouter><EnvironmentSelect environments={environments} value={null} disabled onChange={() => {}} /></MemoryRouter>,
    ));
    expect(trigger().disabled).toBe(true);
    act(() => { trigger().click(); });
    expect(dialog()).toBeNull();
  });

  describe('with many environments', () => {
    const many: EnvironmentView[] = Array.from({ length: 60 }, (_, i) => ({
      ...base, id: `m${i + 1}`, name: `env-${String(i + 1).padStart(2, '0')}`, kind: 'inline' as const, definition: { repos: [`acme/repo-${i + 1}`] },
    }));
    const envNames = () => rows().map(nameOf).filter(n => n.startsWith('env-'));
    const search = () => dialog()!.querySelector('input') as HTMLInputElement;
    const list = () => dialog()!.querySelector('.chat-env-list') as HTMLElement;
    const button = (name: string) => [...dialog()!.querySelectorAll('button')].find(b => b.textContent === name) as HTMLButtonElement;
    function type(text: string) {
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search(), text);
        search().dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    function key(el: Element, k: string) {
      act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
    }
    let scrolled: Element[];
    const realScroll = Element.prototype.scrollIntoView;
    beforeEach(() => {
      scrolled = [];
      // jsdom has no layout, so scrolling is recorded, not done.
      Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    });
    afterEach(() => { Element.prototype.scrollIntoView = realScroll; });

    it('lists all of them in one scrolling list, with No environment above it and New environment below it, and no paging', () => {
      render(many, null);
      open();
      expect(envNames()).toEqual(many.map(e => e.name));
      expect(list().classList.contains('scroll-list')).toBe(true);
      expect([...list().querySelectorAll('.chat-launch-box')].map(nameOf)).toEqual(many.map(e => e.name));
      // Always in view: outside the scrolling list.
      expect(list().contains(row('No environment'))).toBe(false);
      expect(list().contains(row('New environment'))).toBe(false);
      expect(rows().map(nameOf)[0]).toBe('No environment');
      expect(rows().map(nameOf).at(-1)).toBe('New environment');
      expect(dialog()!.querySelector('.chat-env-pages')).toBeNull();
      expect([...dialog()!.querySelectorAll('button')].map(b => b.textContent)).not.toContain('Next');
    });

    it('scrolls the selected environment into view when it opens', () => {
      render(many, 'env-48');
      open();
      expect(scrolled).toEqual([row('env-48')]);
    });

    it('scrolls nothing with No environment selected', () => {
      render(many, null);
      open();
      expect(scrolled).toEqual([]);
    });

    it('opens with the search focused, and searches by name and by repository', () => {
      render(many, null);
      open();
      expect(document.activeElement).toBe(search());
      type('repo-5');
      expect(envNames()).toEqual(['env-05', ...Array.from({ length: 10 }, (_, i) => `env-5${i}`)]);
      type('env-3');
      expect(envNames()).toEqual(Array.from({ length: 10 }, (_, i) => `env-3${i}`));
      type('repo-42');
      expect(envNames()).toEqual(['env-42']);
    });

    it('says when nothing matches, and still offers New environment', () => {
      render(many, null);
      open();
      type('zzz');
      expect(envNames()).toEqual([]);
      expect(dialog()!.querySelector('.chat-env-empty')?.textContent).toBe('No environment matches “zzz”');
      expect(rows().map(nameOf)).toEqual(['No environment', 'New environment']);
    });

    it('pins the selected environment under Selected only while the search filters it out', () => {
      render(many, 'env-42');
      open();
      // Unfiltered it is in the list (scrolled to), not pinned.
      expect(dialog()!.querySelector('.chat-env-pinned')).toBeNull();
      expect(envNames().filter(n => n === 'env-42')).toHaveLength(1);
      type('repo-7');
      const pinned = dialog()!.querySelector('.chat-env-pinned')!;
      expect(pinned.querySelector('.chat-menu-heading')?.textContent).toBe('Selected');
      expect(list().contains(pinned)).toBe(false);
      expect(row('env-42').getAttribute('aria-checked')).toBe('true');
      expect(envNames()).toEqual(['env-42', 'env-07']);
      type('repo-42');
      expect(dialog()!.querySelector('.chat-env-pinned')).toBeNull();
      act(() => { row('env-42').click(); });
      expect(picked).toEqual(['env-42']);
    });

    it('arrow keys move from the search through the results and back; typing on a result goes to the search', () => {
      render(many, null);
      open();
      key(search(), 'ArrowDown');
      expect(document.activeElement).toBe(row('No environment'));
      key(document.activeElement!, 'ArrowDown');
      expect(document.activeElement).toBe(row('env-01'));
      key(document.activeElement!, 'ArrowDown');
      expect(document.activeElement).toBe(row('env-02'));
      key(document.activeElement!, 'ArrowUp');
      key(document.activeElement!, 'ArrowUp');
      expect(document.activeElement).toBe(row('No environment'));
      key(document.activeElement!, 'ArrowUp');
      expect(document.activeElement).toBe(search());
      act(() => { row('env-03').focus(); });
      key(document.activeElement!, 'r');
      expect(document.activeElement).toBe(search());
      expect(search().value).toBe('r');
    });

    it('arrow keys reach New environment past the last result, and typing on Done goes to the search', () => {
      render(many, null);
      open();
      act(() => { row('env-60').focus(); });
      key(document.activeElement!, 'ArrowDown');
      expect(document.activeElement).toBe(row('New environment'));
      act(() => { button('Done').focus(); });
      key(button('Done'), 'e');
      expect(document.activeElement).toBe(search());
      expect(search().value).toBe('e');
    });
  });

  it("the list's scroll is App.css's shared .scroll-list: a max height and its own scroll", () => {
    // jsdom does no layout, so the rule that makes it scroll is pinned from the stylesheet.
    const css = readFileSync(join(__dirname, '../../App.css'), 'utf8');
    const rule = /^\.scroll-list \{([^}]*)\}/m.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/max-height: min\(40vh, 320px\)/);
    expect(rule).toMatch(/overflow-y: auto/);
  });
});
