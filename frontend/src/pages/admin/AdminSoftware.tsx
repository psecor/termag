import React, { useCallback, useMemo, useState } from 'react';
import { adminApi, type ClientVersionRow, type SoftwareHost, type SoftwareState, type SoftwareSummary } from '../../services/adminApi';
import { ChartCard } from '../dashboard/ChartCard';
import { DataTable, KeyValues, fmtAgo, pendingText, useAdminPolled, errorText, type Column } from './shared';

const STATE_LABEL: Record<SoftwareState, string> = { current: 'current', behind: 'behind', outdated: 'outdated', ahead: 'ahead', missing: 'missing', unknown: 'unknown' };
// A tool that is not installed is something to install, not an update: missing stays in its own column.
const NEEDS_UPDATE = new Set<SoftwareState>(['behind', 'outdated']);
const COMMITS = new Set(['termag', 'termag-checkout', 'image']);
const LABEL: Record<string, string> = { 'termag-checkout': 'checkout', 'cursor-agent': 'cursor', claude: 'claude code' };
const show = (component: string, v: string | null) => (v ? (COMMITS.has(component) ? v.slice(0, 7) : v) : '—');

function StateCell({ component, cell, now }: { component: string; cell: SoftwareHost['cells'][string] | undefined; now: number }) {
  if (!cell) return <span className="usage-dim">·</span>;
  const title = [cell.raw, cell.path, `${STATE_LABEL[cell.state]} · seen ${fmtAgo(cell.observedAt, now)}`].filter(Boolean).join('\n');
  return <span className={`admin-sw admin-sw--${cell.state}`} title={title}>{cell.state === 'missing' ? '—' : show(component, cell.version)}</span>;
}

