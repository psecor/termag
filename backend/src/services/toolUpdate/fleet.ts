/**
 * The fleet update (POST /api/admin/software/update): which hosts a scope
 * takes, why the others in it are skipped, and how many runs may start now.
 * Pure: runs.ts gathers the facts and starts the runs.
 */
import { compareVersions, newestVersion } from '../software/versions';
import { isClaudeVersion } from '../claudeUpdatePolicy';

/**
 * The fleet update starts a queued run only while fewer than this many runs
 * are in flight: a bad release, or a restart that goes wrong, reaches ten
 * boxes before anyone looks. The count is every run in flight, whatever
 * started it. A single-host update (an admin's one box) and a floor run (a
 * box below the floor holding a cloud session up) are not queued behind it,
 * so they can take the total past ten, but the fleet never adds ten on top.
 */
export const FLEET_IN_FLIGHT = 10;

export const SCOPES = ['below-floor', 'behind', 'all'] as const;
export type FleetScope = typeof SCOPES[number];
export const isScope = (v: unknown): v is FleetScope => typeof v === 'string' && (SCOPES as readonly string[]).includes(v);

export type HostRefusal = 'claude_update_off' | 'offline' | 'not_capable' | 'run_in_flight';
/**
 * What a host's inventory says about the tool: a version (`ok`); no binary on the probe's path
 * (`not_installed`, the matrix's `missing`); a binary whose output gave no version
 * (`version_unreadable`, the matrix's `unknown`); or no row for the tool newer than
 * INVENTORY_STALE_MS (`no_inventory`: the box's agent never probed it, or stopped).
 */
export type InventoryState = 'ok' | 'not_installed' | 'version_unreadable' | 'no_inventory';
/**
 * Why a host in a below-floor or behind scope is skipped: a refusal (the flag, offline, ...), or
 * why its version can't be compared. `unknown_version` is left for a version the inventory read
 * that still compares with nothing: no reference to compare with (behind under latest, with no
 * version anywhere in the fleet), or a version that doesn't parse.
 */
export type FleetSkip = HostRefusal | Exclude<InventoryState, 'ok'> | 'unknown_version';
/**
 * How old a host's inventory row for the tool may be and still count. Boxes are inventoried on
 * connect and every 6 hours (services/software/collector.ts), so a connected box whose row is older
 * than four sweeps no longer reports the tool: its agent dropped the probe, or its sweeps fail.
 */
export const INVENTORY_STALE_MS = 24 * 3600_000;

export interface HostFacts {
  hostKey: string;
  /** The box's agent is connected now. */
  connected: boolean;
  /** It announces tool-update-v1. */
  capable: boolean;
  /** The tool's enabled (its policy's mode not off) for the box's owner and the box. */
  enabled: boolean;
  /** A run of it is in flight (run.ts, isInFlight). */
  inFlight: boolean;
  /** The tool's version in its inventory, when it has one. */
  version: string | null;
  /** Why `version` is null, from the inventory; taken as `ok` with a version and `no_inventory` without, when not given. */
  inventory?: InventoryState;
  /** The floor of the box's own policy (the owner and the box: a box can have its own). */
  floor: string;
  /** What "behind" compares with for this box (behindReference over its own policy's target). */
  reference: string | null;
}

/** Why one host cannot take a run now, or null when it can. The order is the 404, then the contract's 409s. */
export function hostRefusal(h: Pick<HostFacts, 'connected' | 'capable' | 'enabled' | 'inFlight'>): HostRefusal | null {
  if (!h.enabled) return 'claude_update_off';
  if (!h.connected) return 'offline';
  if (!h.capable) return 'not_capable';
  if (h.inFlight) return 'run_in_flight';
  return null;
}

// A dated build, 2026.10.22-27dcf5f (the Cursor agent's): its date, then its build hash.
const BUILD = /^(\d{4}\.\d{2}\.\d{2})-[0-9a-f]+$/;
const DAY = /^\d{4}\.\d{2}\.\d{2}$/;

