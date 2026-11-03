// @vitest-environment jsdom
// A What's new button and its dialog: the flag, the unseen
// count, the tabs, and seen state as the tabs are shown.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEEN_KEY } from './view';
import { useWhatsNewDialog, whatsNewLabel } from './useWhatsNew';
import type { Surface, WhatsNewEntry } from './whatsNew';

const flags = vi.hoisted(() => ({ enabled: true, on: new Set<string>() }));
const FLAG = 'simple-ui-chrome-refresh-enabled';
// Built before the modules load, so useWhatsNew's list of ids and flags sees them.
const { entries, TODAY } = vi.hoisted(() => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = day(new Date());
  const longAgo = new Date();
  longAgo.setDate(longAgo.getDate() - 120);
  const list: WhatsNewEntry[] = [
    { id: 'side-panel-tabs', title: 'Side panel tabs', surface: 'termag', category: 'new', date: today, flags: ['simple-ui-chrome-refresh-enabled' as WhatsNewEntry['flags'][number]], body: 'Open a terminal beside the chat.' },
    { id: 'model-placeholder', title: 'The composer names your model', surface: 'termag', category: 'fixed', date: today, flags: [], body: 'It said Claude whatever you **picked**.' },
    { id: 'old-termag', title: 'Long ago', surface: 'termag', category: 'changed', date: day(longAgo), flags: [], body: 'Out of the window.' },
    { id: 'box-sizes', title: 'Box sizes', surface: 'lab', category: 'new', date: today, flags: [], body: 'Small, medium or large.' },
  ];
  return { entries: list, TODAY: today };
});

vi.mock('../flags', async importOriginal => ({
  ...(await importOriginal<typeof import('../flags')>()),
  useFlag: (key: string, fallback: unknown) => (key === 'whats-new-enabled' ? flags.enabled : fallback),
  useOnFlags: (keys: readonly string[]) => new Set(keys.filter(k => flags.on.has(k))),
}));
vi.mock('./whatsNew', async importOriginal => ({
  ...(await importOriginal<typeof import('./whatsNew')>()),
  WHATS_NEW_ENTRIES: entries,
}));
vi.mock('../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));

let root: Root;
let host: HTMLDivElement;

function Harness({ surface }: { surface: Surface }) {
  const w = useWhatsNewDialog(surface);
  return <>{w.enabled && <button type="button" className="open" aria-label={whatsNewLabel(w.unseen)} onClick={w.open} />}{w.dialog}</>;
}

const button = () => document.querySelector<HTMLButtonElement>('button.open');
const dialog = () => document.querySelector('[role="dialog"]');
const tab = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(t => t.textContent?.startsWith(name));
const titles = () => [...document.querySelectorAll('[role="tabpanel"] .whats-new-title')].map(t => t.firstChild?.textContent);
const stored = () => JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]') as string[];

async function render(surface: Surface) {
  await act(async () => root.render(<Harness surface={surface} />));
}

async function open() {
  await act(async () => { button()!.click(); });
  await vi.waitFor(() => expect(dialog()).not.toBeNull(), { timeout: 5000 });
}

// The dialog is a lazy chunk; load it once up front, so no test waits on the
// transform while the whole suite runs.
beforeAll(async () => { await import('./WhatsNewDialog'); });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  localStorage.clear();
  flags.enabled = true;
  flags.on = new Set();
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('a What\'s new button', () => {
  it('is not there while whats-new-enabled is off', async () => {
    flags.enabled = false;
    await render('termag');
    expect(button()).toBeNull();
  });

  it("counts its own UI's unseen entries, leaving out a flag that's off and an old one", async () => {
    await render('termag');
    expect(button()!.getAttribute('aria-label')).toBe("What's new, 1 unseen");
    flags.on = new Set([FLAG]);
    await render('termag');
    expect(button()!.getAttribute('aria-label')).toBe("What's new, 2 unseen");
  });

  it('opens on its own tab, and marks only that tab seen', async () => {
    flags.on = new Set([FLAG]);
    await render('termag');
    await open();
    expect(tab('termag')!.getAttribute('aria-selected')).toBe('true');
    expect(titles()).toEqual(['Side panel tabs', 'The composer names your model']);
    expect([...document.querySelectorAll('.whats-new-category')].map(c => c.textContent)).toEqual(['New', 'Fixed']);
    expect(document.querySelector('.whats-new-week-label')?.textContent).toBe('This week');
    expect(document.querySelector('.whats-new-body strong')?.textContent).toBe('picked');
    expect(stored().sort()).toEqual(['model-placeholder', 'side-panel-tabs']);
    expect(button()!.getAttribute('aria-label')).toBe("What's new");
    // The dots and counts stay as they were when it opened.
    expect(document.querySelectorAll('.whats-new-entry[data-fresh]')).toHaveLength(2);
    expect(tab('termag')!.querySelector('.whats-new-count')?.textContent).toBe('2');
    expect(tab('lab')!.querySelector('.whats-new-count')?.textContent).toBe('1');
  });

  it('marks the other tab seen once it is shown', async () => {
    await render('termag');
    await open();
    expect(stored()).not.toContain('box-sizes');
    await act(async () => { tab('lab')!.click(); });
    await vi.waitFor(() => expect(tab('lab')!.getAttribute('aria-selected')).toBe('true'), { timeout: 5000 });
    expect(titles()).toEqual(['Box sizes']);
    expect(stored()).toContain('box-sizes');
  });

  it('opens on lab from lab, and shows nothing dotted once everything is seen', async () => {
    localStorage.setItem(SEEN_KEY, JSON.stringify(['box-sizes']));
    await render('lab');
    expect(button()!.getAttribute('aria-label')).toBe("What's new");
    await open();
    expect(tab('lab')!.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelectorAll('[role="tabpanel"] .whats-new-entry[data-fresh]')).toHaveLength(0);
  });

  it('says so when a tab has nothing in the window', async () => {
    entries.splice(3, 1);
    try {
      await render('lab');
      await open();
      expect(document.querySelector('.whats-new-empty')?.textContent).toContain('Nothing new in lab in the last 90 days.');
    } finally {
      entries.push({ id: 'box-sizes', title: 'Box sizes', surface: 'lab', category: 'new', date: TODAY, flags: [], body: 'Small, medium or large.' });
    }
  });

  it('closes from its close button', async () => {
    await render('termag');
    await open();
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click(); });
    await vi.waitFor(() => expect(dialog()).toBeNull(), { timeout: 5000 });
  });
});
