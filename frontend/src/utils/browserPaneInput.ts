// Browser pane input: DOM events on the pane's canvas
// become the events the box agent hands to the DevTools protocol. Coordinates
// are mapped from the canvas's CSS box to the frame's pixels; the modifier
// mask is the protocol's (Alt 1, Ctrl 2, Meta 4, Shift 8). The backend
// re-validates every field (services/browserPane.ts), so this is about shape,
// not trust.

export type BrowserMouseType = 'mousePressed' | 'mouseReleased' | 'mouseMoved' | 'mouseWheel';
export type BrowserMouseButton = 'none' | 'left' | 'middle' | 'right';

export interface BrowserMouseEvent {
  kind: 'mouse';
  type: BrowserMouseType;
  x: number;
  y: number;
  button: BrowserMouseButton;
  buttons: number;
  clickCount: number;
  modifiers: number;
  deltaX?: number;
  deltaY?: number;
}

export interface BrowserKeyEvent {
  kind: 'key';
  type: 'keyDown' | 'keyUp';
  key: string;
  code: string;
  text?: string;
  windowsVirtualKeyCode?: number;
  modifiers: number;
}

export interface BrowserTextEvent {
  kind: 'text';
  text: string;
}

export type BrowserInputEvent = BrowserMouseEvent | BrowserKeyEvent | BrowserTextEvent;

export interface ModifierKeys { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }
export interface PointerLike extends ModifierKeys { clientX: number; clientY: number; button: number; buttons: number }
export interface WheelLike extends PointerLike { deltaX: number; deltaY: number; deltaMode: number }
export interface KeyLike extends ModifierKeys { key: string; code: string; keyCode: number }
/** The canvas's CSS box (a DOMRect's left, top, width and height). */
export interface CssBox { left: number; top: number; width: number; height: number }
export interface FrameSize { width: number; height: number }

/** Close codes the backend uses for the pane socket; kept in step with services/browserPane.ts by hand. */
export const BROWSER_PANE_CLOSE = {
  DISABLED: 4403, UNSUPPORTED: 4501, PARKED: 4409,
  // A reviewer's guest pane:
  // refused or ended (final), busy (redials), no dev stack to show (final), failed its canary (final).
  GUEST_REFUSED: 4410, GUEST_BUSY: 4429, GUEST_STACK: 4424, GUEST_UNSAFE: 4500,
} as const;

export function modifiersOf(e: ModifierKeys): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export function mouseButtonName(button: number): BrowserMouseButton {
  switch (button) {
    case 0: return 'left';
    case 1: return 'middle';
    case 2: return 'right';
    default: return 'none';
  }
}

/** A point in the canvas's CSS box as frame pixels, clamped to the frame. */
export function toFramePoint(clientX: number, clientY: number, box: CssBox, frame: FrameSize): { x: number; y: number } {
  const scaleX = box.width > 0 ? frame.width / box.width : 1;
  const scaleY = box.height > 0 ? frame.height / box.height : 1;
  const x = Math.round((clientX - box.left) * scaleX);
  const y = Math.round((clientY - box.top) * scaleY);
  return {
    x: Math.min(frame.width, Math.max(0, x)),
    y: Math.min(frame.height, Math.max(0, y)),
  };
}

export function pointerEvent(
  type: Exclude<BrowserMouseType, 'mouseWheel'>,
  e: PointerLike,
  box: CssBox,
  frame: FrameSize,
  clickCount: number = type === 'mouseMoved' ? 0 : 1,
): BrowserMouseEvent {
  const { x, y } = toFramePoint(e.clientX, e.clientY, box, frame);
  return {
    kind: 'mouse',
    type,
    x,
    y,
    button: type === 'mouseMoved' && e.buttons === 0 ? 'none' : mouseButtonName(e.button),
    buttons: e.buttons,
    clickCount: Math.min(3, Math.max(0, clickCount)),
    modifiers: modifiersOf(e),
  };
}

const WHEEL_LINE_PX = 16;

export function wheelEvent(e: WheelLike, box: CssBox, frame: FrameSize): BrowserMouseEvent {
  const { x, y } = toFramePoint(e.clientX, e.clientY, box, frame);
  // deltaMode 1 is lines, 2 is pages; the protocol wants pixels.
  const unit = e.deltaMode === 1 ? WHEEL_LINE_PX : e.deltaMode === 2 ? Math.max(1, frame.height) : 1;
  return {
    kind: 'mouse',
    type: 'mouseWheel',
    x,
    y,
    button: 'none',
    buttons: e.buttons,
    clickCount: 0,
    modifiers: modifiersOf(e),
    deltaX: Math.round(e.deltaX * unit),
    deltaY: Math.round(e.deltaY * unit),
  };
}

/**
 * A key as the protocol takes it. Printable keys carry their text on keyDown
 * (and Enter carries a carriage return) unless Ctrl or Meta is held, where
 * the key is a shortcut rather than typing. The virtual key code is what
 * makes Backspace, the arrows and friends do their job in the page.
 */
export function keyEvent(type: 'keyDown' | 'keyUp', e: KeyLike): BrowserKeyEvent {
  const event: BrowserKeyEvent = { kind: 'key', type, key: e.key, code: e.code, modifiers: modifiersOf(e) };
  if (type === 'keyDown' && !e.ctrlKey && !e.metaKey) {
    if (e.key.length === 1) event.text = e.key;
    else if (e.key === 'Enter') event.text = '\r';
  }
  if (Number.isInteger(e.keyCode) && e.keyCode > 0 && e.keyCode < 256) event.windowsVirtualKeyCode = e.keyCode;
  return event;
}

/** Keys the viewer's own browser keeps: reload, full screen and DevTools act on the workspace, not the pane. */
export function shouldCaptureKey(e: KeyLike): boolean {
  return e.key !== 'F5' && e.key !== 'F11' && e.key !== 'F12';
}

/** What the pane says when its socket closes with this code. */
export function browserPaneCloseMessage(code: number, reason: string): string {
  switch (code) {
    case BROWSER_PANE_CLOSE.DISABLED: return 'The browser pane is off for this box (browser-pane-enabled).';
    case BROWSER_PANE_CLOSE.UNSUPPORTED: return "This box's agent needs an update before it can run a browser pane.";
    // The backend's own message (the `exit` frame ahead of the close) says
    // whose box it is; this fallback only names its state.
    case BROWSER_PANE_CLOSE.PARKED: return `The box is ${reason.replace(/^box /, '') || 'parked'}.`;
    case BROWSER_PANE_CLOSE.GUEST_REFUSED: return "This preview isn't available.";
    case BROWSER_PANE_CLOSE.GUEST_BUSY: return 'This preview is busy right now.';
    case BROWSER_PANE_CLOSE.GUEST_STACK: return "The app this preview shows isn't running.";
    case BROWSER_PANE_CLOSE.GUEST_UNSAFE: return "The owner's box couldn't open a reviewer's browser safely.";
    case 1000: return 'The browser closed.';
    case 1012: return 'The preview was updated.';
    case 1006: return 'Connection lost.';
    case 1008: return reason ? `Not allowed: ${reason}.` : 'Not allowed.';
    case 1011: return 'Could not start a browser on the box.';
    case 1013: return 'The box is not connected right now.';
    default: return reason ? `Closed: ${reason}.` : `Closed (${code}).`;
  }
}
