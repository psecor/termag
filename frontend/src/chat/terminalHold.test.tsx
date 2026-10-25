// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TerminalHoldNotice } from './TerminalHoldNotice';
import { reduceHold, refusalFromSend, statusBesideHold, TERMINAL_HOLD_VIEW } from './terminalHold';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); });

const done = { tone: 'idle', text: 'Done · your turn' };

describe('terminal hold', () => {
  it('a live Claude keeps the notice up and replaces Done · your turn', () => {
    const held = reduceHold({ held: false, refused: false }, true);
    expect(held.show).toBe(true);
    expect(statusBesideHold(held.show, false, done).text).toBe(TERMINAL_HOLD_VIEW.statusText);
    // A send refused before the next poll shows the same notice.
    expect(reduceHold({ held: false, refused: true }, undefined).show).toBe(true);
    expect(refusalFromSend('terminal-holds')).toBe(true);
    expect(TERMINAL_HOLD_VIEW.text).not.toMatch(/\/exit/);
    expect(TERMINAL_HOLD_VIEW.returnLabel).toMatch(/Return it to this chat/);
    expect(TERMINAL_HOLD_VIEW.fullUiLabel).toMatch(/full UI/);
  });

  it('a history poll that says Claude has left clears the refusal so Send works', () => {
    const cleared = reduceHold({ held: true, refused: true }, false);
    expect(cleared).toEqual({ held: false, refused: false, show: false });
    expect(statusBesideHold(cleared.show, false, done)).toEqual(done);
    // A turn that is actually running keeps its own line.
    const working = { tone: 'working', text: 'Thinking…' };
    expect(statusBesideHold(true, true, working)).toEqual(working);
  });

  it('a probe miss does not clear the notice: that is not Claude having left', () => {
    const kept = reduceHold({ held: true, refused: true }, undefined);
    expect(kept).toEqual({ held: true, refused: true, show: true });
    expect(statusBesideHold(kept.show, false, done).text).toBe(TERMINAL_HOLD_VIEW.statusText);
  });
});

describe('TerminalHoldNotice', () => {
  it('offers return and the full UI, and does not tell anyone to type /exit', () => {
    const calls: string[] = [];
    act(() => root.render(
      <TerminalHoldNotice busy={false} onReturn={() => calls.push('return')} onFullUi={() => calls.push('full')} />,
    ));
    expect(host.textContent).not.toMatch(/\/exit/);
    expect(host.textContent).toContain(TERMINAL_HOLD_VIEW.text);
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map(b => b.textContent)).toEqual([TERMINAL_HOLD_VIEW.returnLabel, TERMINAL_HOLD_VIEW.fullUiLabel]);
    act(() => buttons[0].click());
    act(() => buttons[1].click());
    expect(calls).toEqual(['return', 'full']);
  });
});
