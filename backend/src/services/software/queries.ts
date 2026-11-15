/**
 * Software tab reads. Shared by REST
 * (routes/admin/software.ts) and MCP.
 */
import { prisma } from '../../db';
import { instanceAgentTransport, isInstanceAgentConnected, inventoryHosts } from '../agentRegistry';
import { targetBoxCommit } from '../boxUpdate';
import { newestOrchestratorImage } from '../prDeploy';
import { termagVersion } from '../termagVersion';
import { behindReference, compareToReference, selectFleet, type FleetSkip } from '../toolUpdate/fleet';
import type { FleetScopeTaken } from './summary';
import { inventoryFact, runActive } from '../toolUpdate/runs';
import { TOOL_REGISTRY, type ToolDescriptor, type ToolUpdatePolicy } from '../toolUpdate/components';
import { modeEnabled } from '../toolUpdate/gate';
import { ORCHESTRATOR_HOST, orchestratorFlags, orchestratorNightlyOn, orchestratorPolicyFrom, orchestratorRunInFlight, orchestratorUpdateEnabled, parseOrchestratorMode } from '../toolUpdate/orchestrator';
import type { User } from '@prisma/client';
import type { FlagUser } from '../featureFlags';
import { lastAutoPass } from '../toolUpdate/autoRuns';
import { cellPolicy, policyReferenceText, policyToolState, unownedToolState, type CellPolicy } from './toolGrade';
import { collectorStatus } from './collector';
import { isOnline, short, summarize, type Cell, type CellRefusal, type CellRun, type HostRow, type OrchestratorPanel } from './summary';
import {
  COMMIT_COMPONENTS, KERNEL_COMPONENTS, clientReference, clientState, commitState, hooksState, kernelReferenceText, kernelReferences, kernelState, rebootState,
  compareVersions, termagReference, sortComponents, toolState, type SoftwareState,
} from './versions';

export type { Cell, HostRow, ComponentSummary } from './summary';

// The Cursor agent's versions: a dated build (2026.10.22-27dcf5f), or its day alone (2026.11.03), both of which
// its inventory probe reads (agent/software-inventory.js).
const BUILD = /^(\d{4}\.\d{2}\.\d{2})-[0-9a-f]+$/;
const DAY = /^\d{4}\.\d{2}\.\d{2}$/;

/**
 * A tool's fleet reference, over the versions the fleet runs. For the Cursor agent's dated versions,
 * hashed or not: the newest day, as its one version when the fleet runs only one of that day, else the
 * day alone, since two builds of one day (or a build and a bare day) don't order by their hashes
 * (Bugbot on #1080). compareToReference then reads every hashed build of that day as behind it, and a
 * bare day as current. Anything else: behindReference with no exact target, the newest version.
 */
export function fleetNewest(versions: Array<string | null>): string | null {
  const dated = versions.filter((v): v is string => !!v && (BUILD.test(v) || DAY.test(v)));
  if (dated.length === 0) return behindReference('', versions);
  const dayOf = (v: string) => (DAY.test(v) ? v : BUILD.exec(v)![1]);
  const day = dated.map(dayOf).reduce((a, b) => ((compareVersions(b, a) ?? 0) > 0 ? b : a));
  const ofDay = new Set(dated.filter(v => dayOf(v) === day));
  return ofDay.size === 1 ? [...ofDay][0] : day;
}

/** The tools termag updates, by their inventory name (the matrix's column). */
const UPDATABLE = new Map<string, ToolDescriptor>(Object.values(TOOL_REGISTRY).map(t => [t.inventoryName, t]));
const USER_SELECT = { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } as const;

/**
 * A tool's policy for a box's owner and the box; null if the read throws, when the cell grades as an
 * unowned box's and says `policyUnavailable`. jsonVariation catches an evaluation failure itself and
 * answers the fallback (null), which each tool's parser reads as its code default with mode off: so with
 * the flag source unreachable a box reads mode off, as everything but the floor then is (gate.ts).
 */
