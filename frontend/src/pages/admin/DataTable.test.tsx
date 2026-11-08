// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { DataTable, TableReset } = await import('./DataTable');
type Column<T> = import('./DataTable').Column<T>;

// Made-up hosts: host-001 … host-279, with a Claude Code version each.
interface Host { key: string; name: string; version: string }
const hosts = (n: number): Host[] => Array.from({ length: n }, (_, i) => ({
  key: `h${i + 1}`, name: `host-${String(i + 1).padStart(3, '0')}`, version: `2.1.${(i * 37) % 400}`,
}));
const cols: Column<Host>[] = [
  { id: 'name', label: 'host', value: h => h.name, render: h => <button type="button">{h.name}</button> },
  { id: 'version', label: 'claude', value: h => h.version },
];

let root: Root;
let el: HTMLDivElement;
beforeEach(() => {
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); window.localStorage.clear(); });

type Props = Partial<React.ComponentProps<typeof DataTable<Host>>>;
const render = (rows: Host[], props: Props = {}) => act(() => {
  root.render(<DataTable rows={rows} columns={cols} rowKey={h => h.key} defaultSort="name" defaultDesc={false} search="filter hosts" {...props} />);
});
const names = () => [...el.querySelectorAll('tbody tr td:first-child')].map(td => td.textContent);
const range = () => el.querySelector('.admin-pager-range')?.textContent ?? null;
const pager = () => el.querySelector('.admin-pager');
const press = (label: string) => act(() => { (el.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement).click(); });
const header = (label: string) => act(() => { ([...el.querySelectorAll('th')].find(th => th.textContent?.startsWith(label)) as HTMLElement).click(); });
async function pickSize(text: string) {
  await act(async () => { (pager()!.querySelector('button') as HTMLButtonElement).click(); });
  const option = [...document.querySelectorAll('[role="option"]')].find(o => o.textContent === text) as HTMLElement;
  await act(async () => { option.click(); });
}
function typeFilter(text: string) {
  const input = el.querySelector('input[type="search"]') as HTMLInputElement;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('DataTable paging', () => {
  it('shows no pager, and no filter, at 25 rows or fewer', () => {
    render(hosts(25));
    expect(names()).toHaveLength(25);
    expect(pager()).toBeNull();
    expect(el.querySelector('input[type="search"]')).toBeNull();
    render(hosts(26));
    expect(pager()).not.toBeNull();
    expect(el.querySelector('input[type="search"]')).not.toBeNull();
  });

  it('shows 25 of 279 rows, and pages with next, previous, last and first', () => {
    render(hosts(279));
    expect(names()).toHaveLength(25);
    expect(range()).toBe('1–25 of 279');
    press('next page');
    expect(range()).toBe('26–50 of 279');
    expect(names()[0]).toBe('host-026');
    press('last page');
    expect(range()).toBe('276–279 of 279');
    expect((el.querySelector('[aria-label="next page"]') as HTMLButtonElement).disabled).toBe(true);
    press('previous page');
    expect(range()).toBe('251–275 of 279');
    press('first page');
    expect(range()).toBe('1–25 of 279');
  });

  it('switches to 100 and to All, back on page 1, and remembers the size per table', async () => {
    render(hosts(279), { storageKey: 'fleet' });
    press('next page');
    await pickSize('100 per page');
    expect(range()).toBe('1–100 of 279');
    expect(names()).toHaveLength(100);
    expect(window.localStorage.getItem('termag.admin.pageSize.fleet')).toBe('100');
    await pickSize('All');
    expect(names()).toHaveLength(279);
    expect(range()).toBe('1–279 of 279');
    expect(el.querySelector('[aria-label="next page"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(el);
    render(hosts(279), { storageKey: 'fleet' });
    expect(names()).toHaveLength(279);
  });

  it('sorts the whole set by version, then pages, and goes back to page 1', () => {
    render(hosts(279));
    press('next page');
    header('claude');
    expect(range()).toBe('1–25 of 279');
    const top = [...el.querySelectorAll('tbody tr td:nth-child(2)')].map(td => td.textContent);
    // Descending first: 2.1.399 is the newest of all 279, and 2.1.318 sorts above 2.1.99.
    expect(top[0]).toBe('2.1.399');
    header('claude');
    const bottom = [...el.querySelectorAll('tbody tr td:nth-child(2)')].map(td => td.textContent);
    expect(bottom[0]).toBe('2.1.0');
    expect(bottom.indexOf('2.1.9')).toBeLessThan(bottom.indexOf('2.1.10'));
  });

  it('filters on the visible text, counts from all rows, and goes back to page 1', () => {
    render(hosts(279));
    press('next page');
    typeFilter('host-1');
    // host-100 … host-199
    expect(range()).toBe('1–25 of 100, filtered from 279');
    expect(names()[0]).toBe('host-100');
    typeFilter('host-27');
    expect(names()).toEqual(['host-270', 'host-271', 'host-272', 'host-273', 'host-274', 'host-275', 'host-276', 'host-277', 'host-278', 'host-279']);
    expect(pager()).toBeNull();
    typeFilter('nothing-like-this');
    expect(el.querySelector('tbody')!.textContent).toContain('nothing matches');
  });

  it('keeps the page, sort and filter through a poll refresh, and goes to page 1 when the page’s own filters change', () => {
    render(hosts(279), { resetKey: ['all', false] });
    header('claude');
    press('next page');
    press('next page');
    const before = names();
    expect(range()).toBe('51–75 of 279');
    // A poll: the same rows in new objects.
    render(hosts(279).map(h => ({ ...h })), { resetKey: ['all', false] });
    expect(range()).toBe('51–75 of 279');
    expect(names()).toEqual(before);
    // A refresh that briefly has fewer rows shows the last page, and the page comes back with them.
    render(hosts(30), { resetKey: ['all', false] });
    expect(range()).toBe('26–30 of 30');
    render(hosts(279), { resetKey: ['all', false] });
    expect(range()).toBe('51–75 of 279');
    render(hosts(279), { resetKey: ['box', true] });
    expect(range()).toBe('1–25 of 279');
  });

  it('shows every loaded row, with no pager, for a table that pages on the server', () => {
    render(hosts(279), { paginate: false, storageKey: 'signals' });
    expect(names()).toHaveLength(279);
    expect(pager()).toBeNull();
  });

  it('goes to page 1 when a TableReset around it changes (a page\'s window, a shell\'s range), and not on a poll', () => {
    const at = (outer: unknown, inner: unknown, rows = hosts(279)) => act(() => {
      root.render(<TableReset value={outer}><TableReset value={inner}>
        <DataTable rows={rows} columns={cols} rowKey={h => h.key} defaultSort="name" defaultDesc={false} />
      </TableReset></TableReset>);
    });
    at('7d', 30);
    press('next page');
    press('next page');
    expect(range()).toBe('51–75 of 279');
    at('7d', 30, hosts(279).map(h => ({ ...h })));
    expect(range()).toBe('51–75 of 279');
    at('7d', 7);
    expect(range()).toBe('1–25 of 279');
    press('next page');
    at('30d', 7);
    expect(range()).toBe('1–25 of 279');
  });

  it('opens on the page of a row selected from outside', () => {
    render([], { selectedKey: 'h200' });
    render(hosts(279), { selectedKey: 'h200' });
    expect(range()).toBe('176–200 of 279');
    expect(el.querySelector('tr.admin-row--selected')?.textContent).toContain('host-200');
    press('first page');
    render(hosts(279).map(h => ({ ...h })), { selectedKey: 'h200' });
    expect(range()).toBe('1–25 of 279');
  });
});
