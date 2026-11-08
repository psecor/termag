import React, { useCallback, useMemo, useState } from 'react';
import { adminApi, type ClientVersionRow, type SoftwareHost, type SoftwareMatrix, type SoftwareState, type SoftwareSummary, type SoftwareUpdateRun, type ToolRestart, type ToolUpdatePreview, type ToolUpdateScope } from '../../services/adminApi';
import { ChartCard } from '../dashboard/ChartCard';
import { FollowedRunText, useFollowedRun } from './FollowedRun';
import { OrchestratorClaudeUpdate } from './OrchestratorClaudeUpdate';
import { DataTable, KeyValues, fmtAgo, pendingText, useAdminPolled, errorText, type Column } from './shared';
import { fleetCountHosts, softwareCounts, tableHosts, type HostKindFilter } from './softwareCounts';
import {
  SCOPE_CHOICES, defaultRestart, hostButtonLabel, UPDATE_TOOLS, conflictText, fleetButtonLabel, fleetConfirmText, fleetResultLines, hostConfirmText, hostUpdateAction,
  isUpdateOff, latestRunByHost, restartChoices, restartLabel, runAt, runClass, runSessionsText, runStateText, runVersions, scopeCount,
  type UpdateTool,
} from '../../utils/toolUpdate';
import { triggerText } from '../../utils/runTrigger';
import { kernelParts, rebootCellText, rebootPanelText } from './rebootPending';

const STATE_LABEL: Record<SoftwareState, string> = { current: 'current', behind: 'behind', outdated: 'outdated', ahead: 'ahead', pending: 'reboot pending', missing: 'missing', unknown: 'unknown' };
const STATES: SoftwareState[] = ['current', 'behind', 'outdated', 'ahead', 'pending', 'missing', 'unknown'];
const COMMITS = new Set(['termag', 'termag-checkout', 'image']);
const LABEL: Record<string, string> = { 'termag-checkout': 'checkout', 'cursor-agent': 'cursor', claude: 'claude code', 'kernel-installed': 'kernel installed', reboot: 'reboot pending' };
const isOffline = (h: SoftwareHost) => !h.connected && h.kind !== 'orchestrator';
const show = (component: string, v: string | null) => (v ? (COMMITS.has(component) ? v.slice(0, 7) : v) : '—');

function StateCell({ component, cell, now }: { component: string; cell: SoftwareHost['cells'][string] | undefined; now: number }) {
  if (!cell) return <span className="usage-dim">·</span>;
  const title = [cell.raw, cell.path, `${STATE_LABEL[cell.state]} · seen ${fmtAgo(cell.observedAt, now)}`].filter(Boolean).join('\n');
  const text = cell.state === 'missing' ? '—' : component === 'reboot' ? rebootCellText(cell, now) : show(component, cell.version);
  // The reboot row's cell is words ("pending · 3 d"), not a version, so it stays in the UI font.
  return <span className={`admin-sw admin-sw--${cell.state}${component === 'reboot' ? ' admin-sw--words' : ''}`} title={title}>{text}</span>;
}

// What "refresh inventories" waits before reading the matrix again; an update request waits the same.
const REREAD_MS = 5000;
// The runs the tab reads, per tool: the last-update column and the recent-updates card both show all of them.
const RUNS_LIMIT = 50;
type Ref = { floor: string | null; target: string | null };
type Fleet = { summary: string; skipped: string[] };
// 404 claude_update_off is the tool's flag saying no: 'off', which hides the action, not an error.
const offOr = <T,>(p: Promise<T>) => p.catch((e): 'off' => { if (isUpdateOff(e)) return 'off'; throw e; });

