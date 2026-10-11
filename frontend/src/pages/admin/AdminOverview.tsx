import React, { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { adminApi, type AdminRange } from '../../services/adminApi';
import { KpiRow, type Kpi, deltaPct } from '../dashboard/KpiRow';
import { ChartCard } from '../dashboard/ChartCard';
import { TICK, GRID_STROKE, SURFACE, BAR_MAX, CHART_HEIGHT, DashTooltip, SeriesLegend } from '../dashboard/chartTheme';
import { shortDate } from '../dashboard/range';
import { fmtDurationShort, fmtK, fmtAge } from '../../utils/format';
import { useAdminPolled, pendingText,SignalsList, Counts, fmtMs, fmtTok } from './shared';
import { cloudKpiNote } from '../../utils/adminCloud';

const H = 3_600_000;
const hoursTick = (ms: number) => (ms >= H ? `${Math.round(ms / H)}h` : ms > 0 ? `${Math.round(ms / 60_000)}m` : '0');
const AGENT_COLOR = 'rgb(88, 166, 255)';
const HUMAN_COLOR = 'rgb(246, 185, 59)';
const TOK_COLORS = { input: 'rgb(88, 166, 255)', output: 'rgb(63, 185, 80)', cacheRead: 'rgb(139, 148, 158)', cacheCreate: 'rgb(188, 140, 255)' };

export function AdminOverview({ range, now }: { range: AdminRange; now: number }) {
  const fetcher = useCallback(() => adminApi.overview(range), [range]);
  const ov = useAdminPolled(fetcher, 60_000, { deps: [range] });
  const d = ov.data;
  const vs = range === 'today' ? 'vs yesterday' : `vs prior ${range}`;

  const kpis: Kpi[] = d ? [
    { id: 'boxes', label: 'Boxes ready', value: `${d.fleet.byStatus.ready ?? 0} / ${d.fleet.total}`, deltaPct: null, upIsGood: true, vs,
      note: `${d.fleet.connected} connected${d.fleet.readyDisconnected ? ` · ${d.fleet.readyDisconnected} offline` : ''}` },
    { id: 'users', label: 'Active users', value: String(d.users.active.agentWorked ?? 0), deltaPct: null, upIsGood: true, vs,
      note: `${d.users.registered} registered · ${d.users.active.humanWorked ?? 0} typed · ${d.users.active.signedIn ?? 0} signed in` },
    { id: 'sessions', label: 'Agents working', value: String(d.sessions.byStatus.working ?? 0), deltaPct: null, upIsGood: true, vs,
      note: `${d.sessions.byStatus.waiting ?? 0} waiting · ${d.sessions.byStatus.idle ?? 0} idle · ${d.sessions.agentPanes} panes` },
    { id: 'cloud', label: 'Cloud sessions', value: String(d.cloud?.running ?? 0), deltaPct: null, upIsGood: true, vs,
      note: cloudKpiNote(d.cloud ?? { running: 0, starting: 0, queued: 0 }) },
    { id: 'agent', label: 'Agent time', value: fmtDurationShort(d.worktime.totals.agentMs), deltaPct: deltaPct(d.worktime.totals.agentMs, d.worktime.prior.agentMs), upIsGood: true, vs },
    { id: 'human', label: 'Human time', value: fmtDurationShort(d.worktime.totals.humanMs), deltaPct: deltaPct(d.worktime.totals.humanMs, d.worktime.prior.humanMs), upIsGood: true, vs },
    { id: 'tokens', label: 'Tokens', value: fmtK(d.tokens.totals.total), deltaPct: deltaPct(d.tokens.totals.total, d.tokens.prior.total), upIsGood: false, vs,
      note: d.tokens.totals.cacheRatio != null ? `${Math.round(d.tokens.totals.cacheRatio * 100)}% cache hits` : undefined },
    { id: 'projects', label: 'Projects', value: String(d.projects.active), deltaPct: null, upIsGood: true, vs, note: `${d.projects.archived} archived · ${d.projects.workstreams} workstreams` },
  ] : [];

  const wtRows = (d?.worktime.days ?? []).map(r => ({ label: shortDate(r.keys[0]), agent: r.agentMs, human: r.humanMs }));
  const tokRows = (d?.tokens.days ?? []).map(r => ({ label: shortDate(r.keys[0]), input: r.input, output: r.output, cacheRead: r.cacheRead, cacheCreate: r.cacheCreate }));

  return (
    <>
      <div className="dash-updated">{ov.fetchedAt ? `updated ${fmtAge(now - ov.fetchedAt)} ago` : pendingText(ov)}{ov.error && ov.fetchedAt ? ' · last fetch failed' : ''}</div>
      <SignalsList signals={d?.signals ?? []} loaded={!!d} now={now} />
      <KpiRow kpis={kpis.length ? kpis : [{ id: 'l', label: 'Loading', value: '…', deltaPct: null, upIsGood: true, vs }]} />
      {d && (
        <div className="dash-grid-2">
          <ChartCard title="Fleet" subtitle="boxes by status · kind · region" stale={ov.loading}>
            <div className="dash-rows">
              <div className="dash-row"><span className="dash-row-label">status</span><span className="dash-row-value"><Counts counts={d.fleet.byStatus} /></span></div>
              <div className="dash-row"><span className="dash-row-label">kind</span><span className="dash-row-value"><Counts counts={d.fleet.byKind} /></span></div>
              <div className="dash-row"><span className="dash-row-label">region</span><span className="dash-row-value"><Counts counts={d.fleet.byRegion} /></span></div>
              <div className="dash-row"><span className="dash-row-label">agents</span><span className="dash-row-value">{d.fleet.connected} box{d.fleet.poolAgentsConnected ? ` (${d.fleet.poolAgentsConnected} pool)` : ''} · {d.fleet.legacyAgentsConnected} orchestrator</span></div>
            </div>
          </ChartCard>
          <ChartCard title="Sessions" subtitle="agent panes right now" stale={ov.loading}>
            <div className="dash-rows">
              <div className="dash-row"><span className="dash-row-label">status</span><span className="dash-row-value"><Counts counts={d.sessions.byStatus} /></span></div>
              <div className="dash-row"><span className="dash-row-label">provider</span><span className="dash-row-value"><Counts counts={d.sessions.byProvider} /></span></div>
              <div className="dash-row"><span className="dash-row-label">projects</span><span className="dash-row-value"><Counts counts={d.projects.byProvider} /></span></div>
              <div className="dash-row"><span className="dash-row-label">rate limited</span><span className="dash-row-value">{d.sessions.rateLimited}</span></div>
              <div className="dash-row"><span className="dash-row-label">cloud</span><span className="dash-row-value">
                <Link to="/admin/cloud">{d.cloud?.running ?? 0} running · {d.cloud?.starting ?? 0} starting · {d.cloud?.queued ?? 0} queued</Link>
              </span></div>
              <div className="dash-row"><span className="dash-row-label">hosts offline</span><span className="dash-row-value">{d.sessions.offlineHosts}</span></div>
            </div>
          </ChartCard>
        </div>
      )}
      {d && (
        <div className="dash-grid-2">
          <ChartCard title="Working time" subtitle="agents vs humans, all users (server-local days)" value={fmtMs(d.worktime.totals.agentMs + d.worktime.totals.humanMs)} stale={ov.loading}
            table={{ columns: ['date', 'agents', 'humans'], rows: wtRows.map(r => [r.label, fmtMs(r.agent), fmtMs(r.human)]) }}>
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <BarChart data={wtRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
                <CartesianGrid vertical={false} stroke={GRID_STROKE} />
                <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tick={TICK} tickLine={false} axisLine={false} width={36} tickFormatter={hoursTick} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={fmtDurationShort} total />} />
                <Bar dataKey="agent" name="agents" fill={AGENT_COLOR} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
                <Bar dataKey="human" name="humans" fill={HUMAN_COLOR} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
            <SeriesLegend series={[{ id: 'a', label: 'agents', color: AGENT_COLOR }, { id: 'h', label: 'humans', color: HUMAN_COLOR }]} />
          </ChartCard>
          <ChartCard title="Tokens" subtitle={`all users, by kind (UTC days) · ${d.tokens.totals.calls} calls`} value={fmtTok(d.tokens.totals.total)} stale={ov.loading}
            table={{ columns: ['date', 'input', 'output', 'cache read', 'cache create'], rows: tokRows.map(r => [r.label, fmtTok(r.input), fmtTok(r.output), fmtTok(r.cacheRead), fmtTok(r.cacheCreate)]) }}>
            <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
              <BarChart data={tokRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
                <CartesianGrid vertical={false} stroke={GRID_STROKE} />
                <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tick={TICK} tickLine={false} axisLine={false} width={40} tickFormatter={fmtK} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={fmtK} total />} />
                {(['input', 'output', 'cacheRead', 'cacheCreate'] as const).map(k => (
                  <Bar key={k} dataKey={k} name={k} stackId="t" fill={TOK_COLORS[k]} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
                ))}
              </BarChart>
            </ResponsiveContainer>
            <SeriesLegend series={(['input', 'output', 'cacheRead', 'cacheCreate'] as const).map(k => ({ id: k, label: k, color: TOK_COLORS[k] }))} />
          </ChartCard>
        </div>
      )}
    </>
  );
}
