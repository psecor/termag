/**
 * The Software tab's tool update actions ("Manual, from the admin Software
 * tab"), for each tool termag updates: what the buttons offer, what the confirms say,
 * and how a run reads in a cell. The browser never reads a tool's policy flag (<tool>-update-policy, whose
 * mode off turns updating off): a route answering 404 claude_update_off hides the action it backs.
 */
import type { ToolRestart, ToolUpdatePreview, ToolUpdateScope, FleetSkipReason, FleetToolUpdate, SoftwareCell, SoftwareHost, SoftwareRefusal, SoftwareUpdateRun, UpdatableTool } from '../services/adminApi';

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

/** How old a host's row may be and still count, as the server's INVENTORY_STALE_MS (backend toolUpdate/fleet.ts): older, the fleet skips it (no_inventory). */
export const INVENTORY_STALE_MS = 24 * 3600_000;

/**
 * How many hosts a fleet update would ask, for the button's (N): the box cells whose `fleet` says that
 * scope's update takes them. The backend answers `fleet` by calling the update's own selectFleet per
 * scope (services/software/queries.ts), and nothing here decides a scope (Bugbot on #1607). The tab and
 * its backend ship in one orchestrator image, so a matrix without `fleet` is not one to grade: it counts
 * 0, and scopeCountWhy says why (Devin on #1607). The orchestrator host is left out: it has its own
 * action in its host panel. The server's runs and skipped are the truth.
 */
export function scopeCount(tool: UpdateTool, hosts: SoftwareHost[], scope: Exclude<ToolUpdateScope, 'all'>): number {
  return hosts.filter(h => h.kind !== 'orchestrator').filter(h => h.cells[tool.inventory]?.fleet?.[scope]).length;
}

/** Why a fleet button counts 0, for its title: no box cell says the update would take it, or the matrix sent no selection at all. */
export function scopeCountWhy(tool: UpdateTool, hosts: SoftwareHost[], scope: Exclude<ToolUpdateScope, 'all'>): string | null {
  if (scopeCount(tool, hosts, scope) > 0) return null;
  const boxes = hosts.filter(h => h.kind !== 'orchestrator' && h.cells[tool.inventory]);
  if (!boxes.some(h => h.cells[tool.inventory].fleet)) return `the matrix says for no host whether this update takes it (no fleet selection for ${tool.label}), so there is nothing to count`;
  return scope === 'below-floor' ? 'the fleet update takes no host: none is below its floor and updatable now' : 'the fleet update takes no host: none is behind its reference and updatable now';
}

/** A refusal as words, for a hover or a badge. */
export const REFUSAL_TEXT: Record<SoftwareRefusal, string> = {
  claude_update_off: 'mode off', offline: 'the box is offline', not_capable: 'its agent can’t run this update', run_in_flight: 'an update is already running',
  no_inventory: 'its inventory is over a day old', not_installed: 'it isn’t installed', version_unreadable: 'its version is unreadable', unknown_version: 'its version compares with nothing',
  orchestrator: 'the fleet buttons skip the orchestrator', orchestrator_panel_off: 'the fleet buttons skip the orchestrator, and your host panel has no Update for it',
};
/** A refusal that only means the tool is being updated already, or by another action: not one that leaves it as it is. */
export const refusalBlocks = (r: SoftwareRefusal | null | undefined): boolean => !!r && r !== 'run_in_flight' && r !== 'orchestrator' && r !== 'orchestrator_panel_off';
/**
 * Whether nothing on the tab, or the sweep, would update a cell: its refusal, except for the orchestrator,
 * whose answer is its own policy's mode (off: neither its nightly run nor a host panel for that context),
 * the same for every admin, not the viewing admin's host panel (Bugbot on #1607).
 */
export const cellBlocks = (cell: SoftwareCell): boolean =>
  cell.refusal === 'orchestrator' || cell.refusal === 'orchestrator_panel_off' ? cell.policy?.mode === 'off' : refusalBlocks(cell.refusal);

/**
 * The orchestrator's Claude Code, in its hover: the viewing admin's host panel (their own view, from
 * `panel`), then what the orchestrator's own policy does, which its grade is (its nightly run under auto).
 */
function orchestratorText(cell: SoftwareCell, label: string): string {
  const p = cell.policy!;
  const panel = cell.panel
    ? cell.panel.offered ? 'your host panel’s Update reaches it'
      : `your host panel has no Update for it (${cell.panel.mode === 'off' ? 'your policy is mode off' : 'the orchestrator’s own policy is mode off'})`
    : cell.refusal === 'orchestrator' ? 'its host panel’s Update reaches it' : 'its host panel has no Update for it';
  const own = p.mode === 'auto' ? 'the orchestrator’s own nightly run still applies its policy (mode auto)' : `the orchestrator’s own policy is mode ${p.mode}, so no nightly run`;
  return `${label}: ${panel}; ${own}; the fleet buttons skip the orchestrator`;
}

/**
 * A tool cell's policy lines in its hover: what it was graded against, and what really happens to it, for
 * each state and mode. A box below its floor stays below-floor whatever the mode; what acts on it is the
 * sweep's floor run (mode auto: backend toolUpdate/auto.ts, whose first check is the mode) and "Update
 * below floor" (mode manual or auto), and neither when the fleet update would skip it (`refusal`).
 */
export function cellPolicyText(cell: SoftwareCell, orchestrator = false): string | null {
  if (cell.policyUnavailable) return 'policy unavailable: its read failed, so it is graded as a box with no owner’s, and nothing updates it from here';
  const p = cell.policy;
  if (!p) return cell.state === 'held' ? 'no owner: no policy, so nothing updates it until someone takes the box' : null;
  const target = p.reference && p.reference !== p.target ? `${p.target} → ${p.reference}` : p.target;
  const line = `target ${target} · floor ${p.floor} · mode ${p.mode}`;
  const skip = cell.refusal ? REFUSAL_TEXT[cell.refusal] : null;
  const sweep = p.mode === 'auto' ? null : `the sweep leaves it (mode ${p.mode})`;
  const label = cell.state === 'below-floor' ? 'below the floor' : 'behind';
  const due = cell.state === 'below-floor' || cell.state === 'behind';
  // The orchestrator: its grade is its own policy's, its host panel the viewing admin's (Bugbot on #1607).
  if (orchestrator || cell.refusal === 'orchestrator' || cell.refusal === 'orchestrator_panel_off') {
    return due || cell.state === 'held' ? `${line}\n${orchestratorText(cell, due ? label : 'held')}` : line;
  }
  // Neither a skip nor a reach: an update on its way, or the orchestrator's own action (Bugbot on #1607).
  const other = !due ? null
    : cell.refusal === 'run_in_flight' ? `${label}: an update is already running`
    : null;
  const what = other ?? (cell.state === 'below-floor'
    ? (skip ? `below the floor, but Update below floor skips it: ${skip}${p.mode === 'off' ? '; the sweep leaves it too' : ''}` : `below the floor: Update below floor reaches it${sweep ? `; ${sweep}` : ', and so does the sweep’s floor run'}`)
    : cell.state === 'behind'
      ? (skip ? `behind, but Update behind skips it: ${skip}` : `behind: Update behind reaches it${sweep ? `; ${sweep}` : ', and so does the nightly run'}`)
      : cell.state === 'held' ? 'held: mode off, so neither this tab nor the sweep updates it'
      : null);
  return what ? `${line}\n${what}` : line;
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
