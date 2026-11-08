/**
 * The Software tab's tool update actions ("Manual, from the admin Software
 * tab"), for each tool termag updates: what the buttons offer, what the confirms say,
 * and how a run reads in a cell. The browser never reads a tool's policy flag (<tool>-update-policy, whose
 * mode off turns updating off): a route answering 404 claude_update_off hides the action it backs.
 */
import type { ToolRestart, ToolUpdatePreview, ToolUpdateScope, FleetSkipReason, FleetToolUpdate, SoftwareHost, SoftwareUpdateRun, UpdatableTool } from '../services/adminApi';

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
  /** Whose sessions a restart stops, when they are other tools' (Node's: the tools that run on it); else the tool's own panes. */
  sessionsOf?: string;
  /** The restart its selects start at, when it is not DEFAULT_RESTART. */
  defaultRestart?: ToolRestart;
  /**
   * Updated only at the box's start, before its service runs anything (Docker: an upgrade restarts dockerd,
   * which stops every container). Update queues a run; the box installs it at its next start, and the run's
   * report arrives after that start. Never the orchestrator host.
   */
  atStart?: true;
}
export const UPDATE_TOOLS: ReadonlyArray<UpdateTool> = [
  { component: 'claude', label: 'Claude Code', inventory: 'claude', capability: 'tool-update-v1' },
  { component: 'codex', label: 'Codex', inventory: 'codex', capability: 'tool-update-codex-v1' },
  { component: 'cursor', label: 'Cursor agent', inventory: 'cursor-agent', capability: 'tool-update-cursor-v1' },
  { component: 'devin', label: 'Devin CLI', inventory: 'devin', capability: 'tool-update-devin-v1' },
  { component: 'pi', label: 'pi', inventory: 'pi', capability: 'tool-update-pi-v1' },
  { component: 'gh', label: 'GitHub CLI', inventory: 'gh', capability: 'tool-update-gh-v1', sessions: false },
  { component: 'aws', label: 'AWS CLI', inventory: 'aws', capability: 'tool-update-aws-v1', sessions: false },
  // Node restarts the agent; a restart stops and resumes the sessions of the tools that run on it, and
  // only when asked: its selects start at none.
  { component: 'node', label: 'Node', inventory: 'node', capability: 'tool-update-node-v1', sessionsOf: 'Claude Code, Codex and pi', defaultRestart: 'none' },
  // Python has no sessions: a process keeps the patch it started on.
  { component: 'python', label: 'Python', inventory: 'python', capability: 'tool-update-python-v1', sessions: false },
  // Docker: queued for the box's next start, installed there before docker.service.
  { component: 'docker', label: 'Docker', inventory: 'docker', capability: 'tool-update-docker-v1', sessions: false, atStart: true },
];
/** The host panel's button: "Update Docker at next start" for a tool updated only then. */
export const hostButtonLabel = (tool: UpdateTool): string => (tool.atStart ? `Update ${tool.label} at next start` : `Update ${tool.label}`);
const AT_START_NOTE = 'Nothing changes on the running box: the update is queued and installs at the box’s next start (a stop and start, not a hibernation resume), before Docker starts any container. Its report arrives after that start.';
export const updateTool = (component: UpdatableTool): UpdateTool => UPDATE_TOOLS.find(t => t.component === component)!;
/** The tool whose matrix column is `inventory`, if the tab can update it. */
export const toolForInventory = (inventory: string): UpdateTool | undefined => UPDATE_TOOLS.find(t => t.inventory === inventory);

const RESTART_LABEL: Record<ToolRestart, string> = { none: 'binary only', idle: 'restart sessions when idle', force: 'restart sessions now' };
export function restartChoices(tool: UpdateTool): ReadonlyArray<{ value: ToolRestart; label: string; note: string }> {
  if (tool.sessions === false) return [{ value: 'none', label: RESTART_LABEL.none, note: `${tool.label} has no sessions to restart` }];
  return [
    { value: 'none', label: RESTART_LABEL.none, note: 'running sessions keep the old version until they next start' },
    { value: 'idle', label: RESTART_LABEL.idle, note: tool.sessionsOf ? `each ${tool.sessionsOf} session on the old ${tool.label} restarts once its turn ends` : `each ${tool.label} pane restarts once its turn ends` },
    { value: 'force', label: RESTART_LABEL.force, note: 'cuts running turns' },
  ];
}
export const DEFAULT_RESTART: ToolRestart = 'idle';
/** The restart a tool's selects start at: idle, its own default (Node's none), or none for a tool with no sessions. */
export const defaultRestart = (tool: UpdateTool): ToolRestart => (tool.sessions === false ? 'none' : tool.defaultRestart ?? DEFAULT_RESTART);
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

