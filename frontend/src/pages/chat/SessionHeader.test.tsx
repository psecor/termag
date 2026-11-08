// @vitest-environment jsdom
// A session's header under the chrome refresh.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../../types';
import { ChatChromeProvider, SidePanelButton, type ChatChrome } from './chatChrome';
import { SessionHeader, type SessionHeaderProps } from './SessionHeader';

vi.mock('../../flags', async () => {
  const actual = await vi.importActual<typeof import('../../flags')>('../../flags');
  return { ...actual, useFlag: <T,>(_key: string, fallback: T) => fallback };
});
vi.mock('../../chat/useChatSpaces', () => ({
  useSharedChatSpaces: () => ({ loaded: true, current: true, spaces: [{ id: 's-notes', name: 'notes' }], index: new Map([['box-1', ['notes']]]), colorOf: () => '#888888' }),
}));
vi.mock('../../components/BoxPill', () => ({ BoxPill: ({ label }: { label: string }) => <span className="box-pill">{label}</span> }));

const project = {
  id: 'p1', name: 'webapp', instanceId: 'box-1', role: 'owner', ownerUsername: 'ada', repoUrl: null,
  workstreams: [{ name: 'main', sessionTitle: 'Fix the flaky retry' }],
} as unknown as Project;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const css = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS;
  if (!css?.escape) (globalThis as { CSS?: unknown }).CSS = { ...css, escape: (v: string) => v.replace(/[^\w-]/g, c => `\\${c}`) };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function show(props: Partial<SessionHeaderProps> = {}, chrome: Partial<ChatChrome> = {}) {
  const value: ChatChrome = {
    mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, refresh: true,
    sidePanel: { open: false, toggle: () => {} }, ...chrome,
  };
  const all: SessionHeaderProps = {
    project, workstream: 'main', repo: null, box: { name: 'box-2' }, working: false, opening: false, onOpenFull: () => {},
    archive: { label: 'Archive', disabled: false, hint: 'The box stops when this is its only session', onArchive: () => {} }, ...props,
  };
  act(() => root.render(<ChatChromeProvider value={value}><header><SessionHeader {...all} /></header></ChatChromeProvider>));
}

const press = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };

describe('SessionHeader', () => {
  it('reads space / title, with the project as a chip and the box after', () => {
    show();
    expect(host.querySelector('.chat-title-space')?.textContent).toContain('notes');
    expect(host.querySelector('.chat-crumb-sep')?.textContent).toBe('/');
    expect(host.querySelector('.chat-title-name')?.textContent).toBe('Fix the flaky retry');
    expect(host.querySelector('.chat-title-project')?.textContent).toBe('webapp');
    expect(host.querySelector('.chat-header-actions .box-pill')?.textContent).toBe('box-2');
    expect(host.textContent).not.toMatch(/\$|total/);
  });

  it('shows a Working pill only during a turn', () => {
    show();
    expect(host.querySelector('.chat-title-state')).toBeNull();
    show({ working: true });
    expect(host.querySelector('.chat-title-state [role="progressbar"]')).not.toBeNull();
  });

  it('puts Open in Lab and Archive under ⋯', async () => {
    const onOpenFull = vi.fn();
    const onArchive = vi.fn();
    show({ onOpenFull, archive: { label: 'Archive', disabled: false, hint: 'h', onArchive } });
    await press(host.querySelector('.chat-session-more')!);
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map(i => i.querySelector('[slot="label"]')?.textContent)).toEqual(['Open in Lab', 'Open in termag desktop', 'Archive']);
    // A link the browser hands to the desktop, not a navigation away from the session.
    expect(items[1].getAttribute('href')).toBe('t3code://termag/projects/p1');
    await press(items[2]);
    expect(onArchive).toHaveBeenCalledTimes(1);
    await press(host.querySelector('.chat-session-more')!);
    await press([...document.querySelectorAll('[role="menuitem"]')][0]);
    expect(onOpenFull).toHaveBeenCalledTimes(1);
  });

  it("offers Resize box on the owner's box, between Open in Lab and Archive, its current size beneath", async () => {
    const onOpen = vi.fn();
    show({ resize: { hint: 'Medium: 4 vCPU 16GB RAM', onOpen } });
    await press(host.querySelector('.chat-session-more')!);
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map(i => i.querySelector('[slot="label"]')?.textContent)).toEqual(['Open in Lab', 'Open in termag desktop', 'Resize box', 'Archive']);
    expect(items[2].querySelector('[slot="description"]')?.textContent).toBe('Medium: 4 vCPU 16GB RAM');
    await press(items[2]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('disables Archive during a turn, and has none for a collaborator', async () => {
    show({ archive: { label: 'Archive', disabled: true, hint: 'Wait for the turn to end', onArchive: () => {} } });
    await press(host.querySelector('.chat-session-more')!);
    expect(document.querySelector('[role="menuitem"][data-key="archive"], [role="menuitem"]:last-child')?.getAttribute('aria-disabled')).toBe('true');
    act(() => root.render(<></>));
    // A collaborator's shared project isn't on their boxes, so the desktop can't open it either.
    show({ archive: null, project: { ...project, role: 'collaborator' } });
    await press(host.querySelector('.chat-session-more')!);
    expect([...document.querySelectorAll('[role="menuitem"]')].map(i => i.querySelector('[slot="label"]')?.textContent)).toEqual(['Open in Lab']);
  });
});

describe('SidePanelButton under the refresh', () => {
  const render = (chrome: Partial<ChatChrome>) => {
    const value: ChatChrome = { mode: 'docked', historyOpen: false, openHistory: () => {}, closeHistory: () => {}, ...chrome };
    act(() => root.render(<ChatChromeProvider value={value}><SidePanelButton /></ChatChromeProvider>));
  };

  it('is the old Tools button with the refresh off', () => {
    render({ sidePanel: { open: false, toggle: () => {} } });
    expect(host.querySelector('button.chat-side-toggle')?.textContent).toBe('Tools');
  });

  it('is an icon that steps aside while the panel is open', async () => {
    const toggle = vi.fn();
    render({ refresh: true, sidePanel: { open: false, toggle } });
    const b = host.querySelector('.chat-side-toggle')!;
    expect(b.getAttribute('aria-label')).toBe('Show tools');
    expect(b.textContent).toBe('');
    await press(b);
    expect(toggle).toHaveBeenCalledTimes(1);
    render({ refresh: true, sidePanel: { open: true, toggle } });
    expect(host.querySelector('.chat-side-toggle')).toBeNull();
  });
});
