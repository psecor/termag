// Reconnect decisions for one terminal pane, kept free of React, xterm and the
// DOM so the loop can be unit-tested. Terminal.tsx owns the socket and timers
// and feeds every socket event through `step`; the returned effects say what
// to write, when to dial again and which overlay to show.
//
// A pane whose box is powered down is a special case. The backend accepts the
// upgrade, sends a `box-power` frame (plus a plain-output copy for tabs on an
// older bundle) and closes with BOX_PARKED_CLOSE_CODE. Treated as an ordinary
// drop, every such socket opened (`[reconnected]`, budget reset to zero) and
// closed again, so the pane redialled every half second and appended the
// message each time. Here a stopping or stopped box waits for its status to
// change, and a starting one polls slowly without writing anything.

import type { InstanceStatus } from '../types';
import type { TerminalPaneState } from './connection';

/** Mirrors TERMINAL_BOX_PARKED_CLOSE_CODE in backend/src/services/boxPowerPolicy.ts. */
export const BOX_PARKED_CLOSE_CODE = 4409;

// Reconnect schedule. The first five attempts (~7.5s total) cover transient
// blips — agent restart, server restart, network hiccup — after which we
// surface the overlay. Retries then CONTINUE indefinitely at the capped
// delay, so a pane left open through a longer outage (VPN drop, laptop
// sleep) comes back on its own instead of sitting dead behind a modal.
export const RECONNECT_DELAYS_MS = [0, 500, 1000, 2000, 4000, 8000, 15_000, 30_000];
export const FAILED_AFTER_ATTEMPTS = 5;

/**
 * How often a pane on a starting box dials again. The box list polls every 5s
 * while a box is in transition and kicks the pane as soon as it reads ready,
 * so this only matters when that poll isn't running.
 */
export const STARTING_POLL_MS = 10_000;

export type BoxParkedStatus = 'stopping' | 'stopped' | 'starting' | 'hibernating' | 'hibernated';
const BOX_PARKED_STATUSES: readonly string[] = ['stopping', 'stopped', 'starting', 'hibernating', 'hibernated'];

export interface BoxParkedNotice {
  instanceId: string;
  status: BoxParkedStatus;
  message: string;
}

export function parseBoxParkedNotice(msg: unknown): BoxParkedNotice | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'box-power') return null;
  if (typeof m.instanceId !== 'string' || typeof m.message !== 'string') return null;
  if (typeof m.status !== 'string' || !BOX_PARKED_STATUSES.includes(m.status)) return null;
  return { instanceId: m.instanceId, status: m.status as BoxParkedStatus, message: m.message };
}

export interface PaneLoop {
  /** Failed dials since the last successful attach; indexes RECONNECT_DELAYS_MS. */
  attempt: number;
  /** Why the box can't be reached, from the last `box-power` frame; null when it isn't parked. */
  parked: BoxParkedNotice | null;
  /** The current socket carried a `box-power` frame, so its plain output is the legacy copy. */
  parkedThisSocket: boolean;
}

export const initialPaneLoop: PaneLoop = { attempt: 0, parked: null, parkedThisSocket: false };

export type PaneEvent =
  | { type: 'dial' }
  | { type: 'open' }
  | { type: 'box-power'; notice: BoxParkedNotice }
  | { type: 'output' }
  | { type: 'close'; code: number }
  /** `ownBox`: the box is the one this pane's project lives on. */
  | { type: 'box-status'; instanceId: string; status: InstanceStatus; ownBox: boolean }
  | { type: 'retry' };

export interface PaneEffects {
  /** Pane state to show; absent means unchanged. */
  paneState?: TerminalPaneState;
  /** Write `[reconnected]` before anything else. */
  announceReconnected?: boolean;
  /** For `output`: whether to write the frame's data to the terminal. */
  write?: boolean;
  /** Dial again after this many ms. Absent means don't schedule anything. */
  retryInMs?: number;
  /** Dial again now, cancelling any pending timer. */
  dialNow?: boolean;
}

export function step(s: PaneLoop, e: PaneEvent): { loop: PaneLoop; fx: PaneEffects } {
  switch (e.type) {
    case 'dial':
      return {
        loop: { ...s, parkedThisSocket: false },
        fx: { paneState: s.parked ? 'parked' : s.attempt === 0 ? 'connecting' : 'reconnecting' },
      };

    case 'open':
      // A parked box's socket opens only to be refused, so it proves nothing.
      // The first output on it decides (see `output`).
      if (s.parked) return { loop: s, fx: {} };
      return {
        loop: { ...s, attempt: 0 },
        fx: { paneState: 'connected', announceReconnected: s.attempt > 0 },
      };

    case 'box-power':
      return { loop: { ...s, parked: e.notice, parkedThisSocket: true }, fx: { paneState: 'parked' } };

    case 'output':
      if (s.parkedThisSocket) return { loop: s, fx: { write: false } };
      if (s.parked) {
        // Output with no box-power frame ahead of it: the box is back.
        return {
          loop: { ...s, parked: null, attempt: 0 },
          fx: { paneState: 'connected', announceReconnected: true, write: true },
        };
      }
      return { loop: s, fx: { write: true } };

    case 'close': {
      if (e.code === BOX_PARKED_CLOSE_CODE && s.parked && s.parkedThisSocket) {
        return {
          loop: s,
          fx: s.parked.status === 'starting'
            ? { paneState: 'parked', retryInMs: STARTING_POLL_MS }
            : { paneState: 'parked' },
        };
      }
      // Any other close, including one that ended a parked pane's attempt
      // some other way, goes back to the ordinary schedule.
      const attempt = s.attempt + 1;
      return {
        loop: { ...s, parked: null, parkedThisSocket: false, attempt },
        fx: {
          paneState: attempt >= FAILED_AFTER_ATTEMPTS ? 'failed' : 'reconnecting',
          retryInMs: RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)],
        },
      };
    }

    case 'box-status':
      if (!s.parked) {
        // The backend doesn't close a pane's socket when its box's agent goes
        // away, so a pane left open across a stop sits on a dead socket.
        // Dialling again swaps it for the parked notice.
        const goingDown = e.status === 'stopping' || e.status === 'stopped'
          || e.status === 'hibernating' || e.status === 'hibernated';
        return { loop: s, fx: e.ownBox && goingDown ? { dialNow: true } : {} };
      }
      if (s.parked.instanceId !== e.instanceId || s.parked.status === e.status) {
        return { loop: s, fx: {} };
      }
      return { loop: s, fx: { dialNow: true } };

    case 'retry':
      return { loop: { ...s, attempt: 0 }, fx: { dialNow: true } };
  }
}
