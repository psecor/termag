import React, { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { adminApi, type AdminCloudSessions, type AdminInstance, type AdminInstanceDetail, type AdminRange, type FleetOverview } from '../../services/adminApi';
import { ChartCard } from '../dashboard/ChartCard';
import { useAdminPolled, useSelectedDetail, pendingText, refreshFailedText,DataTable, StatusPill, Dot, KeyValues, fmtAgo, fmtSeconds, type Column } from './shared';
import { adminCloudName, agentAgeLabel, cloudCountCell, pressureCell, pressureClass, updateOutcomeClass } from '../../utils/adminCloud';
import { cloudStateLabel } from '../../utils/cloudSessions';

export function AdminFleet({ range, now }: { range: AdminRange; now: number }) {
  const [all, setAll] = useState(false);
  const [params, setParams] = useSearchParams();
  const selected = params.get('box');
  const list = useAdminPolled(useCallback(() => adminApi.instances(all), [all]), 30_000, { deps: [all] });
  // The newest box image's commit and date: what "behind" is measured against.
  const overview = useAdminPolled(useCallback((): Promise<FleetOverview> => adminApi.fleetOverview(), []), 5 * 60_000);
  const target = overview.data?.target ?? null;
  const prov = useAdminPolled(useCallback(() => adminApi.provisioning(range), [range]), 5 * 60_000, { deps: [range] });
  const { detail, error: detailError } = useSelectedDetail<AdminInstanceDetail>(selected, adminApi.instance, [list.fetchedAt]);
  // The selected box's cloud runs: one
  // more poll while a box is open, none otherwise.
  const cloud = useAdminPolled(useCallback((): Promise<AdminCloudSessions | null> => (selected ? adminApi.cloudSessions(7) : Promise.resolve(null)), [selected]), 30_000, { deps: [selected] });
  const cloudRuns = selected ? (cloud.data?.boxes.find(b => b.instanceId === selected)?.sessions ?? []) : [];

  const cols: Column<AdminInstance>[] = [
    { id: 'name', label: 'box', value: r => r.name, render: r => <button type="button" className="admin-link" onClick={() => setParams({ box: r.id })}>{r.name}</button> },
    { id: 'owner', label: 'owner', value: r => r.owner?.unixUsername ?? '', render: r => r.owner?.unixUsername ?? <span className="usage-dim">warm pool</span> },
    { id: 'status', label: 'status', value: r => r.status, render: r => <StatusPill status={r.status} /> },
    { id: 'conn', label: 'agent', value: r => (r.connected ? 1 : 0), render: r => <Dot on={r.connected} /> },
    { id: 'kind', label: 'kind', value: r => r.kind },
    { id: 'region', label: 'region', value: r => r.region },
    { id: 'projects', label: 'projects', value: r => r.projects.active, align: 'right', render: r => `${r.projects.active}${r.projects.archived ? ` (+${r.projects.archived})` : ''}` },
    { id: 'cloud', label: 'cloud', value: r => r.cloud ? r.cloud.running + r.cloud.starting : 0, align: 'right', title: 'Claude Code cloud sessions open on the box',
      render: r => (r.cloud && r.cloud.running + r.cloud.starting > 0) ? <Link to={`/admin/cloud?box=${encodeURIComponent(r.id)}`}>{cloudCountCell(r.cloud)}</Link> : '—' },
    // Sorted by the commit's date, so the oldest agents are at one end. An agent that did not say what
    // it runs sorts as the oldest, which is what it is.
    { id: 'build', label: 'agent build', value: r => r.agentCommitAt ? Date.parse(r.agentCommitAt) : (r.agentCommit ? 1 : 0), title: 'the commit the connected agent runs and when it was made; behind = not the newest box image',
      render: r => r.agentCommit
        ? <span className={target?.commit && r.agentCommit !== target.commit ? 'admin-warn' : ''} title={`${r.agentCommit}${r.agentCommitAt ? ` · ${new Date(r.agentCommitAt).toLocaleString()}` : ''}`}>
            <span className="admin-mono">{r.agentCommit.slice(0, 7)}</span> · {r.agentCommitAt ? fmtAgo(r.agentCommitAt, now).replace(' ago', '') : '?'} · {agentAgeLabel(r.agentCommit, r.agentCommitAt, target, now)}
          </span>
        : <span className="usage-dim">{r.connected ? 'old agent' : '—'}</span> },
    { id: 'update', label: 'last update', value: r => r.update ? Date.parse(r.update.at) : null, title: 'what the box reported at the end of its last termag-box-update run',
      render: r => r.update
        ? <span className={updateOutcomeClass(r.update.outcome)} title={`${r.update.detail ?? ''}${r.update.commit ? ` · ${r.update.commit.slice(0, 12)}` : ''}`}>{r.update.outcome} · {fmtAgo(r.update.at, now)}</span>
        : <span className="usage-dim">never reported</span> },
    { id: 'pressure', label: 'disk · mem · load', value: r => r.host?.diskUsedPct ?? null, align: 'right', title: 'from the box agent, sampled every five minutes',
      render: r => r.host ? <span className={pressureClass(r.host)} title={`sampled ${fmtAgo(r.host.sampledAt, now)}${r.host.keptCheckouts ? ` · ${r.host.keptCheckouts} kept cloud checkouts` : ''}`}>{pressureCell(r.host)}</span> : <span className="usage-dim">—</span> },
    { id: 'active', label: 'last activity', value: r => r.lastProjectActiveAt ? Date.parse(r.lastProjectActiveAt) : null, render: r => fmtAgo(r.lastProjectActiveAt, now), title: 'newest project lastActiveAt (bumped on agent status writes)' },
    { id: 'age', label: 'age', value: r => Date.parse(r.createdAt), render: r => fmtAgo(r.createdAt, now) },
    { id: 'prov', label: 'provisioned in', value: r => r.provisioningMs, align: 'right', render: r => r.provisioningMs != null ? fmtSeconds(r.provisioningMs / 1000) : '—' },
    { id: 'scan', label: 'usage scan', value: r => r.scan?.lastScanAt ? Date.parse(r.scan.lastScanAt) : null,
      render: r => r.scan ? <span title={r.scan.error ?? ''} className={r.scan.error ? 'admin-bad' : ''}>{r.scan.error ? 'failing' : fmtAgo(r.scan.lastScanAt, now)}{r.scan.schema === 1 ? ' · old agent' : ''}</span> : '—' },
  ];

  const p = prov.data;
  return (
    <>
      <div className="dash-grid-2">
        <ChartCard title="Provisioning" subtitle={p ? `EC2 boxes launched ${p.range.since} → ${p.range.until}` : pendingText(prov)} stale={prov.loading}
          table={p ? { columns: ['week', 'launched', 'failed', 'p50'], rows: p.byWeek.map(w => [w.week, w.launched, w.failed, fmtSeconds(w.p50S)]) } : undefined}>
          {p && <KeyValues items={[
            ['launched', `${p.launched} · ${p.ready} ready · ${p.failed} failed · ${p.pending} pending`],
            ['cold start p50 / p95 / max', `${fmtSeconds(p.durationS.p50)} / ${fmtSeconds(p.durationS.p95)} / ${fmtSeconds(p.durationS.max)} (${p.durationS.samples} samples)`],
            ['failures', p.failures.length ? p.failures.map(f => `${f.count}× ${f.error}`).join(' · ') : 'none'],
          ]} />}
        </ChartCard>
        <ChartCard title={detail ? `Box ${detail.name}` : 'Box'} subtitle={detail ? `${detail.owner?.unixUsername ?? 'warm pool'} · ${detail.kind} · ${detail.status}${refreshFailedText(detailError)}` : selected ? pendingText({ error: detailError }) : 'select a box in the table'} stale={!!selected && !detail}>
          {detail && (
            <>
              <KeyValues items={[
                ['agent', <><Dot on={detail.connected} /> {detail.connected ? 'connected' : 'offline'} · last connect {fmtAgo(detail.lastConnectedAt, now)}{detail.agentCommit ? ` · runs ${detail.agentCommit.slice(0, 12)}` : ''}</>],
                ['agent build', detail.agentCommit ? `${detail.agentCommit.slice(0, 12)}${detail.agentCommitAt ? ` · ${new Date(detail.agentCommitAt).toLocaleString()}` : ' · date unknown (old agent)'} · ${agentAgeLabel(detail.agentCommit, detail.agentCommitAt, target, now)}` : 'unknown (offline, or an agent too old to say)'],
                ['last update', detail.update ? <span className={updateOutcomeClass(detail.update.outcome)}>{detail.update.outcome} · {fmtAgo(detail.update.at, now)} · {detail.update.detail}{detail.update.commit ? ` · ${detail.update.commit.slice(0, 12)}` : ''}</span> : 'never reported (a wrapper from before the report, or never asked)'],
                ['created / ready', `${fmtAgo(detail.createdAt, now)} / ${detail.readyAt ? fmtAgo(detail.readyAt, now) : '—'}`],
                ['ec2', detail.ec2InstanceId ? `${detail.ec2InstanceId} · ${detail.region ?? ''} · ${detail.hostname ?? ''}` : 'none (external)'],
                ['image', detail.imageId ? `${detail.imageId} · ${detail.imageSource ?? 'published'}` : 'not recorded (launched before images were recorded, or external)'],
                ['iam / sg', `${detail.iamRoleName ?? '—'} / ${detail.securityGroupId ?? '—'}`],
                ['error', detail.provisioningError ?? '—'],
                ['tokens', detail.tokens.map(t => `${t.name} (${t.tokenPrefix}${t.revokedAt ? ', revoked' : ''})`).join(' · ') || '—'],
                ['host', detail.host ? <span className={pressureClass(detail.host)}>{pressureCell(detail.host)} · {detail.host.keptCheckouts ?? 0} kept cloud checkout{detail.host.keptCheckouts === 1 ? '' : 's'} · sampled {fmtAgo(detail.host.sampledAt, now)}</span> : 'no sample yet (agent predates host sampling)'],
                ['cloud sessions', detail.cloud && detail.cloud.running + detail.cloud.starting > 0
                  ? <Link to={`/admin/cloud?box=${encodeURIComponent(detail.id)}`}>{cloudCountCell(detail.cloud)}</Link>
                  : 'none open'],
              ]} />
              {cloudRuns.length > 0 && (
                <>
                  <div className="dash-section-title" style={{ marginTop: 8 }}>cloud runs</div>
                  <div className="dash-rows">
                    {cloudRuns.map(s => (
                      <div className="dash-row" key={s.key}>
                        <span className="dash-row-label">{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{adminCloudName(s.owner, s.name)}</a> : adminCloudName(s.owner, s.name)}</span>
                        <span className="usage-dim">slot {s.current?.slot ?? '?'} · {cloudStateLabel(s)}{s.live ? ` · ${s.live.status}` : ''}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <div className="dash-section-title" style={{ marginTop: 8 }}>projects</div>
              <div className="dash-rows">
                {detail.projectList.map(pr => (
                  <div className="dash-row" key={pr.id}><span className="dash-row-label">{pr.name}{pr.archived ? ' (archived)' : ''}</span><span className="usage-dim">active {fmtAgo(pr.lastActiveAt, now)}</span></div>
                ))}
                {detail.projectList.length === 0 && <div className="usage-dim">no projects</div>}
              </div>
              <div style={{ marginTop: 8 }}><button type="button" className="btn-ghost btn-tiny" onClick={() => setParams({})}>close</button></div>
            </>
          )}
        </ChartCard>
      </div>
      <section className="dash-section">
        <div className="dash-section-title">
          Boxes {list.data && <span className="dash-count">{list.data.length}</span>}
          {overview.data && <span className="usage-dim">current image {overview.data.target.commit ? <span className="admin-mono">{overview.data.target.commit.slice(0, 7)}</span> : 'unknown'}{overview.data.target.imageCreatedAt ? ` baked ${fmtAgo(overview.data.target.imageCreatedAt, now)}` : ''} · {overview.data.behind} connected box{overview.data.behind === 1 ? '' : 'es'} behind</span>}
          <label className="admin-toggle"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> include terminated</label>
        </div>
        <DataTable rows={list.data ?? []} columns={cols} rowKey={r => r.id} defaultSort="active" empty={list.data ? 'no boxes' : pendingText(list)} />
      </section>
    </>
  );
}
