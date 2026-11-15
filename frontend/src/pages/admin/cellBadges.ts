/**
 * The Software tab's badges in a tool's cell: what stands between the box and its update, or what is
 * on its way, in a word or two. They replace the tab's
 * "last <tool> update" columns: the cell's hover keeps the run's whole line. Pure.
 */
import type { SoftwareCell, SoftwareUpdateRun } from '../../services/adminApi';
import { INVENTORY_STALE_MS, REFUSAL_TEXT, refusalBlocks, runClass, runReason, runStateText } from '../../utils/toolUpdate';
import { fmtAge } from '../../utils/format';

export interface CellBadge { text: string; className: '' | 'admin-ok' | 'admin-warn' | 'admin-bad' | 'usage-dim' }

/** The sweep's skips the backend puts on a cell (backend services/software/queries.ts SWEEP_BLOCKS), in words. */
const SWEEP: Record<string, string> = { 'floor-failing': 'floor runs failing', 'backing-off': 'backing off', 'not-capable': 'agent can’t update' };

/**
 * A cell's badges, most pressing first: a run on its way (updating, queued for the next start); the
 * newest run failing, refused or partial, with why, unless the cell is current since; the sweep's last
 * pass blocked (floor runs failing, backing off, the agent can't update); held, by the mode or for want
 * of an owner; and stale, when a connected host's row is older than the fleet will count
 * (INVENTORY_STALE_MS): its agent no longer reports the tool, or its sweeps fail.
 */
/**
 * A finished run's badge: its outcome when it failed, was refused or partial and the tool is not current
 * since. Also for a host with no inventory row for the tool (Devin on #1608). Whether a run is still on its
 * way is not this list's to say (a run at requested or running has no outcome here): the matrix's
 * `inFlight` says it, as the backend's runActive decides (Bugbot and Devin on #1608).
 */
export function runBadge(run: SoftwareUpdateRun | undefined, current: boolean): CellBadge | null {
  if (!run || current) return null;
  const cls = runClass(run);
  if (cls !== 'admin-bad' && cls !== 'admin-warn') return null;
  const why = runReason(run.detail);
  return { text: `${runStateText(run)}${why ? `: ${why.text}` : ''}`, className: cls };
}

/** States with no update due: a sweep block or a refusal says nothing about them (Bugbot on #1608). */
const NOTHING_DUE = new Set(['current', 'ahead']);

/** The cell's run in flight, from the matrix (runActive), whether or not it is among the last runs the tab read. */
export function inFlightBadge(cell: SoftwareCell): CellBadge | null {
  const f = cell.inFlight;
  if (!f) return null;
  return { text: f.status === 'requested' && f.atStart ? 'queued for next start' : 'updating', className: '' };
}

export function cellBadges(cell: SoftwareCell, run: SoftwareUpdateRun | undefined, offline: boolean, now: number): CellBadge[] {
  const out: CellBadge[] = [];
  const flight = inFlightBadge(cell);
  if (flight) out.push(flight);
  const due = !NOTHING_DUE.has(cell.state);
  // Only a current tool hides a failed run: an ahead one's failure is still news (Devin on #1608).
  const r = runBadge(run, cell.state === 'current');
  if (r) out.push(r);
  // Below a floor or behind, and the fleet update would skip it: say why. Not for a run in flight (it says
  // updating) or the orchestrator (its hover names its own action), and not for an offline host or a row
  // over a day old, which the host's "offline" and the stale badge already say.
  const refused = (cell.state === 'below-floor' || cell.state === 'behind') && refusalBlocks(cell.refusal) && cell.refusal !== 'offline' && cell.refusal !== 'no_inventory';
  if (refused) out.push({ text: `not updated here: ${REFUSAL_TEXT[cell.refusal!]}`, className: 'admin-warn' });
  // The last pass's block, while an update is still due: a cell current since says nothing of it. An agent
  // that can't is said once: by the badge above when that is the refusal.
  // Nor while a run is on its way, as the matrix's inFlight says (runActive): the last pass's skip no longer
  // explains the box. A run runActive no longer counts (stuck past its expiry) leaves the sweep's badge be.
  const flying = !!cell.inFlight;
  if (due && !flying && cell.sweep && SWEEP[cell.sweep.why] && !(refused && cell.sweep.why === 'not-capable' && cell.refusal === 'not_capable')) {
    out.push({ text: SWEEP[cell.sweep.why], className: cell.sweep.why === 'floor-failing' ? 'admin-bad' : 'admin-warn' });
  }
  if (cell.state === 'held') out.push({ text: cell.policyUnavailable ? 'held: policy unavailable' : cell.policy ? 'held: mode off' : 'held: no owner', className: 'usage-dim' });
  // An offline host's cells are dimmed but carry no badge each: its host cell already says offline.
  const age = now - Date.parse(cell.observedAt);
  if (!offline && age > INVENTORY_STALE_MS) out.push({ text: `stale ${fmtAge(age)}`, className: 'usage-dim' });
  return out;
}

/** Whether the cell is shown dimmed: its row is older than the fleet will count, or its host is offline. */
export const isStale = (cell: SoftwareCell, offline: boolean, now: number): boolean => offline || now - Date.parse(cell.observedAt) > INVENTORY_STALE_MS;