function RestartSelect({ tool, value, onChange }: { tool: UpdateTool; value: ToolRestart; onChange: (r: ToolRestart) => void }) {
  const choices = restartChoices(tool);
  return (
    <select className="admin-select" value={value} onChange={e => onChange(e.target.value as ToolRestart)} aria-label="restart sessions" title={choices.find(c => c.value === value)?.note}>
      {choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
    </select>
  );
}

/** A host's newest run of one tool, in the matrix's "last update" column for that tool. */
function RunCell({ run, now }: { run: SoftwareUpdateRun | undefined; now: number }) {
  if (!run) return <span className="usage-dim">—</span>;
  const versions = runVersions(run);
  const title = [`${triggerText(run)} · ${restartLabel(run.restart)}`, run.reason, runSessionsText(run), run.detail].filter(Boolean).join('\n');
  return <span className={runClass(run)} title={title}>{runStateText(run)}{versions ? <> · <span className="admin-mono">{versions}</span></> : null} · {fmtAgo(runAt(run), now)}</span>;
}

/**
 * The host panel's "Update <tool>": shown only when the tool's preview answers and says the box can, so
 * the tool's update flag hides it without the browser reading it.
 */
export function HostToolUpdate({ tool, host, preview, runs, onRequested, onPoll, onRunEnded }: {
  tool: UpdateTool; host: SoftwareHost; preview: ToolUpdatePreview | 'off' | null;
  /** The tool's runs list, which the line under the button follows the run it asked for in. */
  runs: SoftwareUpdateRun[] | null;
  onRequested: () => void; onPoll: () => void; onRunEnded: () => void;
}) {
  const [restart, setRestart] = useState<ToolRestart>(defaultRestart(tool));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const followed = useFollowedRun(runs, onPoll, onRunEnded);
  const action = hostUpdateAction(preview);
  if (action.kind === 'hidden' || !preview || preview === 'off') return null;
  const submit = async () => {
    if (!window.confirm(hostConfirmText(tool, host.name, preview, restart))) return;
    setBusy(true); setErr(null);
    try { followed.follow(await adminApi.updateTool(tool.component, host.hostKey, restart)); onRequested(); }
    catch (e) { setErr(conflictText(e, tool) ?? errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ marginTop: 8 }}>
      <div className="admin-form">
        <RestartSelect tool={tool} value={restart} onChange={setRestart} />
        <button type="button" className="btn-ghost btn-tiny" disabled={busy || followed.going || action.kind === 'disabled'} onClick={() => void submit()}>{hostButtonLabel(tool)}</button>
        <span className="usage-dim">
          <span className="admin-mono">{preview.current ?? '?'}</span> → <span className="admin-mono">{preview.target ?? '?'}</span>
          {' '}· {tool.atStart ? 'installs at the box’s next start' : `${preview.liveSessions} live, ${preview.busySessions} busy`}{action.kind === 'disabled' ? ` · ${action.reason}` : ''}
        </span>
      </div>
      {err && <div className="admin-error">{err}</div>}
      {followed.req && <FollowedRunText req={followed.req} run={followed.run} />}
    </div>
  );
}

/**
 * One tool's update state on the tab: the open host's preview, the runs (null while the tool's flag is off,
 * which hides every action of it), the floor and target (from that preview, else a probe of the first
 * connected box that has the tool), and its fleet action. Called once per tool, in UPDATE_TOOLS' order.
 */
function useToolUpdates(tool: UpdateTool, m: SoftwareMatrix | null, countHosts: SoftwareHost[], selected: string | null, setErr: (e: string | null) => void) {
  const { component } = tool;
  const preview = useAdminPolled(useCallback(() => (selected ? offOr(adminApi.toolUpdatePreview(component, selected)).then(p => ({ hostKey: selected, p })) : Promise.resolve(null)), [component, selected]), 60_000, { deps: [selected] });
  const runs = useAdminPolled(useCallback(() => offOr(adminApi.softwareUpdates(component, RUNS_LIMIT)), [component]), 60_000);
  const [scope, setScope] = useState<Exclude<ToolUpdateScope, 'all'>>('behind');
  const [fleetRestart, setFleetRestart] = useState<ToolRestart>(defaultRestart(tool));
  const [fleet, setFleet] = useState<Fleet | null>(null);
  const [fleetBusy, setFleetBusy] = useState(false);
  const [fleetOpen, setFleetOpen] = useState(false);
  const runList = runs.data && runs.data !== 'off' ? runs.data.runs : null;
  const lastRun = useMemo(() => latestRunByHost(runList ?? []), [runList]);
  const hostPreview = preview.data && preview.data.hostKey === selected ? preview.data.p : null;
  const probeKey = m?.hosts.find(h => h.kind === 'box' && h.connected && h.cells[tool.inventory])?.hostKey ?? null;
  const updatesOn = runList != null;
  const probe = useAdminPolled(useCallback(() => (probeKey && updatesOn ? offOr(adminApi.toolUpdatePreview(component, probeKey)) : Promise.resolve(null)), [component, probeKey, updatesOn]), 5 * 60_000, { deps: [probeKey, updatesOn] });
  // The fleet's floor and target: a box's preview, never the orchestrator host's, whose target is its own pin
  // (orchestrator-claude-update-policy) while the fleet's runs take each box's policy (Bugbot on #1165).
  const ref: Ref | null = hostPreview && hostPreview !== 'off' && hostPreview.kind !== 'orchestrator' ? hostPreview : probe.data && probe.data !== 'off' ? probe.data : null;
  const fleetN = m ? scopeCount(tool, countHosts, scope, ref, m.hosts) : null;
  const reread = () => { runs.refresh(); preview.refresh(); };
  // A host panel's run ended: its preview's current version, live and busy counts and in-flight have moved.
  const rereadPreview = () => { preview.refresh(); };
  const updateFleet = async (nameOf: (hostKey: string) => string, after: () => void) => {
    if (!window.confirm(fleetConfirmText(tool, scope, fleetN, fleetRestart, ref))) return;
    setFleetBusy(true); setFleet(null); setErr(null);
    try { setFleet(fleetResultLines(await adminApi.updateToolFleet(component, scope, fleetRestart), nameOf)); setFleetOpen(false); after(); }
    catch (e) { setErr(conflictText(e, tool) ?? errorText(e)); }
    finally { setFleetBusy(false); }
  };
  return { tool, runs, runList, lastRun, hostPreview, rereadPreview, ref, fleetN, scope, setScope, fleetRestart, setFleetRestart, fleet, fleetBusy, fleetOpen, setFleetOpen, updateFleet, reread };
}

export function AdminSoftware({ now }: { now: number }) {
  const matrix = useAdminPolled(useCallback(() => adminApi.software(), []), 60_000);
  const clients = useAdminPolled(useCallback(() => adminApi.clientVersions(), []), 5 * 60_000);
  const [onlyBad, setOnlyBad] = useState(false);
  // The header, "By component" and the fleet update's count; the host table has its own "hide offline hosts".
  const [excludeOffline, setExcludeOffline] = useState(true);
  const [hideOffline, setHideOffline] = useState(false);
  const [kind, setKind] = useState<HostKindFilter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const detail = useAdminPolled(useCallback(() => (selected ? adminApi.softwareHost(selected) : Promise.resolve(null)), [selected]), 60_000, { deps: [selected] });
  const m = matrix.data ?? null;
  const counts = useMemo(() => (m ? softwareCounts(m, excludeOffline) : null), [m, excludeOffline]);
  // What every tool's "Update behind (N)" counts: online hosts only while "exclude offline hosts" is on,
  // which is what a fleet update reaches (hostRefusal skips offline hosts).
  const countHosts = useMemo(() => (m ? fleetCountHosts(m.hosts, excludeOffline && counts?.canExclude === true) : []), [m, excludeOffline, counts]);
  // One per tool, always all of them and in this order (hooks): Claude Code, Codex, the Cursor agent, the Devin CLI, pi, the GitHub CLI, the AWS CLI, Node, Python.
  const tools = [
    useToolUpdates(UPDATE_TOOLS[0], m, countHosts, selected, setErr),
    useToolUpdates(UPDATE_TOOLS[1], m, countHosts, selected, setErr),
    useToolUpdates(UPDATE_TOOLS[2], m, countHosts, selected, setErr),
    useToolUpdates(UPDATE_TOOLS[3], m, countHosts, selected, setErr),
    useToolUpdates(UPDATE_TOOLS[4], m, countHosts, selected, setErr),
    useToolUpdates(UPDATE_TOOLS[5], m, countHosts, selected, setErr),
    useToolUpdates(UPDATE_TOOLS[6], m, countHosts, selected, setErr),
    useToolUpdates(UPDATE_TOOLS[7], m, countHosts, selected, setErr),
    useToolUpdates(UPDATE_TOOLS[8], m, countHosts, selected, setErr),
    useToolUpdates(UPDATE_TOOLS[9], m, countHosts, selected, setErr),
  ];
  const enabled = tools.filter(t => t.runList);

  const hosts = useMemo(() => tableHosts(m?.hosts ?? [], { kind, onlyBad, hideOffline }), [m, kind, onlyBad, hideOffline]);
  const components = m?.components ?? [];

  const sumCols: Column<SoftwareSummary>[] = [
    { id: 'component', label: 'component', value: r => components.indexOf(r.component), render: r => LABEL[r.component] ?? r.component },
    { id: 'reference', label: 'reference', value: r => r.reference ?? '', render: r => <span title={r.referenceNote}>{r.reference ? <span className="admin-mono">{r.reference}</span> : <span className="usage-dim">{COMMITS.has(r.component) ? 'image commit' : '—'}</span>}</span> },
    ...STATES.map(s => ({
      id: s, label: STATE_LABEL[s], align: 'right' as const, value: (r: SoftwareSummary) => r.counts[s],
      render: (r: SoftwareSummary) => (r.counts[s] ? <span className={`admin-sw admin-sw--${s}`}>{r.counts[s]}</span> : <span className="usage-dim">0</span>),
    })),
    { id: 'spread', label: 'versions seen', value: r => r.spread.length, render: r => <span className="usage-dim admin-mono">{r.spread.slice(0, 4).map(v => `${v.version} ×${v.hosts}`).join(' · ')}{r.spread.length > 4 ? ` · +${r.spread.length - 4}` : ''}</span> },
  ];
  const clientCols: Column<ClientVersionRow>[] = [
    { id: 'user', label: 'user', value: r => r.user ?? r.userId },
    { id: 'kind', label: 'client', value: r => r.kind },
    { id: 'version', label: 'version', value: r => r.version, render: r => <span className={`admin-sw admin-sw--${r.state} admin-mono`}>{r.version}</span> },
    { id: 'state', label: 'state', value: r => r.state },
    { id: 'seen', label: 'last seen', value: r => Date.parse(r.lastSeenAt), render: r => fmtAgo(r.lastSeenAt, now) },
  ];

  const rereadAfterUpdate = () => setTimeout(() => { matrix.refresh(); for (const t of tools) t.reread(); }, REREAD_MS);
  // A run a host panel follows ended: that tool's preview, the matrix's cells and the host's history move.
  const runEnded = (t: typeof tools[number]) => { t.rereadPreview(); matrix.refresh(); detail.refresh(); };
  const nameOf = (hostKey: string) => m?.hosts.find(h => h.hostKey === hostKey)?.name ?? hostKey;
  // Each tool's fleet action sits on its own row, and only while its runs route answers (its flag isn't off).
  // Its scope and restart choices open under the table: the row has no room for them.
  if (enabled.length) sumCols.push({ id: 'update', label: '', value: () => 0, render: r => {
    const t = enabled.find(x => x.tool.inventory === r.component);
    return t ? <button type="button" className="btn-ghost btn-tiny" aria-expanded={t.fleetOpen} onClick={() => t.setFleetOpen(o => !o)}>{fleetButtonLabel(t.scope, t.fleetN)}</button> : null;
  } });
  const runCols: Column<SoftwareUpdateRun>[] = [
    { id: 'host', label: 'host', value: r => nameOf(r.hostKey), render: r => <button type="button" className="admin-link" onClick={() => setSelected(r.hostKey)}>{nameOf(r.hostKey)}</button> },
    { id: 'trigger', label: 'trigger', value: r => triggerText(r), render: r => <>{triggerText(r)}{r.reason ? <div className="usage-dim">{r.reason}</div> : null}</> },
    { id: 'restart', label: 'restart', value: r => r.restart, render: r => restartLabel(r.restart) },
    { id: 'state', label: 'result', value: r => runStateText(r), render: r => <span className={runClass(r)} title={r.detail ?? ''}>{runStateText(r)}</span> },
    { id: 'versions', label: 'versions', value: r => runVersions(r) ?? '', render: r => (runVersions(r) ? <span className="admin-mono">{runVersions(r)}</span> : <span className="usage-dim">—</span>) },
    { id: 'sessions', label: 'sessions', value: r => r.sessions?.stopped ?? 0, render: r => <span className="usage-dim">{runSessionsText(r) || '—'}</span> },
    { id: 'at', label: 'requested', value: r => Date.parse(r.requestedAt), render: r => fmtAgo(r.requestedAt, now) },
  ];

  const lastCol = (t: typeof tools[number]) => (t.tool.component === 'claude' ? 'last update' : `last ${LABEL[t.tool.inventory] ?? t.tool.inventory} update`);
  // The host matrix: its rows keep the server's order until a header is clicked. A version column sorts
  // in natural order (2.1.318 above 2.1.99), a last-update column by when the run ended.
  const hostCols: Column<SoftwareHost>[] = [
    { id: 'host', label: 'host', value: h => h.name, text: h => `${h.name}${isOffline(h) ? ' offline' : ''}`,
      render: h => <><button type="button" className="admin-link" onClick={() => setSelected(h.hostKey)}>{h.name}</button>{isOffline(h) ? <span className="usage-dim"> · offline</span> : null}</> },
    { id: 'owner', label: 'owner', value: h => h.owner ?? (h.kind === 'box' ? 'warm pool' : ''), render: h => <span className="usage-dim">{h.owner ?? (h.kind === 'box' ? 'warm pool' : '')}</span> },
    ...components.map((c): Column<SoftwareHost> => ({
      id: `c:${c}`, label: LABEL[c] ?? c, title: c,
      value: h => { const cell = h.cells[c]; return !cell || cell.state === 'missing' ? null : cell.version; },
      text: h => { const cell = h.cells[c]; return !cell || cell.state === 'missing' ? '' : c === 'reboot' ? rebootCellText(cell, now) : show(c, cell.version); },
      render: h => <StateCell component={c} cell={h.cells[c]} now={now} />,
    })),
    ...enabled.map((t): Column<SoftwareHost> => ({
      id: `run:${t.tool.component}`, label: lastCol(t), title: `the newest ${t.tool.label} update run on the host, of the last ${RUNS_LIMIT}`,
      value: h => { const r = t.lastRun.get(h.hostKey); return r ? Date.parse(runAt(r)) : null; },
      text: h => { const r = t.lastRun.get(h.hostKey); return r ? `${runStateText(r)} ${runVersions(r) ?? ''}` : ''; },
      render: h => <RunCell run={t.lastRun.get(h.hostKey)} now={now} />,
    })),
  ];

  const d = detail.data;

  return (
    <>
      {err && <div className="admin-error">{err}</div>}
      <ChartCard title="Software" value={counts ? `${counts.needs} of ${counts.total} hosts need updates` : undefined}
        subtitle={m ? `tools vs the newest version in the fleet · kernels vs the newest on their track and host kind · termag and images vs the newest image (box ${m.targets.boxCommit?.slice(0, 7) ?? '?'}, orchestrator ${m.targets.orchestratorImageCommit?.slice(0, 7) ?? '?'}) · orchestrator runs ${m.targets.runningCommit?.slice(0, 7) ?? '?'}` : pendingText(matrix)}
        stale={matrix.loading}>
        {m && <KeyValues items={[
          ['inventories', `boxes and agents every 6 h and on connect · last sweep ${fmtAgo(m.collector.lastSweepAt, now)} · orchestrator ${fmtAgo(m.collector.lastSelfAt, now)}`],
          ...(m.collector.lastError ? [['error', m.collector.lastError] as [string, string]] : []),
        ]} />}
        <div className="admin-form">
          <button type="button" className="btn-ghost btn-tiny" onClick={() => { setErr(null); adminApi.refreshSoftware().then(() => setTimeout(matrix.refresh, 5000)).catch(e => setErr(errorText(e))); }}>refresh inventories</button>
          <span className="usage-dim">Each agent runs a fixed list of version checks; the orchestrator can only ask for that list.</span>
        </div>
        {counts?.canExclude && (
          <div className="admin-form">
            <label className="admin-toggle">
              <input type="checkbox" checked={excludeOffline} onChange={e => setExcludeOffline(e.target.checked)} /> exclude offline hosts
              {counts.excluded > 0 && <span className="usage-dim"> · {counts.excluded} offline host{counts.excluded === 1 ? '' : 's'} not counted</span>}
            </label>
          </div>
        )}
      </ChartCard>

      <ChartCard title="By component" subtitle={`hover a reference for how it is chosen${counts?.excluded ? ` · online hosts only, ${counts.excluded} offline not counted` : ''}`} stale={matrix.loading}>
        <DataTable rows={counts?.summary ?? []} columns={sumCols} rowKey={r => r.component} defaultSort="component" defaultDesc={false} dense empty={m ? 'no inventories yet' : pendingText(matrix)} />
        {enabled.filter(t => t.fleetOpen).map(t => (
          <div key={t.tool.component} className="admin-form" style={{ marginTop: 6 }}>
            <span>{t.tool.atStart ? `Update ${t.tool.label} at each box’s next start, on hosts` : `Update ${t.tool.label} on hosts`}</span>
            <select className="admin-select" value={t.scope} onChange={e => t.setScope(e.target.value as typeof t.scope)} aria-label="which hosts">
              {SCOPE_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <RestartSelect tool={t.tool} value={t.fleetRestart} onChange={t.setFleetRestart} />
            <button type="button" className="btn-ghost btn-tiny" disabled={t.fleetBusy || t.fleetN === 0} onClick={() => void t.updateFleet(nameOf, rereadAfterUpdate)}>{t.fleetN == null ? 'update…' : `update ${t.fleetN}…`}</button>
            <button type="button" className="btn-ghost btn-tiny" onClick={() => t.setFleetOpen(false)}>cancel</button>
          </div>
        ))}
        {tools.filter(t => t.fleet).map(t => (
          <div key={t.tool.component} className="usage-dim" style={{ marginTop: 6 }}>
            {t.tool.label}: {t.fleet!.summary}{t.fleet!.skipped.length ? ':' : ''}
            {t.fleet!.skipped.map(s => <div key={s}>{s}</div>)}
          </div>
        ))}
      </ChartCard>

      <section className="dash-section">
        <div className="dash-section-title">
          Hosts {m && <span className="dash-count">{hosts.length}</span>}
          <span className="usage-dim">hover a cell for the full version line, path and when it was seen; click a host for its history</span>
          <label className="admin-toggle"><input type="checkbox" checked={onlyBad} onChange={e => setOnlyBad(e.target.checked)} /> only hosts needing updates</label>
          <label className="admin-toggle"><input type="checkbox" checked={hideOffline} onChange={e => setHideOffline(e.target.checked)} /> hide offline hosts</label>
          <select className="admin-select" value={kind} onChange={e => setKind(e.target.value as typeof kind)} aria-label="host kind">
            <option value="all">all hosts</option><option value="box">boxes</option><option value="agent">orchestrator agents</option><option value="orchestrator">orchestrator</option>
          </select>
        </div>
        <DataTable rows={hosts} columns={hostCols} rowKey={h => h.hostKey} selectedKey={selected} dense className="admin-sw-matrix"
          search="filter hosts" storageKey="software-hosts" resetKey={[kind, onlyBad, hideOffline]}
          empty={m ? (onlyBad ? 'every host is current' : 'no hosts') : pendingText(matrix)} />
      </section>

      {selected && (
        <ChartCard title={d ? `${d.host.name}: history` : 'History'} subtitle={d ? `${d.changes.length} version changes · inventory ${fmtAgo(d.host.lastInventoryAt, now)}` : pendingText(detail)} stale={detail.loading}>
          <div className="dash-rows">
            {(d?.changes ?? []).slice(0, 40).map((c, i) => (
              <div className="dash-row" key={i}>
                <span className="dash-row-label">{LABEL[c.component] ?? c.component}</span>
                <span className="usage-dim"><span className="admin-mono">{show(c.component, c.from)}</span> → <span className="admin-mono">{show(c.component, c.to)}</span> · {fmtAgo(c.at, now)}</span>
              </div>
            ))}
            {d && d.changes.length === 0 && <div className="usage-dim">no changes recorded yet</div>}
          </div>
          {d && rebootPanelText(d.host.cells.reboot, now) && <div className="admin-sw--pending" style={{ marginTop: 8 }}>{kernelParts(rebootPanelText(d.host.cells.reboot, now)!).map((p, i) => (p.kernel ? <span key={i} className="admin-mono">{p.text}</span> : p.text))}</div>}
          {d && d.host.hostKey === selected && tools.map(t => (d.host.kind === 'orchestrator' && t.tool.component === 'claude'
            ? <OrchestratorClaudeUpdate key={`${t.tool.component}:${selected}`} preview={t.hostPreview} runs={t.runList} onRequested={rereadAfterUpdate} onPoll={t.runs.refresh} onRunEnded={() => runEnded(t)} />
            : <HostToolUpdate key={`${t.tool.component}:${selected}`} tool={t.tool} host={d.host} preview={t.hostPreview} runs={t.runList} onRequested={rereadAfterUpdate} onPoll={t.runs.refresh} onRunEnded={() => runEnded(t)} />))}
          <div style={{ marginTop: 8 }}><button type="button" className="btn-ghost btn-tiny" onClick={() => setSelected(null)}>close</button></div>
        </ChartCard>
      )}

      {enabled.map(t => (
        <ChartCard key={t.tool.component} title={`Recent ${t.tool.label} updates`} subtitle={`the last ${t.runList!.length} runs, newest first · ${t.tool.component === 'claude' ? 'manual, boot, guard, and auto: floor breach, resume, nightly' : 'manual, and auto: floor breach, resume, nightly'}`} stale={t.runs.loading}>
          <DataTable rows={t.runList!} columns={runCols} rowKey={r => r.id} defaultSort="at" dense empty="no updates yet" />
        </ChartCard>
      ))}

      <ChartCard title="Clients" subtitle={clients.data ? `web and mobile vs the orchestrator's running build (${clients.data.runningCommit?.slice(0, 7) ?? '?'}): an older build is a browser that has not reloaded since a deploy · CLI, TUI and metaterm vs the newest seen` : pendingText(clients)} stale={clients.loading}>
        <DataTable rows={clients.data?.clients ?? []} columns={clientCols} rowKey={r => `${r.userId}:${r.kind}`} defaultSort="seen" dense search="filter clients" storageKey="software-clients" empty={clients.data ? 'no clients seen yet' : pendingText(clients)} />
      </ChartCard>
    </>
  );
}
