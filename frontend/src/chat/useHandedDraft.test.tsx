// @vitest-environment jsdom
import React, { act, StrictMode } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider, useLocation, useParams } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useComposerText } from './useHandedDraft';

const seen: { text: string; state: unknown; setText: ((t: string) => void) | null } = { text: '', state: undefined, setText: null };

function Chat() {
  const { id = '' } = useParams();
  const [text, setText] = useComposerText(id);
  seen.text = text;
  seen.setText = setText;
  seen.state = useLocation().state;
  return null;
}

let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  seen.text = '';
  seen.state = undefined;
  seen.setText = null;
  root = createRoot(document.createElement('div'));
});

afterEach(() => { act(() => root.unmount()); });

function routerAt(entry: { pathname: string; search?: string; state?: unknown }) {
  return createMemoryRouter([{ path: '/chat/p/:id', element: <Chat /> }], { initialEntries: [entry] });
}

function mount(router: ReturnType<typeof routerAt>) {
  return act(async () => root.render(<StrictMode><RouterProvider router={router} /></StrictMode>));
}

describe('useComposerText', () => {
  it('starts with the handed draft under Strict Mode and clears it from the history entry', async () => {
    const router = routerAt({ pathname: '/chat/p/1', state: { draft: 'fix the bug' } });
    await mount(router);
    expect(seen.text).toBe('fix the bug');
    expect(seen.state).toBeNull();

    // A reload of that entry (the view mounts again from it) brings nothing back.
    act(() => root.unmount());
    root = createRoot(document.createElement('div'));
    await mount(routerAt(router.state.location));
    expect(seen.text).toBe('');
  });

  it('empties when the chat changes, and keeps what is typed otherwise', async () => {
    const router = routerAt({ pathname: '/chat/p/1', state: { draft: 'fix the bug' } });
    await mount(router);
    await act(async () => { seen.setText!('more'); });
    expect(seen.text).toBe('more');
    await act(async () => { await router.navigate('/chat/p/2'); });
    expect(seen.text).toBe('');
  });

  it('leaves the history alone when nothing was handed over', async () => {
    const router = routerAt({ pathname: '/chat/p/1', search: '?ws=tui', state: { other: 1 } });
    await mount(router);
    expect(seen.text).toBe('');
    expect(seen.state).toEqual({ other: 1 });
    expect(router.state.location.search).toBe('?ws=tui');
  });
});
