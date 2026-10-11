import React, { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { adminApi, type AdminRange, type AdminUser, type AdminUserDetail } from '../../services/adminApi';
import { ChartCard } from '../dashboard/ChartCard';
import { TICK, GRID_STROKE, CHART_HEIGHT, DashTooltip, SeriesLegend } from '../dashboard/chartTheme';
import { shortDate } from '../dashboard/range';
import { useAdminPolled, useSelectedDetail, pendingText, refreshFailedText,DataTable, Dot, KeyValues, fmtAgo, fmtUntil, fmtMs, fmtTok, fmtPct, type Column } from './shared';
import { cloudCountCell } from '../../utils/adminCloud';

const SERIES = [
  { id: 'agentWorked', label: 'agent worked', color: 'rgb(88, 166, 255)' },
  { id: 'humanWorked', label: 'human typed', color: 'rgb(246, 185, 59)' },
  { id: 'usedTokens', label: 'used tokens', color: 'rgb(63, 185, 80)' },
  { id: 'switchedProjects', label: 'switched projects', color: 'rgb(94, 234, 212)' },
];

export function AdminUsers({ range, now }: { range: AdminRange; now: number }) {
  const [params, setParams] = useSearchParams();
  const selected = params.get('user');
  const users = useAdminPolled(useCallback(() => adminApi.users(range), [range]), 60_000, { deps: [range] });
  const active = useAdminPolled(useCallback(() => adminApi.activeUsers(range), [range]), 5 * 60_000, { deps: [range] });
  const { detail, error: detailError } = useSelectedDetail<AdminUserDetail>(selected, id => adminApi.user(id, range), [range, users.fetchedAt]);

  const cols: Column<AdminUser>[] = [
    { id: 'user', label: 'user', value: r => r.unixUsername, render: r => <button type="button" className="admin-link" onClick={() => setParams({ user: r.id })}>{r.unixUsername}{r.role === 'admin' ? ' ★' : ''}</button>, title: '★ admin' },
    { id: 'seen', label: 'last seen', value: r => r.lastSeenAt ? Date.parse(r.lastSeenAt) : null, render: r => fmtAgo(r.lastSeenAt, now) },
    { id: 'agent', label: 'agent time', value: r => r.agentMs, align: 'right', render: r => fmtMs(r.agentMs) },
    { id: 'human', label: 'human time', value: r => r.humanMs, align: 'right', render: r => fmtMs(r.humanMs) },
    { id: 'lev', label: 'leverage', value: r => r.humanMs > 0 ? r.agentMs / r.humanMs : null, align: 'right', render: r => r.humanMs > 0 ? `${(r.agentMs / r.humanMs).toFixed(1)}×` : '—', title: 'agent time ÷ human time' },
    { id: 'tokens', label: 'tokens', value: r => r.tokens, align: 'right', render: r => fmtTok(r.tokens) },
    { id: 'cache', label: 'cache', value: r => r.cacheRatio, align: 'right', render: r => fmtPct(r.cacheRatio), title: 'cacheRead ÷ (input + cacheRead)' },
    { id: 'boxes', label: 'boxes', value: r => r.boxes.total, align: 'right', render: r => <span><Dot on={r.boxes.connected > 0 || r.legacyAgentConnected} title={`${r.boxes.connected} box agents connected${r.legacyAgentConnected ? ' + orchestrator agent' : ''}`} /> {r.boxes.ready}/{r.boxes.total}</span> },
    { id: 'projects', label: 'projects', value: r => r.projects.active, align: 'right', render: r => `${r.projects.active}${r.projects.archived ? ` (+${r.projects.archived})` : ''}` },
    { id: 'cloud', label: 'cloud', value: r => r.cloud?.runsInRange ?? 0, align: 'right', title: 'Claude Code cloud session runs in the range; open now in brackets',
      render: r => r.cloud ? `${r.cloud.runsInRange}${cloudCountCell(r.cloud) ? ` (${cloudCountCell(r.cloud)})` : ''}` : '—' },
    { id: 'shares', label: 'shares', value: r => r.shares.given + r.shares.received, align: 'right', render: r => `${r.shares.given}↗ ${r.shares.received}↙`, title: 'given ↗ / received ↙' },
    { id: 'provider', label: 'default', value: r => r.defaultAgentProvider },
    { id: 'joined', label: 'joined', value: r => Date.parse(r.createdAt), render: r => fmtAgo(r.createdAt, now) },
  ];

  const a = active.data;
  const rows = (a?.days ?? []).map(d => ({ ...d, label: shortDate(d.date) }));
  return (
    <>
      <div className="dash-grid-2">
        <ChartCard title="Active users" subtitle={a ? `${a.registered} registered · distinct over range: ${Object.entries(a.totals).map(([k, v]) => `${v} ${k}`).join(' · ')}` : pendingText(active)} stale={active.loading}
          table={{ columns: ['date', ...SERIES.map(s => s.label)], rows: rows.map(r => [r.label, ...SERIES.map(s => (r as unknown as Record<string, number>)[s.id])]) }}>
          <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
            <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
              <YAxis tick={TICK} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
              <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={v => String(v)} />} />
              {SERIES.map(s => <Bar key={s.id} dataKey={s.id} name={s.label} fill={s.color} maxBarSize={10} isAnimationActive={false} />)}
            </BarChart>
          </ResponsiveContainer>
          <SeriesLegend series={SERIES} />
          {a && <div className="usage-dim dash-card-note">{a.note}</div>}
        </ChartCard>
        <ChartCard title={detail ? detail.unixUsername : 'User'} subtitle={detail ? `${detail.displayName} · ${detail.email} · ${detail.role}${detail.adminSource ? ` (${detail.adminSource})` : ''}${refreshFailedText(detailError)}` : selected ? pendingText({ error: detailError }) : 'select a user in the table'} stale={!!selected && !detail}>
          {detail && (
            <>
              <KeyValues items={[
                ['seen / joined', `${fmtAgo(detail.lastSeenAt, now)} / ${fmtAgo(detail.createdAt, now)}`],
                ['this range', `${fmtMs(detail.agentMs)} agent · ${fmtMs(detail.humanMs)} human · ${fmtTok(detail.tokens)} tokens · ${fmtPct(detail.cacheRatio)} cached`],
                ['integrations', `${detail.slack ? 'slack' : ''} ${detail.discord ? 'discord' : ''}`.trim() || 'none'],
                ['boxes', detail.instances.map(i => `${i.name} (${i.status})`).join(' · ') || 'none'],
                ['cloud sessions', detail.cloud ? `${detail.cloud.runsInRange} run${detail.cloud.runsInRange === 1 ? '' : 's'} in range${cloudCountCell(detail.cloud) ? ` · ${cloudCountCell(detail.cloud)} now` : ''}` : '—'],
                ['tokens', detail.tokenList.map(t => `${t.name} [${t.scope}]${t.expiresAt ? ` (${fmtUntil(t.expiresAt, now)})` : ''}`).join(' · ') || 'none'],
              ]} />
              <div className="dash-section-title" style={{ marginTop: 8 }}>projects</div>
              <div className="dash-rows">
                {detail.projectList.slice(0, 12).map(p => (
                  <div className="dash-row" key={p.id}><span className="dash-row-label">{p.name}{p.archived ? ' (archived)' : ''}{p.kind !== 'normal' ? ` [${p.kind}]` : ''}</span><span className="usage-dim">active {fmtAgo(p.lastActiveAt, now)}</span></div>
                ))}
                {detail.projectList.length > 12 && <div className="usage-dim">+{detail.projectList.length - 12} more</div>}
              </div>
              <div style={{ marginTop: 8 }}><button type="button" className="btn-ghost btn-tiny" onClick={() => setParams({})}>close</button></div>
            </>
          )}
        </ChartCard>
      </div>
      <section className="dash-section">
        <div className="dash-section-title">Users {users.data && <span className="dash-count">{users.data.length}</span>}</div>
        <DataTable rows={users.data ?? []} columns={cols} rowKey={r => r.id} defaultSort="agent" empty={users.data ? 'no users' : pendingText(users)} />
      </section>
    </>
  );
}
