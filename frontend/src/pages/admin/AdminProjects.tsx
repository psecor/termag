import React, { useCallback, useState } from 'react';
import { adminApi, type AdminCloudSessions, type AdminProject, type AdminSessionRow } from '../../services/adminApi';
import { useAdminPolled, pendingText, DataTable, StatusPill, Dot, Counts, fmtAgo, type Column } from './shared';
import { fmtK } from '../../utils/format';
import { adminCloudName } from '../../utils/adminCloud';

/**
 * Claude Code cloud sessions as rows of the live-sessions table
 *: a cloud session is an agent
 * session on a box like any pane, so an admin reading "what is waiting"
 * sees it here too. Role `cloud`, project `claude-cloud`, the live status
 * from the status map when the box has posted one; `not_running` with no
 * timestamp when it has not, as a never-seen project pane reads.
 */
export function cloudSessionRows(d: AdminCloudSessions | null): AdminSessionRow[] {
  if (!d) return [];
  return d.boxes.flatMap(b => b.sessions.map(s => ({
    projectId: s.key, projectName: 'claude-cloud', owner: s.owner, ownerUserId: '', access: 'admin',
    workstream: s.current ? `slot ${s.current.slot}` : '', role: 'cloud', session: adminCloudName(s.owner, s.name), instanceId: b.instanceId,
    // The project-row convention (services/sessionInventory.ts): no status
    // ever recorded reads `not_running` with a null updatedAt, and an
    // unanswered liveness probe reads not alive; nothing is made up here.
    connected: b.connected, alive: s.current?.alive === true,
    status: s.live?.status ?? 'not_running',
    contextTokens: s.live?.contextTokens ?? null,
    updatedAt: s.live?.updatedAt ?? null,
    waitingReason: s.live?.waitingReason ?? null, rateLimited: s.live?.rateLimited ?? null,
    provider: 'claude', lastActiveAt: s.lastSeenAt,
  })));
}

export function AdminProjects({ now }: { now: number }) {
  const [archived, setArchived] = useState(false);
  const [stale, setStale] = useState(false);
  const [agentOnly, setAgentOnly] = useState(true);
  const [withCloud, setWithCloud] = useState(true);
  const projects = useAdminPolled(useCallback(() => adminApi.projects({ archived, staleDays: stale ? 30 : undefined }), [archived, stale]), 60_000, { deps: [archived, stale] });
  const counts = useAdminPolled(useCallback(() => adminApi.projectCounts(), []), 5 * 60_000);
  const live = useAdminPolled(useCallback(() => adminApi.liveSessions(), []), 30_000);
  const cloud = useAdminPolled(useCallback(() => adminApi.cloudSessions(1), []), 30_000);

  const pcols: Column<AdminProject>[] = [
    { id: 'name', label: 'project', value: r => r.name, render: r => <span>{r.name}{r.pinned ? ' 📌' : ''}{r.kind !== 'normal' ? <span className="workstream-bar-badge">{r.kind}</span> : null}</span> },
    { id: 'owner', label: 'owner', value: r => r.owner.unixUsername },
    { id: 'box', label: 'box', value: r => r.instance?.name ?? 'orchestrator', render: r => r.instance ? `${r.instance.name}${r.instance.status !== 'ready' ? ` (${r.instance.status})` : ''}` : 'orchestrator' },
    { id: 'provider', label: 'provider', value: r => r.providers.join(', ') || r.provider, render: r => r.providers.join(', ') || r.provider || '—' },
    { id: 'ws', label: 'workstreams', value: r => r.workstreams, align: 'right' },
    { id: 'shares', label: 'shares', value: r => r.shares, align: 'right' },
    { id: 'slack', label: 'slack', value: r => (r.slackChannel ? 1 : 0), render: r => (r.slackChannel ? '#' : '—') },
    { id: 'active', label: 'last activity', value: r => Date.parse(r.lastActiveAt), render: r => fmtAgo(r.lastActiveAt, now) },
    { id: 'created', label: 'created', value: r => Date.parse(r.createdAt), render: r => fmtAgo(r.createdAt, now) },
  ];
  const scols: Column<AdminSessionRow>[] = [
    { id: 'session', label: 'session', value: r => r.session },
    { id: 'owner', label: 'owner', value: r => r.owner },
    { id: 'status', label: 'status', value: r => r.status, render: r => <StatusPill status={r.status} /> },
    { id: 'since', label: 'since', value: r => r.updatedAt ? Date.parse(r.updatedAt) : null, render: r => fmtAgo(r.updatedAt, now), title: 'last status write' },
    { id: 'why', label: 'waiting on', value: r => r.waitingReason },
    { id: 'rl', label: 'rate limit', value: r => r.rateLimited, render: r => r.rateLimited ? <span className="admin-bad">{r.rateLimited}</span> : '—' },
    { id: 'ctx', label: 'context', value: r => r.contextTokens, align: 'right', render: r => r.contextTokens != null ? fmtK(r.contextTokens) : '—' },
    { id: 'provider', label: 'provider', value: r => r.provider },
    { id: 'host', label: 'host', value: r => r.instanceId ?? 'orchestrator', render: r => <span><Dot on={r.connected} /> {r.instanceId ? r.instanceId.slice(0, 8) : 'orchestrator'}{r.alive ? '' : ' · no tmux'}</span> },
    { id: 'role', label: 'role', value: r => r.role },
  ];

  const c = counts.data;
  const s = live.data;
  const cloudRows = withCloud ? cloudSessionRows(cloud.data) : [];
  // A cloud session is an agent session: it stays under "agent panes only".
  const sessionRows = [...(s?.rows ?? []), ...cloudRows].filter(r => !agentOnly || r.role === 'agent' || r.role === 'cloud');
  return (
    <>
      <section className="dash-section">
        <div className="dash-section-title">
          Live sessions {s && <span className="dash-count">{sessionRows.length}</span>}
          <span className="usage-dim">{s ? <><Counts counts={s.summary.byStatus} /> · {s.summary.rateLimited} rate limited · {s.summary.offlineHosts} hosts offline · checked {fmtAgo(s.generatedAt, now)}</> : pendingText(live)}</span>
          <label className="admin-toggle"><input type="checkbox" checked={agentOnly} onChange={e => setAgentOnly(e.target.checked)} /> agent panes only</label>
          <label className="admin-toggle"><input type="checkbox" checked={withCloud} onChange={e => setWithCloud(e.target.checked)} /> cloud sessions</label>
        </div>
        <DataTable rows={sessionRows} columns={scols} rowKey={r => `${r.projectId}:${r.instanceId ?? 'orchestrator'}:${r.session}`} defaultSort="status" defaultDesc={false} empty={s ? 'no sessions' : pendingText(live)} dense />
      </section>
      <section className="dash-section">
        <div className="dash-section-title">
          Projects {projects.data && <span className="dash-count">{projects.data.length}</span>}
          <span className="usage-dim">{c ? <>{c.active} active · {c.archived} archived · {c.workstreams} workstreams · {c.shares} shares · <Counts counts={c.byProvider} /></> : ''}</span>
          <label className="admin-toggle"><input type="checkbox" checked={stale} onChange={e => setStale(e.target.checked)} /> stale 30d+</label>
          <label className="admin-toggle"><input type="checkbox" checked={archived} onChange={e => setArchived(e.target.checked)} /> archived</label>
        </div>
        <DataTable rows={projects.data ?? []} columns={pcols} rowKey={r => r.id} defaultSort="active" empty={projects.data ? 'no projects' : pendingText(projects)} dense />
      </section>
    </>
  );
}