const readPolicy = (tool: ToolDescriptor, user: FlagUser, box: { id: string; name: string; kind: string }): Promise<ToolUpdatePolicy | null> =>
  tool.policy(user, { id: box.id, name: box.name, kind: box.kind }).catch(() => null);

/**
 * The orchestrator host's Claude Code policy (services/toolUpdate/orchestrator.ts): the shared floor,
 * its own pin as the target (none: the floor only), and both modes. Null when it can't be read.
 */
/**
 * The orchestrator's Claude Code, two questions apart (Bugbot on #1607):
 * - `policy`, its grade: from the orchestrator's own context, the one orchestratorNightlyTick reads
 *   (orchestratorFlags with no admin), so its state and the header's counts are the same for every
 *   admin. Its mode: off when either gate is (orchestratorUpdateEnabled's), auto when its nightly run is
 *   on (orchestratorNightlyOn), else manual.
 * - `panel`, the viewing admin's host panel: whether orchestratorPreview offers them an Update, read for
 *   them as the preview reads it (claude-code-update-policy is per user), and their own mode. Null with
 *   no admin (the MCP tools).
 */
async function orchestratorClaude(admin: User | null): Promise<{ policy: CellPolicy; panel: OrchestratorPanel | null } | null> {
  try {
    const tool = TOOL_REGISTRY.claude;
    const own = await orchestratorFlags(tool, null);
    const p = orchestratorPolicyFrom(own);
    const on = modeEnabled(parseOrchestratorMode(own.host)) && modeEnabled(own.shared.mode);
    const mode = !on ? 'off' : orchestratorNightlyOn(own) ? 'auto' : 'manual';
    const policy: CellPolicy = { mode, floor: p.floor, target: p.target ?? 'floor only', reference: p.target };
    if (!admin) return { policy, panel: null };
    const theirs = await orchestratorFlags(tool, admin);
    return { policy, panel: { offered: await orchestratorUpdateEnabled(tool, admin, theirs), mode: theirs.shared.mode } };
  } catch { return null; }
}

/**
 * The sweep's skips (services/toolUpdate/auto.ts AutoSkip) a cell shows: what keeps a box from an
 * update it is due. The rest (auto off, current, ran recently, not quiet yet) are the sweep working.
 */
export const SWEEP_BLOCKS: ReadonlySet<string> = new Set(['floor-failing', 'backing-off', 'not-capable']);
/**
 * The states a sweep block is about: an update due. The sweep checks the agent's capability before the
 * version (auto.ts decide), so not-capable is its skip for a current tool too, which blocks nothing
 * (Devin on #1608); floor-failing and backing-off only come of a floor breach.
 */
export const UPDATE_DUE: ReadonlySet<SoftwareState> = new Set<SoftwareState>(['below-floor', 'behind']);

/**
 * The matrix. `admin`: who is looking, for what reads per user: the orchestrator's Claude Code gate, as
 * orchestratorPreview reads it for them. The routes pass req.user; the MCP tools have none.
 */