export type HostUpdateAction = { kind: 'hidden' } | { kind: 'disabled'; reason: string } | { kind: 'ready' };
/** The host panel's button from its preview: none while loading, when off ('off') or not capable. */
export function hostUpdateAction(p: ToolUpdatePreview | 'off' | null): HostUpdateAction {
  if (!p || p === 'off' || !p.capable) return { kind: 'hidden' };
  if (!p.connected) return { kind: 'disabled', reason: 'offline' };
  if (p.runInFlight) return { kind: 'disabled', reason: p.atStart ? 'an update is already queued for the next start' : 'an update is already running' };
  return { kind: 'ready' };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function hostConfirmText(tool: UpdateTool, name: string, p: ToolUpdatePreview, restart: ToolRestart): string {
  if (tool.atStart) {
    return [`Queue a ${tool.label} update for ${name}’s next start?`, '', `${p.current ?? 'unknown'} → ${p.target ?? 'the target'}${p.floor ? ` (floor ${p.floor})` : ''}`, AT_START_NOTE].join('\n');
  }
  // A Node update's are the sessions of the tools on it (sessionsOf), not Node's own.
  const sessions = `${plural(p.liveSessions, `live ${tool.sessionsOf ?? tool.label} session`)}, ${p.busySessions} busy.`;
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
  if (tool.atStart) {
    return [`Queue a ${tool.label} update for the next start of ${n == null ? 'every box' : `about ${plural(n, 'box', 'boxes')}`} ${which}?`, '', AT_START_NOTE, 'Offline and incapable boxes, and the orchestrator host, are skipped.'].join('\n');
  }
  return [
    `Update ${tool.label} on ${n == null ? 'every host' : `about ${plural(n, 'host')}`} ${which}?`,
    '',
    `Restart: ${restartLabel(restart)}${restart === 'force' ? ' (cuts running turns)' : ''}.`,
    'At most 10 run at once; offline and incapable hosts are skipped.',
  ].join('\n');
}

const SKIP: Record<FleetSkipReason, string> = {
  offline: 'offline', not_capable: 'agent can’t update', run_in_flight: 'already updating', claude_update_off: 'updates off for its owner',
  not_installed: 'not installed', version_unreadable: 'version unreadable', no_inventory: 'no recent inventory', unknown_version: 'no version to compare with',
};
/** What a fleet update did, as a line, and one line per skipped host. */
export function fleetResultLines(res: FleetToolUpdate, nameOf: (hostKey: string) => string): { summary: string; skipped: string[] } {
  return {
    summary: `${plural(res.runs.length, 'run')} ${res.atStart ? 'queued for each box’s next start' : 'requested'}${res.skipped.length ? `, ${res.skipped.length} skipped` : ''}`,
    skipped: res.skipped.map(s => `${nameOf(s.hostKey)}: ${SKIP[s.reason as FleetSkipReason] ?? s.reason}`),
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
  if (r.waitingForStart) return 'queued for the box’s next start';
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

/** A run still going: asked for, or started on the box. Every other status is an end. */
export const runInFlight = (r: SoftwareUpdateRun): boolean => r.status === 'requested' || r.status === 'running';

// The update scripts' reason codes after ->FAILED: (deploy/termag-tool-update-lib and each tool's script), in words.
const FAILED_REASON: Record<string, string> = {
  unpinned: 'not pinned', 'not-in-repo': 'not in the package repo', 'not-in-npm-global': 'not in the npm global', 'no-npm': 'no npm',
  digest: 'digest mismatch', 'other-major': 'another major version', 'already-there': 'already there', 'runtime-changed': 'runtime changed',
  'no-nvm-default': 'no nvm default',
};
/**
 * Why a run did not (fully) happen, from its detail, in a few words, with the version the reason names
 * ("not pinned", 1.5.0 from npm=1.0.2->FAILED:unpinned:1.5.0); null when the detail names no reason
 * (a plain ->FAILED, or the orchestrator's own sentence on an expired run, which the hover shows whole).
 */
export function runReason(detail: string | null | undefined): { text: string; version: string | null } | null {
  if (!detail) return null;
  const failed = /(?:->|=)FAILED:([a-z][a-z-]*)(?::(\S+))?/.exec(detail);
  if (failed) return { text: FAILED_REASON[failed[1]] ?? failed[1].replace(/-/g, ' '), version: failed[2] ?? null };
  const refused = /\bpolicy=refused:(\S+)/.exec(detail);
  if (refused) return { text: `policy refused (${refused[1]})`, version: null };
  if (/\bpolicy=unreachable\b/.test(detail)) return { text: 'policy unreachable', version: null };
  if (/\block=held-by-another-run\b/.test(detail)) return { text: 'another run held the lock', version: null };
  if (/->pin-mismatch\b/.test(detail)) return { text: 'pin mismatch', version: null };
  if (/\(not-installed\)/.test(detail)) return { text: 'not installed', version: null };
  if (/\brunners_left=[1-9]/.test(detail)) return { text: 'runners left draining', version: null };
  return null;
}

/**
 * The host panel's line under "Update <tool>" once it asked for a run: the run's live state from the runs
 * list, in RunCell's words and colours. Until the run shows in the list, and while it stays requested,
 * a request whose acknowledgement was lost says so (it may be running).
 */
export interface FollowedRunLine {
  state: string;
  reason: { text: string; version: string | null } | null;
  versions: string | null;
  runId: string;
  className: '' | 'admin-ok' | 'admin-warn' | 'admin-bad';
  title: string;
  inFlight: boolean;
}
export function followedRunLine(req: { runId: string; acknowledged: boolean; atStart?: boolean }, run: SoftwareUpdateRun | undefined): FollowedRunLine {
  const base = { runId: req.runId, reason: null, versions: null };
  if (req.atStart && (!run || run.status === 'requested')) {
    return { ...base, state: 'queued: installs at the box’s next start, and reports after it', className: '', title: run?.detail ?? 'waiting for the box’s next start', inFlight: false };
  }
  if (!run || run.status === 'requested') {
    return req.acknowledged
      ? { ...base, state: 'updating…', className: '', title: run?.detail ?? 'requested', inFlight: true }
      : { ...base, state: 'update sent, but the box’s acknowledgement was lost: it may be running', className: 'admin-warn', title: run?.detail ?? 'requested', inFlight: true };
  }
  if (run.status === 'running') return { ...base, state: 'updating…', className: '', title: run.detail ?? 'running', inFlight: true };
  const cls = runClass(run);
  return {
    ...base,
    state: runStateText(run),
    reason: cls === 'admin-bad' || cls === 'admin-warn' ? runReason(run.detail) : null,
    versions: runVersions(run),
    className: cls,
    title: [runStateText(run), runSessionsText(run), run.detail].filter(Boolean).join('\n'),
    inFlight: false,
  };
}
