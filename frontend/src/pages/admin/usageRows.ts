import { shortDate } from '../dashboard/range';

/** A grouped admin report: the grouping it was computed for, and its rows. */
export interface GroupedReport<G extends string, R extends { keys: string[] }> {
  groupBy: G[];
  rows: R[];
}

/**
 * Chart rows for a grouped report, shaped by the grouping the report carries
 * rather than the picker. Right after a picker click the previous report is
 * still on screen until the new one lands; labelling its user or host rows as
 * dates rendered "undefined undefined". The picker only decides while there
 * is no report yet. Day groupings chart in date order; others chart the first
 * `top` rows (the table twin keeps all of them).
 */
export function groupedChartRows<G extends string, R extends { keys: string[] }>(
  report: GroupedReport<G, R> | null | undefined,
  picker: G,
  labelOf: (row: R) => string,
  top = 25,
): { group: G; rows: Array<R & { label: string }>; chart: Array<R & { label: string }> } {
  const group = report?.groupBy[0] ?? picker;
  const rows = (report?.rows ?? []).map(r => ({ ...r, label: group === 'day' ? shortDate(r.keys[0]) : labelOf(r) }));
  const chart = group === 'day' ? [...rows].sort((a, b) => a.keys[0].localeCompare(b.keys[0])) : rows.slice(0, top);
  return { group, rows, chart };
}