export function AdminSoftware({ now }: { now: number }) {
  const matrix = useAdminPolled(useCallback(() => adminApi.software(), []), 60_000);
  const clients = useAdminPolled(useCallback(() => adminApi.clientVersions(), []), 5 * 60_000);
  const [onlyBad, setOnlyBad] = useState(false);
  const [kind, setKind] = useState<'all' | 'box' | 'agent' | 'orchestrator'>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const detail = useAdminPolled(useCallback(() => (selected ? adminApi.softwareHost(selected) : Promise.resolve(null)), [selected]), 60_000, { deps: [selected] });

  const m = matrix.data;
  const hosts = useMemo(() => (m?.hosts ?? [])
    .filter(h => kind === 'all' || h.kind === kind)
    .filter(h => !onlyBad || Object.values(h.cells).some(c => NEEDS_UPDATE.has(c.state))), [m, kind, onlyBad]);
  const components = m?.components ?? [];

  const sumCols: Column<SoftwareSummary>[] = [
    { id: 'component', label: 'component', value: r => components.indexOf(r.component), render: r => LABEL[r.component] ?? r.component },
    { id: 'reference', label: 'reference', value: r => r.reference ?? '', render: r => <span title={r.referenceNote}>{r.reference ?? <span className="usage-dim">{COMMITS.has(r.component) ? 'image commit' : '—'}</span>}</span> },
    ...(['current', 'behind', 'outdated', 'ahead', 'missing', 'unknown'] as SoftwareState[]).map(s => ({
      id: s, label: s, align: 'right' as const, value: (r: SoftwareSummary) => r.counts[s],
      render: (r: SoftwareSummary) => (r.counts[s] ? <span className={`admin-sw admin-sw--${s}`}>{r.counts[s]}</span> : <span className="usage-dim">0</span>),
    })),
    { id: 'spread', label: 'versions seen', value: r => r.spread.length, render: r => <span className="usage-dim">{r.spread.slice(0, 4).map(v => `${v.version} ×${v.hosts}`).join(' · ')}{r.spread.length > 4 ? ` · +${r.spread.length - 4}` : ''}</span> },
  ];
  const clientCols: Column<ClientVersionRow>[] = [
    { id: 'user', label: 'user', value: r => r.user ?? r.userId },
    { id: 'kind', label: 'client', value: r => r.kind },
    { id: 'version', label: 'version', value: r => r.version, render: r => <span className={`admin-sw admin-sw--${r.state}`}>{r.version}</span> },
    { id: 'state', label: 'state', value: r => r.state },
    { id: 'seen', label: 'last seen', value: r => Date.parse(r.lastSeenAt), render: r => fmtAgo(r.lastSeenAt, now) },
  ];

  const needs = m ? m.hosts.filter(h => Object.values(h.cells).some(c => NEEDS_UPDATE.has(c.state))).length : 0;
  const d = detail.data;

  return (
    <>
      {err && <div className="admin-error">{err}</div>}
      <ChartCard title="Software" value={m ? `${needs} of ${m.hosts.length} hosts need updates` : undefined}
        subtitle={m ? `tools vs the newest version in the fleet · termag and images vs the newest image (box ${m.targets.boxCommit?.slice(0, 7) ?? '?'}, orchestrator ${m.targets.orchestratorImageCommit?.slice(0, 7) ?? '?'}) · orchestrator runs ${m.targets.runningCommit?.slice(0, 7) ?? '?'}` : pendingText(matrix)}
        stale={matrix.loading}>
        {m && <KeyValues items={[
          ['inventories', `boxes and agents every 6 h and on connect · last sweep ${fmtAgo(m.collector.lastSweepAt, now)} · orchestrator ${fmtAgo(m.collector.lastSelfAt, now)}`],
          ...(m.collector.lastError ? [['error', m.collector.lastError] as [string, string]] : []),
        ]} />}
        <div className="admin-form">
          <button type="button" className="btn-ghost btn-tiny" onClick={() => { setErr(null); adminApi.refreshSoftware().then(() => setTimeout(matrix.refresh, 5000)).catch(e => setErr(errorText(e))); }}>refresh inventories</button>
          <span className="usage-dim">Each agent runs a fixed list of version checks; the orchestrator can only ask for that list.</span>
        </div>
      </ChartCard>

      <ChartCard title="By component" subtitle="hover a reference for how it is chosen" stale={matrix.loading}>
        <DataTable rows={m?.summary ?? []} columns={sumCols} rowKey={r => r.component} defaultSort="component" defaultDesc={false} dense empty={m ? 'no inventories yet' : pendingText(matrix)} />
      </ChartCard>

      <section className="dash-section">
        <div className="dash-section-title">
          Hosts {m && <span className="dash-count">{hosts.length}</span>}
          <span className="usage-dim">hover a cell for the full version line, path and when it was seen; click a host for its history</span>
          <label className="admin-toggle"><input type="checkbox" checked={onlyBad} onChange={e => setOnlyBad(e.target.checked)} /> only hosts needing updates</label>
          <select className="admin-select" value={kind} onChange={e => setKind(e.target.value as typeof kind)} aria-label="host kind">
            <option value="all">all hosts</option><option value="box">boxes</option><option value="agent">orchestrator agents</option><option value="orchestrator">orchestrator</option>
          </select>
        </div>
        <div className="admin-table-wrap">
          <table className="admin-table admin-table--dense admin-sw-matrix">
            <thead><tr><th>host</th><th>owner</th>{components.map(c => <th key={c} title={c}>{LABEL[c] ?? c}</th>)}</tr></thead>
            <tbody>
              {hosts.length === 0 && <tr><td colSpan={components.length + 2} className="usage-dim">{m ? (onlyBad ? 'every host is current' : 'no hosts') : pendingText(matrix)}</td></tr>}
              {hosts.map(h => (
                <tr key={h.hostKey} className={selected === h.hostKey ? 'admin-row-selected' : ''}>
                  <td><button type="button" className="admin-link" onClick={() => setSelected(h.hostKey)}>{h.name}</button>{!h.connected && h.kind !== 'orchestrator' ? <span className="usage-dim"> · offline</span> : null}</td>
                  <td className="usage-dim">{h.owner ?? (h.kind === 'box' ? 'warm pool' : '')}</td>
                  {components.map(c => <td key={c}><StateCell component={c} cell={h.cells[c]} now={now} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selected && (
        <ChartCard title={d ? `${d.host.name}: history` : 'History'} subtitle={d ? `${d.changes.length} version changes · inventory ${fmtAgo(d.host.lastInventoryAt, now)}` : pendingText(detail)} stale={detail.loading}>
          <div className="dash-rows">
            {(d?.changes ?? []).slice(0, 40).map((c, i) => (
              <div className="dash-row" key={i}>
                <span className="dash-row-label">{LABEL[c.component] ?? c.component}</span>
                <span className="usage-dim">{show(c.component, c.from)} → {show(c.component, c.to)} · {fmtAgo(c.at, now)}</span>
              </div>
            ))}
            {d && d.changes.length === 0 && <div className="usage-dim">no changes recorded yet</div>}
          </div>
          <div style={{ marginTop: 8 }}><button type="button" className="btn-ghost btn-tiny" onClick={() => setSelected(null)}>close</button></div>
        </ChartCard>
      )}

      <ChartCard title="Clients" subtitle={clients.data ? `web and mobile vs the orchestrator's running build (${clients.data.runningCommit?.slice(0, 7) ?? '?'}): an older build is a browser that has not reloaded since a deploy · CLI, TUI and metaterm vs the newest seen` : pendingText(clients)} stale={clients.loading}>
        <DataTable rows={clients.data?.clients ?? []} columns={clientCols} rowKey={r => `${r.userId}:${r.kind}`} defaultSort="seen" dense empty={clients.data ? 'no clients seen yet' : pendingText(clients)} />
      </ChartCard>
    </>
  );
}
