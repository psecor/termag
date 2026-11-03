/**
 * The Software tab's tool update actions, for each tool termag updates: what the buttons offer, what the confirms say,
 * and how a run reads in a cell. The browser never reads a tool's enabled flag (claude-code-update-enabled,
 * codex-update-enabled, cursor-update-enabled, devin-update-enabled, pi-update-enabled, gh-update-enabled, aws-update-enabled, node-update-enabled): a route answering 404 claude_update_off hides the action it backs.
 */
import type { ToolRestart, ToolUpdatePreview, ToolUpdateScope, FleetToolUpdate, SoftwareHost, SoftwareUpdateRun, UpdatableTool } from '../services/adminApi';

/** A tool the tab can update, as the orchestrator's registry has it (backend services/toolUpdate/components.ts). */
export interface UpdateTool {
  component: UpdatableTool;
  /** For buttons, confirms and card titles. */
  label: string;
  /** Its column in the software matrix (the inventory's component name). */
  inventory: string;
  /** What the box's agent announces once it can run this tool's update. */
  capability: string;
  /** False for a tool with no sessions to restart (the GitHub CLI): its only restart choice is none. */
  sessions?: false;
}
export const UPDATE_TOOLS: ReadonlyArray<UpdateTool> = [
  { component: 'claude', label: 'Claude Code', inventory: 'claude', capability: 'tool-update-v1' },
  { component: 'codex', label: 'Codex', inventory: 'codex', capability: 'tool-update-codex-v1' },
  { component: 'cursor', label: 'Cursor agent', inventory: 'cursor-agent', capability: 'tool-update-cursor-v1' },
  { component: 'devin', label: 'Devin CLI', inventory: 'devin', capability: 'tool-update-devin-v1' },
  { component: 'pi', label: 'pi', inventory: 'pi', capability: 'tool-update-pi-v1' },
  { component: 'gh', label: 'GitHub CLI', inventory: 'gh', capability: 'tool-update-gh-v1', sessions: false },
  { component: 'aws', label: 'AWS CLI', inventory: 'aws', capability: 'tool-update-aws-v1', sessions: false },
  // Node restarts the agent but no session in this version.
  { component: 'node', label: 'Node', inventory: 'node', capability: 'tool-update-node-v1', sessions: false },
];
export const updateTool = (component: UpdatableTool): UpdateTool => UPDATE_TOOLS.find(t => t.component === component)!;
/** The tool whose matrix column is `inventory`, if the tab can update it. */
export const toolForInventory = (inventory: string): UpdateTool | undefined => UPDATE_TOOLS.find(t => t.inventory === inventory);

const RESTART_LABEL: Record<ToolRestart, string> = { none: 'binary only', idle: 'restart sessions when idle', force: 'restart sessions now' };
export function restartChoices(tool: UpdateTool): ReadonlyArray<{ value: ToolRestart; label: string; note: string }> {
  if (tool.sessions === false) return [{ value: 'none', label: RESTART_LABEL.none, note: `${tool.label} has no sessions to restart` }];
  return [
    { value: 'none', label: RESTART_LABEL.none, note: 'running sessions keep the old version until they next start' },
    { value: 'idle', label: RESTART_LABEL.idle, note: `each ${tool.label} pane restarts once its turn ends` },
    { value: 'force', label: RESTART_LABEL.force, note: 'cuts running turns' },
  ];
}
export const DEFAULT_RESTART: ToolRestart = 'idle';
/** The restart a tool's selects start at: idle, or none for a tool with no sessions. */
export const defaultRestart = (tool: UpdateTool): ToolRestart => (tool.sessions === false ? 'none' : DEFAULT_RESTART);
export const restartLabel = (r: ToolRestart): string => RESTART_LABEL[r] ?? r;

export const SCOPE_CHOICES: ReadonlyArray<{ value: Exclude<ToolUpdateScope, 'all'>; label: string }> = [
  { value: 'below-floor', label: 'below the floor' },
  { value: 'behind', label: 'behind the target' },
];

type HttpError = { response?: { status?: number; data?: { code?: string } } } | null | undefined;
const codeOf = (e: unknown): string | undefined => (e as HttpError)?.response?.data?.code;

/** The route says the update flag is off for this host (or the fleet): hide the action, say nothing. */
export const isUpdateOff = (e: unknown): boolean => (e as HttpError)?.response?.status === 404 && codeOf(e) === 'claude_update_off';

const CONFLICT: Record<string, (tool: UpdateTool) => string> = {
  offline: () => 'The box is offline, so it can’t be asked to update.',
  not_capable: tool => `The box’s agent can’t run a ${tool.label} update yet (no ${tool.capability}).`,
  run_in_flight: () => 'An update is already running on this host.',
};
/** A 409's code as a sentence, or null for any other failure (the caller shows errorText). */
export function conflictText(e: unknown, tool: UpdateTool): string | null {
  if ((e as HttpError)?.response?.status !== 409) return null;
  const code = codeOf(e);
  return (code && CONFLICT[code]?.(tool)) ?? `Refused${code ? ` (${code})` : ''}.`;
}