export async function softwareMatrix(admin: User | null = null) {
  const [allRows, boxes, agentRows, boxTarget, orchImage, running, orchClaude, orchRun] = await Promise.all([
    prisma.hostSoftware.findMany(),
    prisma.instance.findMany({ where: { status: { not: 'terminated' } }, select: { id: true, name: true, kind: true, status: true, user: { select: USER_SELECT } } }),
    prisma.hostSoftware.findMany({ where: { hostKind: 'agent' }, distinct: ['hostKey'], select: { hostKey: true } }),
    targetBoxCommit().catch(() => null),
    newestOrchestratorImage().catch(() => null),
    termagVersion(),
    orchestratorClaude(admin),
    // The orchestrator's own Claude Code run in flight, as its host panel shows it (Devin on #1608).
    orchestratorRunInFlight().catch(() => null),
  ]);
  // Only hosts that still exist: a terminated box's rows stay in host_software (its history is
  // software_changes'), but neither show nor set any reference (2026-11-10).
  const boxIds = new Set(boxes.map(b => b.id));
  const rows = allRows.filter(r => r.hostKind !== 'box' || boxIds.has(r.hostKey));
  const agentUsers = agentRows;
  const liveAgents = new Set(inventoryHosts().filter(h => h.hostKind === 'agent').map(h => h.hostKey));
  const userIds = agentUsers.map(a => a.hostKey.slice('agent:'.length));
  const users = new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, unixUsername: true } })).map(u => [u.id, u.unixUsername]));

  const byHost = new Map<string, typeof rows>();
  for (const r of rows) { const l = byHost.get(r.hostKey) ?? []; l.push(r); byHost.set(r.hostKey, l); }

  // References. Tools: the newest version anywhere in the fleet (decided 2026-10-15), as the fleet
  // update's behindReference takes it: for dated builds (the Cursor agent's), the newest day's build, or
  // that day alone when the fleet has several builds of it, whose order no hash tells.
  const components = sortComponents([...new Set(rows.map(r => r.component))]);
  const toolRef = new Map<string, string | null>();
  for (const c of components) if (!COMMIT_COMPONENTS.has(c) && c !== 'hooks') toolRef.set(c, fleetNewest(rows.filter(r => r.component === c && r.ok).map(r => r.version)));
  // Kernels: the newest build per track and host kind, from what hosts run and have installed.
  const kindOf = (r: (typeof rows)[number]) => (r.hostKind === 'box' || r.hostKind === 'agent' ? r.hostKind : 'orchestrator') as HostRow['kind'];
  const okVersion = (host: typeof rows, c: string) => { const r = host.find(x => x.component === c); return r?.ok ? r.version : null; };
  const kernelRefs = kernelReferences([...byHost.values()].filter(h => h.some(r => KERNEL_COMPONENTS.has(r.component)))
    .map(h => ({ kind: kindOf(h[0]), running: okVersion(h, 'kernel'), installed: okVersion(h, 'kernel-installed') })));
  const refs = { boxImageCommit: boxTarget, orchestratorImageCommit: orchImage?.sha ?? null, runningCommit: running.sha };
  const termagRef = (kind: HostRow['kind']) => termagReference(kind, refs);

  // Tools termag updates, on a box: against the box's own policy (toolGrade.ts), as the fleet update
  // compares them (runs.ts requestFleetUpdate): the reference from every owned box's inventory.
  const owned = boxes.filter(b => b.user);
  const ownedIds = new Set(owned.map(b => b.id));
  const boxFleet = new Map<string, Array<string | null>>();
  for (const name of UPDATABLE.keys()) boxFleet.set(name, rows.filter(r => r.component === name && ownedIds.has(r.hostKey)).map(r => (r.ok ? r.version : null)));
  const policies = new Map<string, Map<string, CellPolicy>>();
  await Promise.all(owned.flatMap(b => [...UPDATABLE].map(async ([name, tool]) => {
    const p = await readPolicy(tool, b.user!, b);
    if (!p) return;
    const m = policies.get(b.id) ?? new Map<string, CellPolicy>();
    m.set(name, cellPolicy(p, boxFleet.get(name)!, tool));
    policies.set(b.id, m);
  })));
  const boxFleetRef = new Map([...boxFleet].map(([name, vs]) => [name, fleetNewest(vs)]));
  // Owned boxes whose policy read threw (readPolicy): graded as unowned, and said so.
  const unavailable = new Set<string>();
  for (const b of owned) for (const name of UPDATABLE.keys()) if (!policies.get(b.id)?.has(name)) unavailable.add(`${b.id}:${name}`);

  // Whether the fleet update would act on each graded box and tool, by the fleet update's own code:
  // selectFleet over the facts requestFleetUpdate gives it (runs.ts boxFacts), the row read as it reads
  // it (inventoryFact: older than INVENTORY_STALE_MS is no_inventory), and a run in flight as
  // runInFlightFor decides it (runActive, the pacer's queue included). So a cell, the tab's counts and the
  // buttons agree on every skip.
  const now = Date.now();
  const flying = await prisma.softwareUpdateRun.findMany({ where: { hostKey: { in: [...ownedIds] }, status: { in: ['requested', 'running'] } }, select: { id: true, hostKey: true, component: true, status: true, requestedAt: true, startedAt: true } });
  // Each box and tool's run in flight, as runActive decides it: the one source the tab has for "updating",
  // "queued for next start", and whether the sweep's last skip still explains a cell (Bugbot and Devin on
  // #1608). A run runActive drops (past its expiry, or running past RUN_STALE_MS) is not here.
  const active = new Map<string, CellRun>();
  for (const r of flying.filter(x => runActive(x, now)).sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())) {
    const key = `${r.hostKey}:${r.component}`;
    if (!active.has(key)) active.set(key, { id: r.id, status: r.status as CellRun['status'], requestedAt: r.requestedAt.toISOString(), ...(TOOL_REGISTRY[r.component as keyof typeof TOOL_REGISTRY]?.atStart ? { atStart: true as const } : {}) });
  }
  const inFlight = new Set(active.keys());
  // `fleet`: whether each scope's fleet update takes the box, by selectFleet itself, so the tab's
  // "Update below floor (N)" and "Update behind (N)" count exactly what that update would act on: a box
  // below a raised floor but on its reference (a floor-only raise under latest) is below-floor and not
  // behind (Bugbot on #1607). `refusal`: why the scope for its state skips it, for the hover and badges.
  const fleetOf = (hostKey: string, tool: ToolDescriptor, p: CellPolicy, row: (typeof rows)[number], state: SoftwareState): { refusal: FleetSkip | null; fleet: Record<FleetScopeTaken, boolean> } => {
    const inv = inventoryFact(row, now);
    const facts = {
      hostKey, enabled: modeEnabled(p.mode), connected: isInstanceAgentConnected(hostKey),
      capable: (instanceAgentTransport(hostKey)?.capabilities ?? []).includes(tool.capability),
      inFlight: inFlight.has(`${hostKey}:${tool.component}`),
      version: inv.version, inventory: inv.inventory, floor: p.floor, reference: p.reference,
    };
    const below = selectFleet([facts], 'below-floor'), behind = selectFleet([facts], 'behind');
    return {
      refusal: (state === 'below-floor' ? below : behind).skipped[0]?.reason ?? null,
      fleet: { 'below-floor': below.hosts.length > 0, behind: behind.hosts.length > 0 },
    };
  };
  /** The policy a host's tool cell is graded against: a box's own, or the orchestrator's Claude Code's. */
  const policyOf = (hostKey: string, component: string): CellPolicy | undefined =>
    hostKey === ORCHESTRATOR_HOST ? (component === 'claude' ? orchClaude?.policy : undefined) : policies.get(hostKey)?.get(component);

  const stateOf = (hostKey: string, kind: HostRow['kind'], component: string, r: (typeof rows)[number], host: typeof rows): SoftwareState => {
    if (component === 'termag' || component === 'image') return r.ok ? commitState(r.version, termagRef(kind)) : 'unknown';
    if (component === 'termag-checkout') { const running = host.find(x => x.component === 'termag'); return r.ok ? commitState(r.version, running?.version ?? null) : 'unknown'; }
    if (component === 'hooks') return hooksState(r.version);
    if (KERNEL_COMPONENTS.has(component)) return kernelState(kind, r.version, r.ok, r.path, kernelRefs, component === 'kernel' ? okVersion(host, 'kernel-installed') : null);
    if (component === 'reboot') return rebootState(r.version, r.ok, r.path);
    if (UPDATABLE.has(component)) {
      const o = { version: r.version, ok: r.ok, path: r.path };
      const p = policyOf(hostKey, component);
      // The orchestrator's Claude Code with no pin: a run only brings it up to the floor, so at or
      // above the floor it is current.
      if (p) return policyToolState(o, !p.reference && hostKey === ORCHESTRATOR_HOST ? { ...p, reference: r.version } : p);
      if (kind === 'box') return unownedToolState(o, boxFleetRef.get(component) ?? null);
    }
    return toolState({ version: r.version, ok: r.ok, path: r.path }, toolRef.get(component) ?? null, compareToReference);
  };

  const hostList: HostRow[] = [
    { hostKey: 'orchestrator', kind: 'orchestrator' as const, name: 'orchestrator', owner: null, boxKind: null, status: null, connected: true },
    ...boxes.map(b => ({ hostKey: b.id, kind: 'box' as const, name: b.name, owner: b.user?.unixUsername ?? null, boxKind: b.kind, status: b.status, connected: isInstanceAgentConnected(b.id) })),
    ...agentUsers.map(a => ({ hostKey: a.hostKey, kind: 'agent' as const, name: `${users.get(a.hostKey.slice(6)) ?? 'unknown'} (orchestrator agent)`, owner: users.get(a.hostKey.slice(6)) ?? null, boxKind: null, status: null, connected: liveAgents.has(a.hostKey) })),
  ].map(h => {
    const host = byHost.get(h.hostKey) ?? [];
    const cells: Record<string, Cell> = {};
    for (const r of host) {
      const policy = UPDATABLE.has(r.component) ? policyOf(h.hostKey, r.component) : undefined;
      // Whether the fleet update would act on it: a box's tool by refusalOf; the orchestrator's Claude Code
      // never, as the fleet buttons skip the host (its own action is in its host panel).
      const state = stateOf(h.hostKey, h.kind, r.component, r, host);
      // The orchestrator's: the fleet buttons never take it, and whether the viewing admin's host panel offers
      // an Update is theirs (orchestratorPreview's 404, Devin on #1607); with no admin, its own context.
      const offered = orchClaude?.panel ? orchClaude.panel.offered : policy?.mode !== 'off';
      const refusal = !policy ? {} : h.kind === 'box' ? fleetOf(h.hostKey, UPDATABLE.get(r.component)!, policy, r, state)
        : { refusal: (offered ? 'orchestrator' : 'orchestrator_panel_off') as CellRefusal, ...(orchClaude?.panel ? { panel: orchClaude.panel } : {}) };
      cells[r.component] = {
        version: r.version, raw: r.raw, path: r.path, state, observedAt: r.observedAt.toISOString(),
        ...(policy ? { policy } : {}), ...refusal, ...(unavailable.has(`${h.hostKey}:${r.component}`) ? { policyUnavailable: true } : {}),
      };
      const run = h.kind === 'box' && UPDATABLE.has(r.component) ? active.get(`${h.hostKey}:${UPDATABLE.get(r.component)!.component}`) : undefined;
      if (run) cells[r.component].inFlight = run;
      if (h.hostKey === ORCHESTRATOR_HOST && r.component === 'claude' && orchRun && (orchRun.status === 'requested' || orchRun.status === 'running')) {
        cells[r.component].inFlight = { id: orchRun.id, status: orchRun.status, requestedAt: orchRun.requestedAt.toISOString() };
      }
    }
    const inv = host.filter(r => r.source === 'agent' || r.source === 'self').map(r => r.observedAt.getTime());
    return { ...h, lastInventoryAt: inv.length ? new Date(Math.max(...inv)).toISOString() : null, cells };
  });

  const pass = lastAutoPass();
  const sweepOf = new Map<string, { why: string; at: string }>();
  for (const e of pass?.entries ?? []) if (SWEEP_BLOCKS.has(e.outcome)) sweepOf.set(`${e.hostKey}:${TOOL_REGISTRY[e.component]?.inventoryName}`, { why: e.outcome, at: pass!.at });
  for (const h of hostList) for (const [c, cell] of Object.entries(h.cells)) { const s = sweepOf.get(`${h.hostKey}:${c}`); if (s && UPDATE_DUE.has(cell.state)) cell.sweep = s; }
  const boxPolicies = (c: string) => owned.map(b => policies.get(b.id)?.get(c)).filter((p): p is CellPolicy => !!p);
  const reference = (c: string) => ({
    reference: COMMIT_COMPONENTS.has(c) ? null : c === 'hooks' ? 'current' : c === 'reboot' ? 'no' : KERNEL_COMPONENTS.has(c) ? kernelReferenceText(kernelRefs)
      : UPDATABLE.has(c) && boxPolicies(c).length ? policyReferenceText(boxPolicies(c).map(p => p.reference)) : toolRef.get(c) ?? null,
    ...(UPDATABLE.has(c) ? { floor: policyReferenceText(boxPolicies(c).map(p => p.floor)) } : {}),
    referenceNote: c === 'termag' || c === 'image'
      ? `boxes: ${boxTarget ? `newest box image ${short(boxTarget)}` : `no box image known, so the orchestrator's running ${short(running.sha) ?? 'commit'}`} · orchestrator and its agents: ${orchImage?.sha ? `newest orchestrator image ${short(orchImage.sha)}` : `no image known, so its running ${short(running.sha) ?? 'commit'}`}`
      : c === 'termag-checkout' ? 'each host\'s running commit: a different checkout means pulled but not restarted'
      : c === 'hooks' ? 'the last box update\'s Claude hooks step'
      : KERNEL_COMPONENTS.has(c) ? 'the newest build on the same track (major.minor and flavour: 6.8-aws, 7.0-aws) and host kind (boxes; the orchestrator with its agents), running or installed anywhere; a newer kernel installed on the host itself counts too'
      : c === 'reboot' ? 'pending: /run/reboot-required exists, or a newer kernel than the running one is installed; hover for since when and why'
      : UPDATABLE.has(c) ? `each box's own ${UPDATABLE.get(c)!.policyFlag}: its target (${policyReferenceText(boxPolicies(c).map(p => p.target)) ?? 'none read'}${UPDATABLE.get(c)!.latestReference ? `; latest is pinned to ${UPDATABLE.get(c)!.latestReference}` : ', a tag resolved to the newest version on the boxes'}) and its floor; the orchestrator and its agents against the boxes' newest`
      : 'the newest version anywhere in the fleet',
  });
  const summary = summarize(components, hostList, reference);
  const onlineHosts = hostList.filter(isOnline);

  return {
    components, summary, hosts: hostList,
    // The same counts without offline hosts, for the tab's "exclude offline hosts" (on by default).
    online: { summary: summarize(components, onlineHosts, reference), offline: hostList.length - onlineHosts.length },
    targets: { boxCommit: boxTarget, orchestratorImageCommit: orchImage?.sha ?? null, runningCommit: running.sha },
    collector: collectorStatus(),
    generatedAt: new Date().toISOString(),
  };
}

