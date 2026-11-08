// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalHandle } from '../../components/Terminal';

vi.mock('../../launchpad/sprite', () => ({ ensureLaunchPadSprite: () => Promise.resolve() }));

/** What the mocked Terminal was given, and what the bar sent through its handle. */
const pane = vi.hoisted(() => ({
  transformInput: undefined as ((d: string) => string) | undefined,
  sent: [] as string[],
  focused: false,
  appCursor: false,
  focusCalls: 0,
}));

vi.mock('../../components/Terminal', async () => {
  const { useEffect } = await vi.importActual<typeof import('react')>('react');
  return {
    Terminal: (p: { sessionName: string; onReady?: (h: TerminalHandle | null) => void; transformInput?: (d: string) => string }) => {
      pane.transformInput = p.transformInput;
      useEffect(() => {
        p.onReady?.({
          send: d => { pane.sent.push(d); },
          focus: () => { pane.focusCalls++; pane.focused = true; },
          isFocused: () => pane.focused,
          appCursor: () => pane.appCursor,
        });
        return () => p.onReady?.(null);
      }, []);
      return <div data-testid="terminal">{p.sessionName}</div>;
    },
  };
});

import { PhoneTerminal } from './TerminalKeyBar';

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(pane, { transformInput: undefined, sent: [], focused: false, appCursor: false, focusCalls: 0 });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<PhoneTerminal sessionName="ada-sample-ctrl" projectId="p1" workstream="main" />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const button = (name: string) => {
  const b = host.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`);
  if (!b) throw new Error(`no button ${name}`);
  return b;
};
const tap = (name: string) => act(() => { button(name).click(); });
/** What the phone's keyboard typed, as xterm hands it to the pane. */
const type = (data: string) => {
  let out = '';
  act(() => { out = pane.transformInput ? pane.transformInput(data) : data; });
  return out;
};

describe('PhoneTerminal', () => {
  it('renders the pane over a toolbar of keys, with a keyboard button first', () => {
    expect(host.querySelector('[data-testid="terminal"]')?.textContent).toBe('ada-sample-ctrl');
    const bar = host.querySelector('[role="toolbar"]')!;
    expect(bar.getAttribute('aria-label')).toBe('Terminal keys');
    expect([...bar.querySelectorAll('button')].map(b => b.textContent)).toEqual(['', 'Esc', 'Tab', 'Ctrl', '', '', '', '', '^C', '|', '~', '/']);
    expect([...bar.querySelectorAll('button')].map(b => b.getAttribute('aria-label')).slice(4, 8)).toEqual(['Arrow up', 'Arrow down', 'Arrow left', 'Arrow right']);
    expect(bar.querySelector('button')!.getAttribute('aria-label')).toBe('Type in the terminal');
  });

  it('sends each key\'s bytes down the pane, as typing would', () => {
    tap('Press Escape');
    tap('Press Tab');
    tap('Ctrl-C (interrupt)');
    tap('Type |');
    expect(pane.sent).toEqual(['\x1b', '\t', '\x03', '|']);
  });

  it('sends arrows the way the pane\'s cursor mode wants them', () => {
    tap('Arrow up');
    pane.appCursor = true;
    tap('Arrow up');
    expect(pane.sent).toEqual(['\x1b[A', '\x1bOA']);
  });

  it('holds Ctrl for the next key typed on the keyboard, then lets go', () => {
    const ctrl = () => button('Ctrl: the next key is sent with Ctrl');
    tap('Ctrl: the next key is sent with Ctrl');
    expect(ctrl().getAttribute('aria-pressed')).toBe('true');
    expect(type('c')).toBe('\x03');
    expect(ctrl().getAttribute('aria-pressed')).toBe('false');
    expect(type('c')).toBe('c');
  });

  it('applies a held Ctrl to the bar\'s own next key', () => {
    tap('Ctrl: the next key is sent with Ctrl');
    tap('Arrow left');
    tap('Arrow left');
    expect(pane.sent).toEqual(['\x1b[1;5D', '\x1b[D']);
  });

  it('can let go of Ctrl without sending anything', () => {
    tap('Ctrl: the next key is sent with Ctrl');
    tap('Ctrl: the next key is sent with Ctrl');
    expect(type('c')).toBe('c');
    expect(pane.sent).toEqual([]);
  });

  it('focuses the pane from the keyboard button', () => {
    tap('Type in the terminal');
    expect(pane.focusCalls).toBe(1);
  });

  it('gives focus back to the pane after a key when the keyboard was up, and only then', () => {
    const bar = host.querySelector('[role="toolbar"]')!;
    act(() => { button('Press Escape').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    tap('Press Escape');
    expect(pane.focusCalls).toBe(0);
    pane.focused = true;
    act(() => { button('Press Escape').dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    tap('Press Escape');
    expect(pane.focusCalls).toBe(1);
    // A mouse-down on the bar never moves focus off the pane.
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    bar.querySelector('button')!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
  });
});
