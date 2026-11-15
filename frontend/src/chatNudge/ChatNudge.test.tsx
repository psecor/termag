// @vitest-environment jsdom
// Lab's nudge toward termag's chat ("The nudge toward the
// chat"): who sees the toast, Switch to chat, and Not now's spotlight.
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UI_MODE_KEY } from '../chat/uiMode';
import { CHAT_NUDGE_COPY, shouldShowChatNudge } from './nudge';

const state = vi.hoisted(() => ({
  on: true,
  user: { id: 'u1', chatNudgeDismissed: false as boolean | undefined } as Record<string, unknown>,
  updatePreferences: vi.fn(async (_patch: Record<string, unknown>) => {}),
}));

vi.mock('../flags', async importOriginal => ({
  ...(await importOriginal<typeof import('../flags')>()),
  useFlag: (key: string, fallback: unknown) => (key === 'chat-ui-nudge-enabled' ? state.on : fallback),
}));
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: state.user, updatePreferences: state.updatePreferences }),
}));
vi.mock('../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));
vi.mock('../observability', () => ({ recordProductEvent: () => {} }));

const { ChatNudge, resetChatNudgeForTests } = await import('./ChatNudge');
const { snackbarQueue, toastRegionStyles } = await import('@launchpad-ui/components');

let root: Root;
let host: HTMLDivElement;

function Lab() {
  const anchor = useRef<HTMLButtonElement>(null);
  return <><button ref={anchor} type="button" className="switch">💬</button><ChatNudge anchor={anchor} /></>;
}

async function render() {
  await act(async () => root.render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Lab />} />
        <Route path="/chat" element={<div className="chat-page" />} />
      </Routes>
    </MemoryRouter>,
  ));
}

const toast = () => document.querySelector('.chat-nudge-toast');
const press = (label: string) => {
  const b = [...document.querySelectorAll<HTMLButtonElement>('button')].find(x => x.textContent === label);
  if (!b) throw new Error(`no button ${label}`);
  return act(async () => { b.click(); });
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  // jsdom has no view transitions; LaunchPad's queue falls back to a plain update.
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  state.on = true;
  state.user = { id: 'u1', chatNudgeDismissed: false };
  state.updatePreferences.mockClear();
  localStorage.clear();
  localStorage.setItem(UI_MODE_KEY, 'full');
  resetChatNudgeForTests();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  for (const t of snackbarQueue.visibleToasts) snackbarQueue.close(t.key);
  document.body.innerHTML = '';
});

describe('shouldShowChatNudge', () => {
  it('shows only with the flag on, unanswered on the server, to a person whose choice is Lab', () => {
    expect(shouldShowChatNudge({ on: true, dismissed: false, mode: 'full' })).toBe(true);
    expect(shouldShowChatNudge({ on: false, dismissed: false, mode: 'full' })).toBe(false);
    expect(shouldShowChatNudge({ on: true, dismissed: true, mode: 'full' })).toBe(false);
    // The server leaves the field out while its flag is off.
    expect(shouldShowChatNudge({ on: true, dismissed: undefined, mode: 'full' })).toBe(false);
    // A chat person who followed a link into Lab.
    expect(shouldShowChatNudge({ on: true, dismissed: false, mode: 'simple' })).toBe(false);
  });
});

describe('ChatNudge', () => {
  it('recommends the chat in Lab', async () => {
    await render();
    await vi.waitFor(() => expect(toast()).not.toBeNull());
    expect(toast()!.textContent).toContain(CHAT_NUDGE_COPY.title);
    expect(toast()!.textContent).toContain(CHAT_NUDGE_COPY.description);
    // LaunchPad's region styles (fixed, top right) survive our class: SnackbarRegion
    // spreads a passed className over its own.
    expect(document.querySelector('.chat-nudge-region')!.className).toContain(toastRegionStyles({ placement: 'right' }));
  });

  it('shows nothing once answered, with the flag off, or to a person whose choice is the chat', async () => {
    state.user = { id: 'u1', chatNudgeDismissed: true };
    await render();
    state.on = false;
    state.user = { id: 'u1', chatNudgeDismissed: false };
    await render();
    state.on = true;
    localStorage.setItem(UI_MODE_KEY, 'simple');
    await render();
    await new Promise(r => setTimeout(r, 20));
    expect(toast()).toBeNull();
  });

  it('switches to the chat, makes it where termag opens, and answers the nudge', async () => {
    await render();
    await vi.waitFor(() => expect(toast()).not.toBeNull());
    await press(CHAT_NUDGE_COPY.switch);
    expect(localStorage.getItem(UI_MODE_KEY)).toBe('simple');
    expect(state.updatePreferences).toHaveBeenCalledExactlyOnceWith({ chatNudgeDismissed: true });
    expect(document.querySelector('.chat-page')).not.toBeNull();
    expect(document.querySelector('.chat-nudge-coach')).toBeNull();
  });

  it('answers the nudge on Switch to chat even when the toast\'s close never reaches it', async () => {
    await render();
    await vi.waitFor(() => expect(toast()).not.toBeNull());
    // Leaving Lab unmounts the toast before its onClose runs.
    const close = vi.spyOn(snackbarQueue, 'close').mockImplementation(() => {});
    try {
      await press(CHAT_NUDGE_COPY.switch);
      expect(state.updatePreferences).toHaveBeenCalledExactlyOnceWith({ chatNudgeDismissed: true });
      expect(document.querySelector('.chat-page')).not.toBeNull();
    } finally { close.mockRestore(); }
  });

  it('on Not now, answers the nudge and spotlights the switch, which Got it puts away', async () => {
    await render();
    await vi.waitFor(() => expect(toast()).not.toBeNull());
    await press(CHAT_NUDGE_COPY.dismiss);
    expect(state.updatePreferences).toHaveBeenCalledWith({ chatNudgeDismissed: true });
    expect(localStorage.getItem(UI_MODE_KEY)).toBe('full');
    await vi.waitFor(() => expect(document.querySelector('.chat-nudge-coach')?.textContent).toContain(CHAT_NUDGE_COPY.spotlight));
    expect(document.querySelector('button.switch')!.hasAttribute('data-chat-nudge-spotlight')).toBe(true);
    await vi.waitFor(() => expect(toast()).toBeNull());
    await press(CHAT_NUDGE_COPY.spotlightDone);
    await vi.waitFor(() => expect(document.querySelector('.chat-nudge-coach')).toBeNull());
    expect(document.querySelector('button.switch')!.hasAttribute('data-chat-nudge-spotlight')).toBe(false);
  });
});