/**
 * What "behind" compares with: an exact target when the policy names one,
 * else the newest version of the tool anywhere in the fleet, as the
 * Software tab's columns do (services/software/versions.ts). For dated
 * builds, the newest is the newest day's build; when the fleet has several
 * builds of that day, which is newer cannot be told, so the reference is the
 * day alone and every host on it counts as behind (compareToReference). The
 * box resolves latest itself; one already on it reports current and stops
 * nothing (Bugbot on #1080). A tool whose latest is pinned names it
 * (latestReference), and that is the reference.
 */
export function behindReference(target: string, fleetVersions: Array<string | null>, isVersion: (v: unknown) => v is string = isClaudeVersion, latestReference?: string): string | null {
  if (isVersion(target)) return target;
  // A tool whose latest is pinned (the Cursor agent, pi): what the box resolves
  // latest to, so a box on it is current and one past it is ahead (Bugbot on
  // #1080).
  if (latestReference) return latestReference;
  const builds = fleetVersions.filter((v): v is string => !!v && BUILD.test(v));
  if (builds.length === 0) return newestVersion(fleetVersions);
  const day = builds.map(v => BUILD.exec(v)![1]).reduce((a, b) => ((compareVersions(b, a) ?? 0) > 0 ? b : a));
  const ofDay = new Set(builds.filter(v => v.startsWith(`${day}-`)));
  return ofDay.size === 1 ? [...ofDay][0] : day;
}

/**
 * A host's version against what it is compared with: compareVersions, except
 * that two different builds of the same day are not equal (their hashes do
 * not order, and compareVersions would read a hash's leading digits). One
 * that is not the very build asked for is behind it, and so is any build of
 * a reference that names only its day (behindReference; Bugbot on #1080).
 * Against a floor (`floor`), only the day counts, as on the box (at_least in
 * termag-cursor-update): another build of the floor's day is not below it.
 */
export function compareToReference(version: string, against: string, floor = false): number | null {
  const a = BUILD.exec(version), b = BUILD.exec(against);
  if (a && DAY.test(against)) return a[1] === against ? -1 : compareVersions(a[1], against);
  if (a && b && a[1] === b[1]) return version === against || floor ? 0 : -1;
  if (a && b) return compareVersions(a[1], b[1]);
  return compareVersions(version, against);
}

export interface FleetSelection {
  hosts: string[];
  skipped: Array<{ hostKey: string; reason: FleetSkip }>;
}

/**
 * The hosts a scope takes, in the order given. A host outside the scope is
 * not listed at all; one inside it that cannot run now is skipped with the
 * reason. Below-floor and behind need a version to compare: a host whose
 * inventory has none is skipped, never updated blind, with the reason the
 * host can't run when there is one (offline first: it is what an admin can
 * act on), else why there is no version (`skipReason`).
 * Each host is compared with its own floor and reference (Devin on #975).
 */
export function selectFleet(hosts: HostFacts[], scope: FleetScope): FleetSelection {
  const out: FleetSelection = { hosts: [], skipped: [] };
  for (const h of hosts) {
    if (scope !== 'all') {
      const against = scope === 'below-floor' ? h.floor : h.reference;
      const c = h.version && against ? compareToReference(h.version, against, scope === 'below-floor') : null;
      if (c === null) { out.skipped.push({ hostKey: h.hostKey, reason: hostRefusal(h) ?? versionSkip(h) }); continue; }
      if (c >= 0) continue;
    }
    const refusal = hostRefusal(h);
    if (refusal) out.skipped.push({ hostKey: h.hostKey, reason: refusal });
    else out.hosts.push(h.hostKey);
  }
  return out;
}

/** Why a host's version can't be compared: what its inventory says, or `unknown_version` for one it read. */
function versionSkip(h: Pick<HostFacts, 'version' | 'inventory'>): FleetSkip {
  const inv = h.inventory ?? (h.version ? 'ok' : 'no_inventory');
  return inv === 'ok' ? 'unknown_version' : inv;
}

/** How many of the queued runs start now, with `inFlight` runs already going. */
export function slotsFree(inFlight: number, limit: number = FLEET_IN_FLIGHT): number {
  return Math.max(0, limit - inFlight);
}
