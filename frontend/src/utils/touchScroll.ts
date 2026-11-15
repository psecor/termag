// One-finger touch scrolling for the simple UI's phone terminal.
// Pure: the gesture's state, the drag → lines mapping, the
// fling's decay, and the bytes of a mouse wheel report. The DOM side is
// pages/chat/useTouchScroll.ts.
//
// Why termag does this itself: xterm 5.3 scrolls on touch only while no mouse
// events are requested (Terminal.ts skips its touchmove when
// `coreMouseService.areMouseEventsActive`), and in scroll mode tmux has mouse
// on, so a drag did nothing. And tmux draws on the alternate screen, so the
// history a person wants is tmux's, reached through copy-mode by the wheel.

/** Movement (px) before a touch counts as a drag, so a tap stays a tap. */
export const DRAG_SLOP_PX = 8;

/**
 * Lines tmux scrolls for one wheel report in copy-mode: its default
 * `WheelUpPane`/`WheelDownPane` bindings are `send -X -N 5 scroll-up/down`.
 * The drag sends one report per this many lines, so the history moves at the
 * finger's pace, in steps of five.
 */
export const TMUX_WHEEL_LINES = 5;

/** A fling slower than this (px/ms) at release just stops. */
export const FLING_MIN_VELOCITY = 0.3;
/** The fling ends below this speed (px/ms). */
export const FLING_STOP_VELOCITY = 0.02;
/** The fling keeps this share of its speed per 16 ms frame. */
export const FLING_FRICTION = 0.95;
/** Only the last this-many ms of a drag set the fling's speed. */
const VELOCITY_WINDOW_MS = 100;

export type DragAxis = 'pending' | 'vertical' | 'other';

export interface DragState {
  axis: DragAxis;
  startX: number;
  startY: number;
  lastY: number;
  /** Pixels moved that haven't made a whole unit yet (a line, or a wheel step). */
  remainderPx: number;
  /** Recent (time, y) samples, for the fling's speed. */
  samples: { t: number; y: number }[];
}

export function startDrag(x: number, y: number, t: number): DragState {
  return { axis: 'pending', startX: x, startY: y, lastY: y, remainderPx: 0, samples: [{ t, y }] };
}

/**
 * Decides the drag's axis once it leaves the slop: vertical only when it moved
 * more up or down than sideways. A sideways drag is left to the browser (the
 * key bar scrolls sideways; a wide pane may too), and stays sideways.
 */
export function lockAxis(s: DragState, x: number, y: number): DragAxis {
  if (s.axis !== 'pending') return s.axis;
  const dx = Math.abs(x - s.startX);
  const dy = Math.abs(y - s.startY);
  if (Math.max(dx, dy) < DRAG_SLOP_PX) return 'pending';
  return dy > dx ? 'vertical' : 'other';
}

/**
 * Turns a vertical movement into whole units of scroll, carrying the rest.
 * The content follows the finger: a finger moving up (dy < 0) scrolls toward
 * newer lines (a positive count, like `term.scrollLines(+n)` and a wheel
 * down); moving down reveals older lines (negative). `unitPx` is a line's
 * height, or a line's height times TMUX_WHEEL_LINES for wheel reports.
 */
export function dragUnits(remainderPx: number, dy: number, unitPx: number): { units: number; remainderPx: number } {
  if (!(unitPx > 0)) return { units: 0, remainderPx: 0 };
  const total = remainderPx - dy;
  const units = Math.trunc(total / unitPx);
  return { units, remainderPx: total - units * unitPx };
}

/** Advances a vertical drag to `y` at time `t`: the units to scroll and the next state. */
export function moveDrag(s: DragState, y: number, t: number, unitPx: number): { units: number; state: DragState } {
  const { units, remainderPx } = dragUnits(s.remainderPx, y - s.lastY, unitPx);
  const samples = [...s.samples, { t, y }].filter(p => t - p.t <= VELOCITY_WINDOW_MS);
  return { units, state: { ...s, lastY: y, remainderPx, samples } };
}

/** The finger's speed (px/ms, positive = moving down) over the drag's last moments. */
export function releaseVelocity(s: DragState, t: number): number {
  const recent = s.samples.filter(p => t - p.t <= VELOCITY_WINDOW_MS);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  const dt = last.t - first.t;
  return dt > 0 ? (last.y - first.y) / dt : 0;
}

/**
 * One frame of a fling: how far (px, signed like a finger's dy) it moves in
 * `dtMs`, and its speed after. Null when it is done.
 */
export function flingStep(velocity: number, dtMs: number): { dy: number; velocity: number } | null {
  if (Math.abs(velocity) < FLING_STOP_VELOCITY || !(dtMs > 0)) return null;
  const dy = velocity * dtMs;
  return { dy, velocity: velocity * Math.pow(FLING_FRICTION, dtMs / 16) };
}

/** Whether a release at this speed flings on. */
export function shouldFling(velocity: number): boolean {
  return Math.abs(velocity) >= FLING_MIN_VELOCITY;
}

/** The 1-based cell under a point, clamped to the screen. */
export function cellAt(
  clientX: number, clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  cols: number, rows: number,
): { col: number; row: number } {
  const clamp = (n: number, max: number) => Math.min(max, Math.max(1, n));
  const col = rect.width > 0 ? Math.floor(((clientX - rect.left) / rect.width) * cols) + 1 : 1;
  const row = rect.height > 0 ? Math.floor(((clientY - rect.top) / rect.height) * rows) + 1 : 1;
  return { col: clamp(col, cols), row: clamp(row, rows) };
}

/**
 * The bytes of one mouse wheel report at a cell, as xterm would send it for a
 * wheel turn: SGR (`CSI < 64;col;row M` up, 65 down) once the app asked for
 * mode 1006, which tmux always does, else the X10 default (`CSI M` and three
 * bytes offset by 32, which can't name a cell past 223).
 */
export function wheelSequence(direction: 'up' | 'down', col: number, row: number, sgr: boolean): string {
  const button = direction === 'up' ? 64 : 65;
  if (sgr) return `\x1b[<${button};${col};${row}M`;
  const byte = (n: number) => String.fromCharCode(32 + Math.min(223, n));
  return `\x1b[M${String.fromCharCode(32 + button)}${byte(col)}${byte(row)}`;
}

/** `count` wheel reports: up for a negative count (older lines), down for positive. */
export function wheelReports(count: number, col: number, row: number, sgr: boolean): string {
  if (count === 0) return '';
  return wheelSequence(count < 0 ? 'up' : 'down', col, row, sgr).repeat(Math.abs(count));
}
