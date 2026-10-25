import React, { useCallback } from 'react';
import { adminApi, type SpawnLimitsUserRow, type SystemHealth } from '../../services/adminApi';
import { ChartCard } from '../dashboard/ChartCard';
import { useAdminPolled, pendingText, DataTable, KeyValues, Counts, fmtAgo, fmtBytes, type Column } from './shared';
import { fmtDurationShort } from '../../utils/format';

function agentTokenFormsText(f: NonNullable<SystemHealth['agents']['tokenForms']>): string {
  const { header, query, refusedQuery } = f.sinceStart;
  const live = `${f.queryFormConnected.length} connected with ?token=`;
  const since = `since start: ${header} header, ${query} query${refusedQuery ? `, ${refusedQuery} refused` : ''}`;
  return `${live} · ${since}${f.queryAccepted ? '' : ' · query form refused'}`;
}

/** A limit cell: the value, marked when the flag serves something other than the code default. */
function limitCell(r: SpawnLimitsUserRow, key: string, value: number | null, used?: number) {
  const shown = value === null ? 'no cap' : used === undefined ? String(value) : `${used} / ${value}`;
  return <span className={r.overrides.includes(key) ? 'admin-warn' : ''} title={r.overrides.includes(key) ? 'set by the flag (not the code default)' : 'code default'}>{shown}</span>;
}

export function AdminSystem({ now }: { now: number }) {
  const sys = useAdminPolled(useCallback(() => adminApi.system(), []), 60_000);
  const s = sys.data;
  const spawn = useAdminPolled(useCallback(() => adminApi.spawnLimits(), []), 60_000);
  const sl = spawn.data;
  const spawnCols: Column<SpawnLimitsUserRow>[] = [
    { id: 'user', label: 'user', value: r => r.user.unixUsername, title: 'users who spawned in the last 30 days, have a spawn still running, or are served anything but the defaults' },
    { id: 'perHour', label: 'this hour', value: r => r.usage.lastHour, align: 'right', render: r => limitCell(r, 'perHour', r.limits.perHour, r.usage.lastHour) },
    { id: 'running', label: 'running', value: r => r.usage.running, align: 'right', render: r => limitCell(r, 'maxConcurrentPerUser', r.limits.maxConcurrentPerUser, r.usage.running) },
    { id: 'open', label: 'open / parent', value: r => r.limits.maxOpenChildren, align: 'right', render: r => limitCell(r, 'maxOpenChildren', r.limits.maxOpenChildren) },
    { id: 'depth', label: 'depth', value: r => r.limits.maxDepth, align: 'right', render: r => limitCell(r, 'maxDepth', r.limits.maxDepth) },
    { id: 'box', label: 'box cap', value: r => r.limits.boxCapacity, align: 'right', render: r => limitCell(r, 'boxCapacity', r.limits.boxCapacity) },
    { id: 'last30d', label: '30 days', value: r => r.usage.last30d, align: 'right' },
    { id: 'overrides', label: 'from the flag', value: r => r.overrides.length, render: r => r.overrides.length ? r.overrides.join(', ') : <span className="usage-dim">defaults</span> },
  ];
  const cols: Column<SystemHealth['db']['tables'][number]>[] = [
    { id: 'table', label: 'table', value: r => r.table },
    { id: 'rows', label: 'rows (est.)', value: r => r.rows, align: 'right', render: r => r.rows.toLocaleString() },
    { id: 'bytes', label: 'size', value: r => r.bytes, align: 'right', render: r => fmtBytes(r.bytes) },
  ];
  return (
    <>
      <div className="dash-grid-2">
        <ChartCard title="Orchestrator" subtitle={s ? `termag ${s.process.version} · node ${s.process.node} · pid ${s.process.pid}` : pendingText(sys)} stale={sys.loading}>
          {s && <KeyValues items={[
            ['uptime', `${fmtDurationShort(s.process.uptimeS * 1000)} · started ${fmtAgo(s.process.startedAt, now)}`],
            ['memory', `${s.process.rssMb} MB rss · ${s.process.heapUsedMb} MB heap`],
            ['auth mode', `${s.process.authMode}${s.process.localSessions ? '' : ' · local sessions disabled'}`],
            ['commit', s.process.commit ?? 'not recorded'],
            ['agents', `${s.agents.connected} connected (${s.agents.boxes} boxes, ${s.agents.legacy} orchestrator)`],
            ...(s.agents.tokenForms ? [['agent token in URL', agentTokenFormsText(s.agents.tokenForms)] as [string, string]] : []),
            ['status map', <><Counts counts={s.statusMap.byStatus} /> <span className="usage-dim">· {s.statusMap.sessions} sessions, {s.statusMap.note}</span></>],
            ['box updates', <>
              target {s.boxUpdates.targetCommit ? <span className="admin-mono">{s.boxUpdates.targetCommit.slice(0, 12)}</span> : 'unknown'}{s.boxUpdates.targetImageCreatedAt ? ` (baked ${fmtAgo(s.boxUpdates.targetImageCreatedAt, now)})` : ''} · {s.boxUpdates.pushedThisProcess} pushed since start · last sweep {fmtAgo(s.boxUpdates.lastSweepAt, now)}
              <br /><span className="usage-dim">boxes by their latest report, last day: {Object.keys(s.boxUpdates.boxesByLastOutcome24h ?? {}).length ? <Counts counts={s.boxUpdates.boxesByLastOutcome24h} /> : 'none'} · flag {s.boxUpdates.flag}</span>
            </>],
            ['usage scans', `${s.usageScans.hosts} hosts · ${s.usageScans.failing} failing · ${s.usageScans.schema1Hosts} old agents · last ${fmtAgo(s.usageScans.lastScanAt, now)}`],
          ]} />}
        </ChartCard>
        <ChartCard title="Database" subtitle={s ? `${fmtBytes(s.db.bytes)} total${s.db.activeHttpSessions >= 0 ? ` · ${s.db.activeHttpSessions} live browser sessions` : ''}` : pendingText(sys)} stale={sys.loading}>
          <DataTable rows={s?.db.tables ?? []} columns={cols} rowKey={r => r.table} defaultSort="bytes" dense />
        </ChartCard>
      </div>
      <ChartCard
        title="Spawn limits"
        subtitle={sl
          ? `what ${sl.flag.key} serves each user (marked = not the code default) · defaults ${sl.defaults.perHour}/hour, ${sl.defaults.maxConcurrentPerUser} running, ${sl.defaults.maxOpenChildren} open per parent, depth ${sl.defaults.maxDepth}`
          : pendingText(spawn)}
        stale={spawn.loading}
      >
        <DataTable rows={sl?.users ?? []} columns={spawnCols} rowKey={r => r.user.id} defaultSort="overrides" dense />
        <div className="usage-dim dash-card-note">Set them with the <span className="admin-mono">{sl?.flag.key ?? 'agent-spawn-limits'}</span> flag in <span className="admin-mono">TERMAG_FLAGS</span>. Hot-box thresholds and the park and retire timings come from the same flag.</div>
      </ChartCard>
      <div className="usage-dim dash-card-note">
        Working time in flight is lost when the process restarts; the status map and usage-scan health are rebuilt from scratch. Phase 1 persists both.
      </div>
    </>
  );
}
