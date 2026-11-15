/**
 * The Software tab's grading of the tools termag updates (services/toolUpdate/components.ts), against
 * each box's own policy: its floor, its target and its mode ("Tools termag
 * updates"). The same comparison the fleet update makes (services/toolUpdate/fleet.ts behindReference
 * and compareToReference), so a cell, the counts and the "Update behind (N)" button agree. Pure:
 * queries.ts reads the policies and the inventory.
 */
import type { ToolUpdateMode } from '../claudeUpdatePolicy';
import { behindReference, compareToReference } from '../toolUpdate/fleet';
import { toolState, type Observed, type SoftwareState } from './versions';

/** What a tool's cell was graded against: shown in its hover, and what the tab's fleet count reads. */
export interface CellPolicy {
  /** The policy's mode for the box's owner and the box: off holds the tool where it is. */
  mode: ToolUpdateMode;
  /** The policy's floor, the security minimum. */
  floor: string;
  /** The policy's target as written: a tag (`latest`) or an exact version. */
  target: string;
  /**
   * What "behind" compares with (behindReference): the exact target, the version a tool's latest is
   * pinned to (the Cursor agent's, pi's), else the newest version on the fleet's boxes. Null when
   * nothing in the fleet has a version to compare with.
   */
  reference: string | null;
}

/** The policy, as each tool's parser gives it (ToolUpdatePolicy), and how its tool reads versions. */
export interface PolicyInput { mode: ToolUpdateMode; floor: string; target: string }
export interface ToolVersions { isVersion: (v: unknown) => v is string; latestReference?: string }

/** A box's CellPolicy for one tool: its policy, and the reference behindReference takes from it. */
export function cellPolicy(policy: PolicyInput, fleetVersions: Array<string | null>, tool: ToolVersions): CellPolicy {
  return { mode: policy.mode, floor: policy.floor, target: policy.target, reference: behindReference(policy.target, fleetVersions, tool.isVersion, tool.latestReference) };
}

/**
 * A tool on a box against its policy:
 * - `below-floor`: older than the floor (only its day, for a dated build, as on the box). It wins
 *   over every other state: the floor stays with the mode off (gate.ts).
 * - `current`: on the reference; `ahead`: newer than it (a hand install, a canary).
 * - `held`: older than the reference with the mode off: nothing updates it, on purpose.
 * - `behind`: older than the reference, at or above the floor.
 * - `missing` and `unknown` as toolState: not installed; unreadable, or nothing to compare with.
 * No `outdated`: how far behind is not the question, the floor is.
 */
export function policyToolState(o: Observed | null, p: CellPolicy): SoftwareState {
  if (!o) return 'unknown';
  if (!o.ok) return o.path ? 'unknown' : 'missing';
  if (!o.version) return 'unknown';
  const floor = compareToReference(o.version, p.floor, true);
  if (floor !== null && floor < 0) return 'below-floor';
  if (!p.reference) return 'unknown';
  const c = compareToReference(o.version, p.reference);
  if (c === null) return 'unknown';
  if (c === 0) return 'current';
  if (c > 0) return 'ahead';
  return p.mode === 'off' ? 'held' : 'behind';
}

/**
 * A box with no owner (the warm pool) has no policy: nothing updates it until someone takes it, and
 * its first policy read does. Graded against the fleet's reference, anything older is `held`.
 */
export function unownedToolState(o: Observed | null, reference: string | null): SoftwareState {
  const s = toolState(o, reference, compareToReference);
  return s === 'behind' || s === 'outdated' ? 'held' : s;
}

/** The summary's reference for a tool: the one every box shares, else each distinct one, most common first. */
export function policyReferenceText(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  const list = [...counts].sort((a, b) => b[1] - a[1]).map(([v]) => v);
  return list.length ? list.join(' · ') : null;
}
