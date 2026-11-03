// An automation's runs as one row in a sidebar: the
// full UI's project tree and the simple UI's lists show the automation once,
// folded, with its latest run's status and how many runs it has; unfolded,
// its newest runs, up to RUNS_SHOWN, then "Show all" on its page. Pure, so
// both UIs share it.
import type { AgentStatusValue } from '../types';
import { automationSubtitle, describeSchedule, occurrenceShort } from './automationSchedule';

/** How many runs an unfolded automation lists before "Show all". */
export const RUNS_SHOWN = 10;

/** The automation's own page, where every run is. */
export function automationHref(projectId: string): string {
  return `/automations/${encodeURIComponent(projectId)}`;
}

/** "Wed 18:00" for `run-20261028-1800` (in the automation's zone), "(2)" after a same-minute rerun; any other name as it is. */
export function runLabel(name: string, timezone?: string, now?: Date): string {
  const m = /^run-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(?:-(\d+))?$/.exec(name);
  if (!m) return name;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`;
  return `${occurrenceShort(iso, timezone ?? 'UTC', now)}${m[6] ? ` (${m[6]})` : ''}`;
}

/** The folded row's subtitle: the schedule in words, or why it isn't running (paused, off). */
export function runsSubtitle(a: Parameters<typeof automationSubtitle>[0] & { schedule: string; timezone: string }, now?: Date): string {
  if (a.pausedReason || !a.enabled) return automationSubtitle(a, a.timezone, now);
  // An every-N-minutes or every-N-hours cron, which a sidebar row has room to say but describeSchedule spells as cron.
  const every = /^(?:\*\/(\d+) \* |0 \*\/(\d+) )\* \* \*$/.exec(a.schedule.trim().replace(/\s+/g, ' '));
  if (every) return every[1] ? `every ${every[1]} min` : `every ${every[2]} h`;
  return describeSchedule(a.schedule, a.timezone);
}

// A run's name is its occurrence (run-<yyyymmdd>-<hhmm>, -<n> for a rerun in the same minute), so it sorts by time.
const runOrder = (name: string): [string, number] => {
  const m = /^(run-\d{8}-\d{4})(?:-(\d+))?$/.exec(name);
  return m ? [m[1], Number(m[2] ?? 0)] : [name, 0];
};

/** `runs` newest first. */
export function newestRunsFirst<T>(runs: readonly T[], nameOf: (run: T) => string): T[] {
  return [...runs].sort((a, b) => {
    const [an, ai] = runOrder(nameOf(a));
    const [bn, bi] = runOrder(nameOf(b));
    return bn.localeCompare(an) || bi - ai;
  });
}

/** The folded row's status: working while any run works, else the latest run's. `statuses` newest first. */
export function runsStatus<S extends string = AgentStatusValue>(statuses: readonly S[]): S | 'not_running' {
  return statuses.find(s => s === 'working') ?? statuses[0] ?? 'not_running';
}

/**
 * The runs an unfolded automation lists: the newest `max`, and the open one
 * when it is older than those, so the open run always has its row.
 */
export function shownRuns<T>(runs: readonly T[], isOpen: (run: T) => boolean, max = RUNS_SHOWN): T[] {
  const shown = runs.slice(0, max);
  const open = runs.slice(max).find(isOpen);
  return open ? [...shown, open] : shown;
}

/**
 * Whether an automation's runs are listed: as the person last left it
 * (`chosen`, by project id), else only when one of its runs is the open
 * conversation, so a run opened from anywhere has its row in view.
 */
export function runsUnfolded(projectId: string, chosen: ReadonlyMap<string, boolean>, open: { projectId: string; workstream: string } | null): boolean {
  return chosen.get(projectId) ?? (open?.projectId === projectId && open.workstream !== 'main');
}

/** What a list row needs for its runs to be grouped: an automation's workstream other than main. */
export interface RunLike { projectId: string; projectName: string; workstream: string; kind?: string | null }

export interface RunGroup<T> { projectId: string; projectName: string; runs: T[] }

export type Grouped<T> = { item: T; group?: undefined } | { group: RunGroup<T>; item?: undefined };

/**
 * `items` with each automation's runs as one group, where its first run was,
 * and the group's runs newest first. `runOf` is the row behind an item, or
 * null for one that stays as it is (a nested row, say).
 */
export function groupRuns<T>(items: readonly T[], runOf: (item: T) => RunLike | null | undefined): Array<Grouped<T>> {
  const out: Array<Grouped<T>> = [];
  const groups = new Map<string, RunGroup<T>>();
  for (const item of items) {
    const r = runOf(item);
    if (!r || r.kind !== 'automation' || r.workstream === 'main') { out.push({ item }); continue; }
    let g = groups.get(r.projectId);
    if (!g) {
      g = { projectId: r.projectId, projectName: r.projectName, runs: [] };
      groups.set(r.projectId, g);
      out.push({ group: g });
    }
    g.runs.push(item);
  }
  for (const g of groups.values()) g.runs = newestRunsFirst(g.runs, t => runOf(t)!.workstream);
  return out;
}

/**
 * A tree's rows (each child right after its parent, as agentTree.nestInOrder
 * lays them out) cut into subtrees: each top-level row with the rows under
 * it. Grouping those (groupRuns over each subtree's first row) keeps what a
 * run started under that run, inside its automation's row.
 */
export function subtrees<T>(rows: readonly T[], depthOf: (row: T) => number): T[][] {
  const out: T[][] = [];
  for (const r of rows) {
    if (depthOf(r) === 0 || !out.length) out.push([r]);
    else out[out.length - 1].push(r);
  }
  return out;
}