export async function softwareHost(hostKey: string, admin: User | null = null) {
  const m = await softwareMatrix(admin);
  const host = m.hosts.find(h => h.hostKey === hostKey);
  if (!host) return null;
  const changes = await prisma.softwareChange.findMany({ where: { hostKey }, orderBy: { at: 'desc' }, take: 100 });
  return { host, changes: changes.map(c => ({ component: c.component, from: c.from, to: c.to, at: c.at.toISOString() })) };
}

export async function clientVersions() {
  const [rows, running] = await Promise.all([prisma.clientVersion.findMany({ orderBy: { lastSeenAt: 'desc' } }), termagVersion()]);
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.userId))] } }, select: { id: true, unixUsername: true } })).map(u => [u.id, u.unixUsername]));
  const newest = new Map<string, string | null>();
  for (const k of ['cli', 'tui', 'metaterm', 'desktop']) newest.set(k, clientReference(rows.filter(r => r.kind === k).map(r => r.version)));
  return {
    runningCommit: running.sha,
    clients: rows.map(r => {
      const state: SoftwareState = r.kind === 'web' || r.kind === 'mobile'
        ? (r.version === 'unknown' ? 'unknown' : commitState(r.version, running.sha))
        : clientState(r.version, newest.get(r.kind) ?? null);
      return { userId: r.userId, user: users.get(r.userId) ?? null, kind: r.kind, version: r.version, state, lastSeenAt: r.lastSeenAt.toISOString() };
    }),
  };
}
