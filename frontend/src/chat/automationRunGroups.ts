// The simple UI's side of an automation's runs as one folded row
// (utils/automationRuns.ts): which automations the person unfolded, shared by
// the sidebar and the explorers for the page's life, and the automations
// themselves (schedule, timezone) for the folded row's subtitle.
import { useEffect, useSyncExternalStore } from 'react';
import { automationsApi, type AutomationView } from '../services/api';

let unfolded: ReadonlyMap<string, boolean> = new Map();
const listeners = new Set<() => void>();
const subscribeUnfolded = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** Whether the person unfolded (true) or folded (false) each automation's runs, by project id; one they left alone isn't here. */
export function useUnfoldedRuns(): ReadonlyMap<string, boolean> {
  return useSyncExternalStore(subscribeUnfolded, () => unfolded);
}

export function setRunsUnfolded(projectId: string, open: boolean): void {
  if (unfolded.get(projectId) === open) return;
  unfolded = new Map(unfolded).set(projectId, open);
  listeners.forEach(l => l());
}

/** For tests: every automation left alone again. */
export function resetUnfoldedRuns(): void {
  unfolded = new Map();
  listeners.forEach(l => l());
}

let automations: ReadonlyMap<string, AutomationView> = new Map();
const automationListeners = new Set<() => void>();
let users = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const load = () => automationsApi.list()
  .then(list => { automations = new Map(list.map(a => [a.projectId, a])); automationListeners.forEach(l => l()); })
  .catch(() => {});
const subscribeAutomations = (l: () => void) => { automationListeners.add(l); return () => { automationListeners.delete(l); }; };

/**
 * The automations by project id, loaded while a list shows automation runs
 * (`wanted`) and polled gently, as the full UI's project tree does; empty
 * until the first answer, and on a server without the route.
 */
export function useAutomationIndex(wanted: boolean): ReadonlyMap<string, AutomationView> {
  useEffect(() => {
    if (!wanted) return;
    if (users++ === 0) { void load(); timer = setInterval(load, 30_000); }
    return () => { if (--users === 0 && timer) { clearInterval(timer); timer = null; } };
  }, [wanted]);
  return useSyncExternalStore(subscribeAutomations, () => automations);
}