/**
 * What a 202 from the host update says: the box's agent started its unit, or the RPC's answer was lost and
 * the run stays requested (it may be running; the runs list says how it went). Neither is an error.
 */
export function hostRequestedText(res: { runId: string; acknowledged: boolean }): { text: string; className: '' | 'admin-warn' } {
  return res.acknowledged
    ? { text: `update started (run ${res.runId})`, className: '' }
    : { text: `update sent, but the box’s acknowledgement was lost (run ${res.runId}): it may be running; the runs list will say`, className: 'admin-warn' };
}

export type HostUpdateAction = { kind: 'hidden' } | { kind: 'disabled'; reason: string } | { kind: 'ready' };
/** The host panel's button from its preview: none while loading, when off ('off') or not capable. */
export function hostUpdateAction(p: ToolUpdatePreview | 'off' | null): HostUpdateAction {
  if (!p || p === 'off' || !p.capable) return { kind: 'hidden' };
  if (!p.connected) return { kind: 'disabled', reason: 'offline' };
  if (p.runInFlight) return { kind: 'disabled', reason: 'an update is already running' };
  return { kind: 'ready' };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function hostConfirmText(tool: UpdateTool, name: string, p: ToolUpdatePreview, restart: ToolRestart): string {
  const sessions = `${plural(p.liveSessions, `live ${tool.label} session`)}, ${p.busySessions} busy.`;
  const effect = restart === 'force' && p.busySessions > 0
    ? `Restarting now cuts the ${plural(p.busySessions, 'running turn')}.`
    : restart === 'idle' ? 'Sessions restart as each goes idle.' : restart === 'none' ? 'Sessions keep running the old version until they next start.' : '';
  return [
    `Update ${tool.label} on ${name}?`,
    '',
    `${p.current ?? 'unknown'} → ${p.target ?? 'the target'}${p.floor ? ` (floor ${p.floor})` : ''}`,
    sessions,
    `Restart: ${restartLabel(restart)}. ${effect}`.trim(),
  ].join('\n');
}

const parseVersion = (v: string | null | undefined) => (v && /^\d+\.\d+\.\d+/.test(v) ? v.split(/[.\s-]/).slice(0, 3).map(Number) : null);
/** -1, 0 or 1 for two x.y.z versions; null when either doesn't parse ("latest", "stable"). */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * How many hosts a fleet update would ask, for the button's (N): the tool installed and older than
 * the floor or the target. Without a known floor (no preview has answered yet) there's no count for
 * below-floor; without an exact target, "behind" counts against the server's reference for dated builds
 * (datedReference) and otherwise falls back to the matrix's own behind and outdated.
 * The orchestrator host is left out: it has its own action in its host panel (phase 2e). The server's runs and skipped are the truth.
 */
// A dated build, 2026.10.22-27dcf5f (the Cursor agent's): its date, then its build hash.
const BUILD = /^(\d{4}\.\d{2}\.\d{2})-[0-9a-f]+$/;
const DAY = /^\d{4}\.\d{2}\.\d{2}$/;
/**
 * What "behind" compares dated builds with under a target that is not exact (latest), as the server's
 * fleet.ts behindReference: the newest day's build, or that day alone when the column has several builds
 * of it, whose order no hash tells (every build of the day is then behind). Null when none is dated
 * (Bugbot on #1080: the matrix's own states order same-day builds by their hash).
 */
function datedReference(versions: Array<string | null>): string | null {
  const builds = versions.filter((v): v is string => !!v && BUILD.test(v));
  if (builds.length === 0) return null;
  const day = builds.map(v => BUILD.exec(v)![1]).reduce((a, b) => ((compareVersions(b, a) ?? 0) > 0 ? b : a));
  const ofDay = new Set(builds.filter(v => v.startsWith(`${day}-`)));
  return ofDay.size === 1 ? [...ofDay][0] : day;
}
/**
 * Whether a host's version is older than what it is compared with; another build of the same day is
 * behind a target (or a day alone), but not below a floor of that day (as the server's fleet.ts
 * compareToReference).
 */
function isBehind(version: string | null, versus: string, floor = false): boolean {
  const a = version ? BUILD.exec(version) : null, b = BUILD.exec(versus);
  if (a && DAY.test(versus)) return a[1] === versus || compareVersions(a[1], versus) === -1;
  if (a && b && a[1] === b[1]) return !floor && version !== versus;
  return compareVersions(version, versus) === -1;
}

// `referenceHosts`: what the dated reference is taken from, every box in the matrix whether counted or not,
// as the server's behindReference takes every box's inventory, online or not (Bugbot on #1080).
export function scopeCount(tool: UpdateTool, hosts: SoftwareHost[], scope: Exclude<ToolUpdateScope, 'all'>, ref: { floor: string | null; target: string | null } | null, referenceHosts: SoftwareHost[] = hosts): number | null {
  const cells = hosts.filter(h => h.kind !== 'orchestrator').map(h => h.cells[tool.inventory]).filter(c => c && c.state !== 'missing' && c.version);
  const versus = scope === 'below-floor' ? ref?.floor : ref?.target;
  if (versus && parseVersion(versus)) return cells.filter(c => isBehind(c.version, versus, scope === 'below-floor')).length;
  if (scope === 'below-floor') return null;
  const dated = datedReference(referenceHosts.filter(h => h.kind !== 'orchestrator').map(h => h.cells[tool.inventory]?.version ?? null));
  if (dated) return cells.filter(c => isBehind(c.version, dated)).length;
  return cells.filter(c => c.state === 'behind' || c.state === 'outdated').length;
}

export function fleetButtonLabel(scope: Exclude<ToolUpdateScope, 'all'>, n: number | null): string {
  return `Update ${scope === 'below-floor' ? 'below floor' : 'behind'} (${n ?? '?'})`;
}

export function fleetConfirmText(tool: UpdateTool, scope: Exclude<ToolUpdateScope, 'all'>, n: number | null, restart: ToolRestart, ref: { floor: string | null; target: string | null } | null): string {
  const which = scope === 'below-floor' ? `below the floor${ref?.floor ? ` ${ref.floor}` : ''}` : `behind the target${ref?.target ? ` ${ref.target}` : ''}`;
  return [
    `Update ${tool.label} on ${n == null ? 'every host' : `about ${plural(n, 'host')}`} ${which}?`,
    '',
    `Restart: ${restartLabel(restart)}${restart === 'force' ? ' (cuts running turns)' : ''}.`,
    'At most 10 run at once; offline and incapable hosts are skipped.',
  ].join('\n');
}

const SKIP: Record<string, string> = { offline: 'offline', not_capable: 'agent can’t update', run_in_flight: 'already updating', claude_update_off: 'updates off for its owner' };
/** What a fleet update did, as a line, and one line per skipped host. */
export function fleetResultLines(res: FleetToolUpdate, nameOf: (hostKey: string) => string): { summary: string; skipped: string[] } {
  return {
    summary: `${plural(res.runs.length, 'run')} requested${res.skipped.length ? `, ${res.skipped.length} skipped` : ''}`,
    skipped: res.skipped.map(s => `${nameOf(s.hostKey)}: ${SKIP[s.reason] ?? s.reason}`),
  };
}

/** Each host's newest run, from a newest-first list. */
export function latestRunByHost(runs: SoftwareUpdateRun[]): Map<string, SoftwareUpdateRun> {
  const out = new Map<string, SoftwareUpdateRun>();
  for (const r of runs) {
    const had = out.get(r.hostKey);
    if (!had || Date.parse(r.requestedAt) > Date.parse(had.requestedAt)) out.set(r.hostKey, r);
  }
  return out;
}

/** "done · updated", "running", "refused": the run's state in a word or two. */
export function runStateText(r: SoftwareUpdateRun): string {
  return !r.outcome || r.outcome === r.status ? r.status : r.status === 'done' ? r.outcome : `${r.status} · ${r.outcome}`;
}

/** "2.1.300 → 2.1.310", or one side, or null when the run never got as far as a version. */
export function runVersions(r: SoftwareUpdateRun): string | null {
  if (r.fromVersion && r.toVersion && r.fromVersion !== r.toVersion) return `${r.fromVersion} → ${r.toVersion}`;
  return r.toVersion ?? r.fromVersion ?? (r.target ? `→ ${r.target}` : null);
}

/** The admin-table class, like the Fleet tab's last update (updateOutcomeClass) with the run's own states. */
export function runClass(r: SoftwareUpdateRun): '' | 'admin-ok' | 'admin-warn' | 'admin-bad' {
  if (r.status === 'failed' || r.status === 'refused' || r.outcome === 'failed') return 'admin-bad';
  if (r.status === 'expired' || r.outcome === 'partial') return 'admin-warn';
  if (r.outcome === 'updated' || r.outcome === 'current' || r.outcome === 'floor-only') return 'admin-ok';
  return '';
}

/** The run's timestamp to age it by: when it finished, else started, else was asked for. */
export const runAt = (r: SoftwareUpdateRun): string => r.finishedAt ?? r.startedAt ?? r.requestedAt;

export function runSessionsText(r: SoftwareUpdateRun): string {
  const s = r.sessions;
  if (!s) return '';
  return [
    s.stopped && `${s.stopped} stopped`, s.resumed && `${s.resumed} resumed`, s.fresh && `${s.fresh} fresh`,
    s.cut && `${s.cut} cut`, s.typed && `${s.typed} typed`, s.other && `${s.other} other`, s.runnersLeft && `${s.runnersLeft} runners left`,
  ].filter(Boolean).join(' · ');
}
