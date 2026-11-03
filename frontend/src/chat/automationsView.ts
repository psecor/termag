// Pure pieces of the simple UI's automations (pages/chat/automations/,
// behind simple-ui-automations-enabled): an automation's page under /chat,
// the state chip's words, and what one run row says. An automation is a project of kind `automation`; each run is
// a workstream there whose conversation is that workstream's chat,
// so a run row opens /chat/p/<project>?ws=<run>.
import type { AutomationRunView, AutomationView } from '../services/api';
import { RUN_STATE_LABEL, agoLabel, occurrenceShort } from '../utils/automationSchedule';
import { fmtDurationShort } from '../utils/format';

/** An automation's page in the simple UI; `id` is the automation's or its project's (the backend takes either). */
export function automationHref(id: string): string {
  return `/chat/automations/${encodeURIComponent(id)}`;
}

/** Whether `id` (from the URL) names this automation, by its own id or its project's. */
export function matchesAutomation(a: Pick<AutomationView, 'id' | 'projectId'>, id: string): boolean {
  return a.id === id || a.projectId === id;
}

export type AutomationTone = 'on' | 'off' | 'paused' | 'archived';

/** On, off (the owner turned the schedule off), paused (the scheduler stopped it, with why) or archived. */
export function automationState(a: Pick<AutomationView, 'enabled' | 'pausedReason' | 'archived'>): { tone: AutomationTone; label: string; title: string } {
  if (a.archived) return { tone: 'archived', label: 'Archived', title: 'Archived: it no longer runs' };
  if (a.pausedReason) {
    const why = a.pausedReason === 'consecutive_failures' ? 'it kept failing' : a.pausedReason === 'box_gone' ? 'its box is gone' : a.pausedReason;
    return { tone: 'paused', label: 'Paused', title: `The scheduler paused it: ${why}. Resume clears the pause.` };
  }
  return a.enabled
    ? { tone: 'on', label: 'On', title: 'Runs on its schedule' }
    : { tone: 'off', label: 'Off', title: 'The schedule is off; Run now still works' };
}

export function isLiveRun(r: Pick<AutomationRunView, 'state'> | null | undefined): boolean {
  return r?.state === 'pending' || r?.state === 'running';
}

export interface RunRowText {
  /** The occurrence, "Mon 09:00", in the automation's zone. */
  when: string;
  trigger: string;
  state: string;
  /** Duration and cost, joined; empty while neither is known. */
  took: string;
  changes: string | null;
}

/** What one row of an automation's run history says. */
export function runRowText(r: AutomationRunView, timezone: string, now: Date = new Date()): RunRowText {
  const state = RUN_STATE_LABEL[r.state] ?? r.state;
  const took = [
    r.durationSec !== null ? fmtDurationShort(r.durationSec * 1000) : r.finishedAt ? agoLabel(r.finishedAt, now) : '',
    r.costUsd !== null ? `$${r.costUsd.toFixed(2)}` : '',
  ].filter(Boolean).join(' · ');
  return {
    when: occurrenceShort(r.scheduledFor, timezone, now),
    trigger: r.trigger === 'manual' ? 'run by hand' : 'scheduled',
    state: r.reasonLabel && (r.state === 'skipped' || r.state === 'failed' || r.state === 'blocked') ? `${state}: ${r.reasonLabel}` : state,
    took,
    changes: r.changesLabel,
  };
}

/**
 * What an automation's page shows: the detail it fetched for this id when it
 * has one, else the shared list's entry, so a failed or slow detail fetch
 * keeps the header, facts and actions on screen. A detail for another id
 * (a stale answer) is never shown.
 */
export function shownAutomation<D extends AutomationView>(id: string, detail: D | null, list: readonly AutomationView[] | null): D | AutomationView | null {
  if (detail && matchesAutomation(detail, id)) return detail;
  return list?.find(a => matchesAutomation(a, id)) ?? null;
}

export function errorText(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}
