// Haiku's headings for runs of tool calls.
// The box asks as a run starts and
// pushes its answer once as a `tool-group-heading` frame keyed to the run
// (agent/tool-group-headings.js): the heading, or that it failed and after
// how many calls. The chat's history carries the answers it kept, so a reload
// shows the same. They are held here, outside the chat's state, so an answer
// that arrives re-renders its own run and not the whole transcript.
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { HeadlineSource, RunAnswer } from './toolRuns';

const MAX_HEADING_CHARS = 80;

export interface HeadingStore {
  get(runKey: string): RunAnswer | null;
  /** Put the history's answers in place, keeping any a frame brought meanwhile. */
  load(answers: unknown): void;
  /** One answer from a frame. The first answer for a run stands; a later one is dropped. */
  add(runKey: string, answer: RunAnswer): void;
  subscribe(runKey: string, listener: () => void): () => void;
  /**
   * When this page first waited on the run for an answer, set by the first
   * call (`now`) and kept: the wait is the run's, not a ToolRun's, so a
   * redraw that mounts a new one (a history reload re-keys a reply) neither
   * restarts nor extends it. Called without `now`, only reads it.
   */
  waitSince(runKey: string, now?: number): number | null;
  /** The heading line chosen for the run, once one has been: kept for every later ToolRun of it. */
  chosen(runKey: string): { text: string; source: HeadlineSource } | null;
  choose(runKey: string, line: { text: string; source: HeadlineSource }): void;
}

/** A heading as the run shows it: one line, at most MAX_HEADING_CHARS; null for anything else. */
export function cleanHeading(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const line = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > MAX_HEADING_CHARS ? `${line.slice(0, MAX_HEADING_CHARS - 1)}…` : line;
}

/**
 * An answer as the box writes it, `{ heading }` or `{ failed: true, calls }`.
 * Any other object (an empty or unusable heading, a shape this page doesn't
 * know) is a failure: the run takes its fallback rather than wait on. Null
 * only for no object at all.
 */
export function answerOf(value: unknown): RunAnswer | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { heading?: unknown; failed?: unknown; calls?: unknown };
  const heading = cleanHeading(v.heading);
  if (heading) return { heading };
  return { failed: true, calls: Number.isInteger(v.calls) ? v.calls as number : null };
}

export function createHeadingStore(): HeadingStore {
  const answers = new Map<string, RunAnswer>();
  const waits = new Map<string, number>();
  const lines = new Map<string, { text: string; source: HeadlineSource }>();
  const listeners = new Map<string, Set<() => void>>();
  const put = (runKey: string, answer: RunAnswer | null) => {
    if (typeof runKey !== 'string' || !runKey || !answer || answers.has(runKey)) return;
    answers.set(runKey, answer);
    for (const l of listeners.get(runKey) ?? []) l();
  };
  return {
    get: runKey => answers.get(runKey) ?? null,
    load(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      for (const [runKey, entry] of Object.entries(value as Record<string, unknown>)) put(runKey, answerOf(entry));
    },
    add: (runKey, answer) => put(runKey, answerOf(answer)),
    waitSince(runKey, now) {
      if (now != null && !waits.has(runKey)) waits.set(runKey, now);
      return waits.get(runKey) ?? null;
    },
    chosen: runKey => lines.get(runKey) ?? null,
    choose(runKey, line) { if (!lines.has(runKey)) lines.set(runKey, line); },
    subscribe(runKey, listener) {
      let set = listeners.get(runKey);
      if (!set) { set = new Set(); listeners.set(runKey, set); }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(runKey);
      };
    },
  };
}

/** A chat frame's answer, `{ runKey, answer }`, or null for any other frame. */
export function headingOfEvent(event: unknown): { runKey: string; answer: RunAnswer } | null {
  if (!event || typeof event !== 'object') return null;
  const e = event as { type?: unknown; runKey?: unknown };
  if (e.type !== 'tool-group-heading' || typeof e.runKey !== 'string' || !e.runKey) return null;
  const answer = answerOf(event);
  return answer ? { runKey: e.runKey, answer } : null;
}

/** The open chat's answers; null outside it (no SdkChatView above), and runs then have no headings from Haiku. */
export const HeadingStoreContext = createContext<HeadingStore | null>(null);

const noop = () => () => {};

/** Whether Haiku's headings are in reach (the open chat's store), and the box's answer for the run once there is one. */
export function useToolGroupAnswer(runKey: string): { store: HeadingStore | null; headingsOn: boolean; answer: RunAnswer | null } {
  const store = useContext(HeadingStoreContext);
  const subscribe = useCallback((l: () => void) => (store ? store.subscribe(runKey, l) : noop()), [store, runKey]);
  const answer = useSyncExternalStore(subscribe, () => (store ? store.get(runKey) : null));
  return { store, headingsOn: store != null, answer };
}
