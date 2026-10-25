import { describe, expect, it } from 'vitest';
import { BROWSER_PANE_CLOSE, browserPaneCloseMessage, keyEvent, modifiersOf, mouseButtonName, pointerEvent, shouldCaptureKey, toFramePoint, wheelEvent } from './browserPaneInput';

const mods = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
const box = { left: 100, top: 50, width: 400, height: 300 };
const frame = { width: 800, height: 600 };

describe('browser pane input mapping', () => {
  it('builds the protocol modifier mask', () => {
    expect(modifiersOf(mods)).toBe(0);
    expect(modifiersOf({ ...mods, altKey: true })).toBe(1);
    expect(modifiersOf({ ...mods, ctrlKey: true, shiftKey: true })).toBe(10);
    expect(modifiersOf({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
  });

  it('names mouse buttons', () => {
    expect([0, 1, 2, 3, -1].map(mouseButtonName)).toEqual(['left', 'middle', 'right', 'none', 'none']);
  });

  it('scales a CSS point into the frame and clamps at its edges', () => {
    expect(toFramePoint(100, 50, box, frame)).toEqual({ x: 0, y: 0 });
    expect(toFramePoint(300, 200, box, frame)).toEqual({ x: 400, y: 300 });
    expect(toFramePoint(500, 350, box, frame)).toEqual({ x: 800, y: 600 });
    expect(toFramePoint(0, 0, box, frame)).toEqual({ x: 0, y: 0 });
    expect(toFramePoint(9999, 9999, box, frame)).toEqual({ x: 800, y: 600 });
    // A zero-sized box (not laid out yet) maps 1:1 rather than dividing by zero.
    expect(toFramePoint(110, 60, { ...box, width: 0, height: 0 }, frame)).toEqual({ x: 10, y: 10 });
  });

  it('maps a press, a release and a move, with the click count bounded', () => {
    expect(pointerEvent('mousePressed', { ...mods, clientX: 300, clientY: 200, button: 0, buttons: 1 }, box, frame, 2))
      .toEqual({ kind: 'mouse', type: 'mousePressed', x: 400, y: 300, button: 'left', buttons: 1, clickCount: 2, modifiers: 0 });
    expect(pointerEvent('mouseReleased', { ...mods, shiftKey: true, clientX: 300, clientY: 200, button: 2, buttons: 0 }, box, frame))
      .toEqual({ kind: 'mouse', type: 'mouseReleased', x: 400, y: 300, button: 'right', buttons: 0, clickCount: 1, modifiers: 8 });
    // A plain move has no button; a drag keeps the one held.
    expect(pointerEvent('mouseMoved', { ...mods, clientX: 300, clientY: 200, button: 0, buttons: 0 }, box, frame).button).toBe('none');
    expect(pointerEvent('mouseMoved', { ...mods, clientX: 300, clientY: 200, button: 0, buttons: 1 }, box, frame)).toMatchObject({ button: 'left', clickCount: 0 });
    expect(pointerEvent('mousePressed', { ...mods, clientX: 300, clientY: 200, button: 0, buttons: 1 }, box, frame, 9).clickCount).toBe(3);
  });

  it('converts wheel deltas to pixels', () => {
    expect(wheelEvent({ ...mods, clientX: 300, clientY: 200, button: 0, buttons: 0, deltaX: 0, deltaY: 120, deltaMode: 0 }, box, frame))
      .toEqual({ kind: 'mouse', type: 'mouseWheel', x: 400, y: 300, button: 'none', buttons: 0, clickCount: 0, modifiers: 0, deltaX: 0, deltaY: 120 });
    expect(wheelEvent({ ...mods, clientX: 300, clientY: 200, button: 0, buttons: 0, deltaX: -2, deltaY: 3, deltaMode: 1 }, box, frame)).toMatchObject({ deltaX: -32, deltaY: 48 });
    expect(wheelEvent({ ...mods, clientX: 300, clientY: 200, button: 0, buttons: 0, deltaX: 0, deltaY: 1, deltaMode: 2 }, box, frame)).toMatchObject({ deltaY: 600 });
  });

  it('gives printable keys and Enter their text on keyDown only, never under Ctrl or Meta', () => {
    expect(keyEvent('keyDown', { ...mods, key: 'a', code: 'KeyA', keyCode: 65 }))
      .toEqual({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', windowsVirtualKeyCode: 65, modifiers: 0 });
    expect(keyEvent('keyUp', { ...mods, key: 'a', code: 'KeyA', keyCode: 65 }).text).toBeUndefined();
    expect(keyEvent('keyDown', { ...mods, key: 'Enter', code: 'Enter', keyCode: 13 }).text).toBe('\r');
    expect(keyEvent('keyDown', { ...mods, key: 'Backspace', code: 'Backspace', keyCode: 8 })).toEqual({ kind: 'key', type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, modifiers: 0 });
    expect(keyEvent('keyDown', { ...mods, ctrlKey: true, key: 'a', code: 'KeyA', keyCode: 65 })).toMatchObject({ modifiers: 2 });
    expect(keyEvent('keyDown', { ...mods, ctrlKey: true, key: 'a', code: 'KeyA', keyCode: 65 }).text).toBeUndefined();
    expect(keyEvent('keyDown', { ...mods, key: 'ü', code: '', keyCode: 0 }).windowsVirtualKeyCode).toBeUndefined();
  });

  it('leaves reload, full screen and DevTools to the viewer', () => {
    expect(shouldCaptureKey({ ...mods, key: 'F5', code: 'F5', keyCode: 116 })).toBe(false);
    expect(shouldCaptureKey({ ...mods, key: 'F12', code: 'F12', keyCode: 123 })).toBe(false);
    expect(shouldCaptureKey({ ...mods, key: 'Tab', code: 'Tab', keyCode: 9 })).toBe(true);
    expect(shouldCaptureKey({ ...mods, ctrlKey: true, key: 'l', code: 'KeyL', keyCode: 76 })).toBe(true);
  });

  it('explains each close code', () => {
    expect(browserPaneCloseMessage(BROWSER_PANE_CLOSE.DISABLED, 'browser pane disabled')).toMatch(/browser-pane-enabled/);
    expect(browserPaneCloseMessage(BROWSER_PANE_CLOSE.UNSUPPORTED, '')).toMatch(/needs an update/);
    expect(browserPaneCloseMessage(BROWSER_PANE_CLOSE.PARKED, 'box hibernated')).toBe('The box is hibernated.');
    expect(browserPaneCloseMessage(1008, 'project forbidden')).toBe('Not allowed: project forbidden.');
    expect(browserPaneCloseMessage(1011, 'agent error')).toMatch(/Could not start/);
    expect(browserPaneCloseMessage(1013, 'agent not connected')).toBe('The box is not connected right now.');
    expect(browserPaneCloseMessage(1006, '')).toBe('Connection lost.');
    expect(browserPaneCloseMessage(4999, '')).toBe('Closed (4999).');
  });
});
