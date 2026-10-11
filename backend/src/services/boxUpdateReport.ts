/**
 * The outcome of one termag-box-update run, as the box posts it at the end
 * (deploy/termag-box-update, report_outcome): one outcome word and a token
 * per step. Written on the box row so the admin Fleet table shows whether a
 * box pulled, reconciled, installed and restarted, and logged as one journal
 * line in the orchestrator journal, which is where the result
 * of an auto-update was missing: the orchestrator logged that it asked and
 * the box kept the answer in its own journal.
 */
import { prisma } from '../db';

export const BOX_UPDATE_OUTCOMES = ['updated', 'deferred', 'failed', 'skipped', 'current'] as const;
export type BoxUpdateOutcome = typeof BOX_UPDATE_OUTCOMES[number];

export interface BoxUpdateReport {
  outcome: BoxUpdateOutcome;
  /** Step tokens from the script: pull, reconcile, deps, agent. */
  pull: string;
  reconcile: string;
  deps: string;
  agent: string;
  /** The checkout's commit before and after the run; null from a checkout git cannot read. */
  from: string | null;
  to: string | null;
  /** When the box finished, by its clock, trusted ten minutes either way. */
  at: Date;
}

// `pulled:3`, `refused:branch`, `deferred:runner`, `inactive:failed`: a word, an optional `:detail`.
const STEP = /^[a-z][a-z0-9-]{0,31}(?::[a-z0-9][a-z0-9_-]{0,31})?$/;
const SHA = /^[0-9a-f]{40}$/;
const CLOCK_TRUST_MS = 10 * 60 * 1000;

export function parseBoxUpdateReport(body: unknown, now: Date = new Date()): BoxUpdateReport | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (b.event !== 'box-update') return { error: "event must be 'box-update'" };
  if (typeof b.outcome !== 'string' || !(BOX_UPDATE_OUTCOMES as readonly string[]).includes(b.outcome)) return { error: `outcome must be one of ${BOX_UPDATE_OUTCOMES.join(', ')}` };
  const step = (k: string): string | { error: string } => (typeof b[k] === 'string' && STEP.test(b[k] as string) ? b[k] as string : { error: `${k} must be a short token` });
  const pull = step('pull'), reconcile = step('reconcile'), deps = step('deps'), agent = step('agent');
  for (const v of [pull, reconcile, deps, agent]) if (typeof v !== 'string') return v;
  const sha = (k: string): string | null | { error: string } => (b[k] === undefined || b[k] === null ? null : typeof b[k] === 'string' && SHA.test(b[k] as string) ? b[k] as string : { error: `${k} must be a full sha` });
  const from = sha('from'), to = sha('to');
  if (from !== null && typeof from !== 'string') return from;
  if (to !== null && typeof to !== 'string') return to;
  let at = now;
  if (b.at !== undefined && b.at !== null) {
    const t = typeof b.at === 'string' ? Date.parse(b.at) : NaN;
    if (Number.isNaN(t)) return { error: 'at must be an ISO-8601 timestamp' };
    if (Math.abs(t - now.getTime()) <= CLOCK_TRUST_MS) at = new Date(t);
  }
  return { outcome: b.outcome as BoxUpdateOutcome, pull: pull as string, reconcile: reconcile as string, deps: deps as string, agent: agent as string, from, to, at };
}

/** "pull=pulled:3 reconcile=clean deps=installed agent=restarted": the detail the Fleet table shows on hover. */
export function reportDetail(r: Pick<BoxUpdateReport, 'pull' | 'reconcile' | 'deps' | 'agent'>): string {
  return `pull=${r.pull} reconcile=${r.reconcile} deps=${r.deps} agent=${r.agent}`;
}

export interface RecordedReport { boxName: string; owner: string | null }

/** Writes the report on the box row. Null when the box is unknown. */
export async function recordBoxUpdateReport(instanceId: string, r: BoxUpdateReport): Promise<RecordedReport | null> {
  const box = await prisma.instance.findUnique({ where: { id: instanceId }, select: { name: true, user: { select: { unixUsername: true } } } });
  if (!box) return null;
  await prisma.instance.update({
    where: { id: instanceId },
    data: { lastUpdateAt: r.at, lastUpdateOutcome: r.outcome, lastUpdateDetail: reportDetail(r), lastUpdateCommit: r.to ?? r.from },
  });
  return { boxName: box.name, owner: box.user?.unixUsername ?? null };
}

/** The last report as the admin reads it. */
export interface LastBoxUpdate { at: string; outcome: string; detail: string | null; commit: string | null }

export function lastBoxUpdateOf(r: { lastUpdateAt: Date | null; lastUpdateOutcome: string | null; lastUpdateDetail: string | null; lastUpdateCommit: string | null }): LastBoxUpdate | null {
  if (!r.lastUpdateAt || !r.lastUpdateOutcome) return null;
  return { at: r.lastUpdateAt.toISOString(), outcome: r.lastUpdateOutcome, detail: r.lastUpdateDetail, commit: r.lastUpdateCommit };
}
