import type { Box } from '../api.js';

/**
 * `termag events`: what the stream says (cli/README.md, "Events") and the
 * tracker that decides when to say it. Pure: box lists and status-socket
 * frames in, events out.
 *
 * Optional fields are left out when unknown, never null, so a script reads
 * `stoppedAt` the same way from an orchestrator that sends it and one that
 * does not.
 */
export type TermagEvent = BoxEvent | SessionEvent;

export interface BoxEvent {
  type: 'box';
  /** When this CLI saw the change. */
  at: string;
  box: { id: string; name: string };
  /** The box list's `state` (running, stopping, stopped, starting, …); `terminated` once it leaves the list. */
  state: string;
  /** The state before; null the first time this stream reports the box. */
  previous: string | null;
  agentConnected: boolean;
  /** Why it failed; only with state `failed`. */
  error?: string;
}

export interface SessionEvent {
  type: 'session';
  at: string;
  /** The tmux session, as the orchestrator names it. */
  session: string;
  /** The box it runs on; left out for the orchestrator's own host. `name` is left out for a box not in your box list (a shared project's). */
  box?: { id: string; name?: string };
  /** working, waiting, idle or not_running. */
  status: string;
  /** The status before; null the first time this stream reports the session. */
  previous: string | null;
  /** approval, user_input or unknown; only while waiting. */
  waitingReason?: string;
  /** When it last came to rest (working or waiting to idle or not_running). */
  stoppedAt?: string;
}

/** A status-socket frame, parsed: only what the stream reads. */
export type Frame =
  | { kind: 'status'; session: string; instanceId: string | null; status: string; waitingReason?: string; stoppedAt?: string }
  /** The box list changed (a stop, start, create, rename or terminate was asked for): read it now. */
  | { kind: 'boxes-changed' }
  | { kind: 'other' };

const optionalString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function isoOrUndefined(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** Null for anything that isn't a JSON object with a known `type`; heartbeats and the rest are `other`. */
export function parseFrame(text: string): Frame | null {
  let f: unknown;
  try { f = JSON.parse(text); } catch { return null; }
  if (!f || typeof f !== 'object') return null;
  const o = f as Record<string, unknown>;
  if (o.type === 'status') {
    if (typeof o.session !== 'string' || typeof o.status !== 'string') return null;
    return {
      kind: 'status',
      session: o.session,
      instanceId: typeof o.instanceId === 'string' ? o.instanceId : null,
      status: o.status,
      waitingReason: o.status === 'waiting' ? optionalString(o.waitingReason) : undefined,
      stoppedAt: isoOrUndefined(o.stoppedAt),
    };
  }
  if (o.type === 'workspace') return o.what === 'boxes' ? { kind: 'boxes-changed' } : { kind: 'other' };
  return typeof o.type === 'string' ? { kind: 'other' } : null;
}

/** The box states that change on their own, so the list is read often while any box is in one (the web UI's BoxFeed). */
const SETTLING = new Set(['provisioning', 'awaiting-agent', 'stopping', 'starting', 'hibernating']);

type StatusFrame = Extract<Frame, { kind: 'status' }>;

export class EventTracker {
  private readonly boxes = new Map<string, Box>();
  private readonly sessions = new Map<string, StatusFrame>();

  /** One read of the box list: an event per box that is new, changed state, or is gone. */
  boxList(list: Box[], at: string): BoxEvent[] {
    const events: BoxEvent[] = [];
    const seen = new Set<string>();
    for (const box of list) {
      seen.add(box.id);
      const before = this.boxes.get(box.id);
      this.boxes.set(box.id, box);
      if (before?.state === box.state) continue;
      events.push({
        type: 'box', at, box: { id: box.id, name: box.name }, state: box.state, previous: before?.state ?? null,
        agentConnected: box.agentConnected, ...(box.state === 'failed' && box.error ? { error: box.error } : {}),
      });
    }
    for (const [id, gone] of this.boxes) {
      if (seen.has(id)) continue;
      this.boxes.delete(id);
      events.push({ type: 'box', at, box: { id, name: gone.name }, state: 'terminated', previous: gone.state, agentConnected: false });
    }
    return events;
  }

  /**
   * One status frame: an event when the session is new or its status or
   * waiting reason changed. The rest (context tokens, rate limits, review
   * state) is not a change this stream reports.
   */
  status(f: StatusFrame, at: string): SessionEvent | null {
    const key = `${f.instanceId ?? ''}\u0000${f.session}`;
    const before = this.sessions.get(key);
    this.sessions.set(key, f);
    if (before && before.status === f.status && before.waitingReason === f.waitingReason) return null;
    const boxName = f.instanceId ? this.boxes.get(f.instanceId)?.name : undefined;
    return {
      type: 'session', at, session: f.session,
      ...(f.instanceId ? { box: { id: f.instanceId, ...(boxName ? { name: boxName } : {}) } } : {}),
      status: f.status, previous: before?.status ?? null,
      ...(f.waitingReason ? { waitingReason: f.waitingReason } : {}),
      ...(f.stoppedAt ? { stoppedAt: f.stoppedAt } : {}),
    };
  }

  /** True while a box is in a state that settles on its own. */
  settling(): boolean {
    for (const b of this.boxes.values()) if (SETTLING.has(b.state)) return true;
    return false;
  }
}

/** One line for a person: `2026-10-28T14:05:00.000Z box devbox: running -> stopping`. */
export function describeEvent(e: TermagEvent): string {
  const change = (previous: string | null, now: string) => previous === null ? now : `${previous} -> ${now}`;
  switch (e.type) {
    case 'box':
      return `${e.at} box ${e.box.name}: ${change(e.previous, e.state)}${e.state === 'running' && !e.agentConnected ? ' (agent not connected)' : ''}${e.error ? ` (${e.error})` : ''}`;
    case 'session': {
      const where = e.box ? ` on ${e.box.name ?? e.box.id}` : '';
      return `${e.at} session ${e.session}${where}: ${change(e.previous, e.status)}${e.waitingReason ? ` (${e.waitingReason})` : ''}`;
    }
    default: {
      const exhaustive: never = e;
      return exhaustive;
    }
  }
}
