import React, { useCallback } from 'react';
import { adminApi, type SystemHealth } from '../../services/adminApi';
import { ChartCard } from '../dashboard/ChartCard';
import { useAdminPolled, pendingText, DataTable, KeyValues, Counts, fmtAgo, fmtBytes, type Column } from './shared';
import { fmtDurationShort } from '../../utils/format';

function agentTokenFormsText(f: NonNullable<SystemHealth['agents']['tokenForms']>): string {
  const { header, query, refusedQuery } = f.sinceStart;
  const live = `${f.queryFormConnected.length} connected with ?token=`;
  const since = `since start: ${header} header, ${query} query${refusedQuery ? `, ${refusedQuery} refused` : ''}`;
  return `${live} · ${since}${f.queryAccepted ? '' : ' · query form refused'}`;
}

export function AdminSystem({ now }: { now: number }) {
  const sys = useAdminPolled(useCallback(() => adminApi.system(), []), 60_000);
  const s = sys.data;
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
      <div className="usage-dim dash-card-note">
        Working time in flight is lost when the process restarts; the status map and usage-scan health are rebuilt from scratch. Phase 1 persists both.
      </div>
    </>
  );
}
