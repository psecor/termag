import React, { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, BarChart } from 'recharts';
import { adminApi, CLOUD_REPORT_GROUPS, type AdminCloudSession, type AdminRange, type BoxCapacity, type CloudReportGroup, type OrchestratorHealth, type PipelineBox } from '../../services/adminApi';
import { ChartCard } from '../dashboard/ChartCard';
import { TICK, GRID_STROKE, SURFACE, BAR_MAX, CHART_HEIGHT, DashTooltip, SeriesLegend } from '../dashboard/chartTheme';
import { shortDate } from '../dashboard/range';
import { deltaPct } from '../dashboard/KpiRow';
import { useAdminPolled, pendingText, DataTable, KeyValues, Counts, StatusPill, Dot, fmtAgo, fmtSeconds, type Column } from './shared';
import { cloudStateLabel, platformLabel } from '../../utils/cloudSessions';
import { adminCloudName, daysForRange, fmtBytesShort, fmtPercentiles, pipelineShare, pipelineVerdict, pollStale, pressureCell, pressureClass, reportChartRows, slotHours, stackKeys, tmuxLabel } from '../../utils/adminCloud';
import { fmtK } from '../../utils/format';

/**
 * Claude Code cloud sessions, org-wide: the orchestrator's own health
 * from its loopback endpoint on this host; the runs on every box with their
 * live status, queued sessions with their reasons and the owner's box states,
 * recent ends; history over the shared range (sessions, slot-hours, ends and
 * refusals by reason, queue and spawn latency), capacity against the per-box
 * cap, and per-box pipeline health. Metadata only: no titles (the title is an
 * owner's first prompt), no pane contents. `?box=<id>` narrows the live and
 * recent tables to one box (the Fleet tab links here that way).
 */
const PALETTE = ['rgb(88, 166, 255)', 'rgb(63, 185, 80)', 'rgb(246, 185, 59)', 'rgb(188, 140, 255)', 'rgb(248, 113, 113)', 'rgb(94, 234, 212)', 'rgb(139, 148, 158)', 'rgb(251, 146, 60)'];
const color = (i: number) => PALETTE[i % PALETTE.length];
const SESSIONS_COLOR = 'rgb(88, 166, 255)';
const HOURS_COLOR = 'rgb(246, 185, 59)';
const fmtHours = (h: number) => `${h}h`;

function healthItems(h: OrchestratorHealth, now: number): Array<[string, React.ReactNode]> {
  if (!h.available) return [['orchestrator', <span className="admin-warn">{h.reason ?? 'unavailable'}</span>]];
  const b = h.body ?? {};
  const connected = b.connected === true;
  const counts = (b.queue_counts && typeof b.queue_counts === 'object') ? b.queue_counts as Record<string, number> : null;
  const lastPoll = typeof b.last_poll_at === 'string' ? b.last_poll_at : null;
  const stale = pollStale(lastPoll, now);
  return [
    ['control plane', <span className={connected ? 'admin-ok' : 'admin-warn'}>{connected ? 'connected' : 'NOT connected: the last poll of Anthropic failed'}</span>],
    ['spawn queue', counts ? <Counts counts={counts} /> : '—'],
    ['last poll', lastPoll ? <span className={stale ? 'admin-warn' : ''}>{fmtAgo(lastPoll, now)}{stale ? ' · stale: the unit polls every few seconds' : ''}</span> : '—'],
    ['health port', `127.0.0.1:${h.port}${h.cached ? ' · cached' : ''} · read ${fmtAgo(h.fetchedAt, now)}`],
  ];
}

/** The live status cell: the pill the project tables use, then what the agent waits on, a rate limit, the context size. */
function LiveCell({ s }: { s: AdminCloudSession }) {
  if (!s.live) return <span className="usage-dim">{s.state === 'running' ? 'no status yet' : '—'}</span>;
  const l = s.live;
  const extra = [
    l.waitingReason ? `on ${l.waitingReason}` : '',
    l.rateLimited ? `rate limited: ${l.rateLimited}` : '',
    l.contextTokens != null ? `${fmtK(l.contextTokens)} ctx` : '',
  ].filter(Boolean).join(' · ');
  return <span><StatusPill status={l.status} />{extra ? <span className={`usage-dim ${l.rateLimited ? 'admin-bad' : ''}`}> {extra}</span> : null}</span>;
}

function GroupPicker({ value, onChange }: { value: CloudReportGroup; onChange: (g: CloudReportGroup) => void }) {
  return (
    <div className="dash-range" role="group" aria-label="group by">
      {CLOUD_REPORT_GROUPS.map(g => <button key={g} type="button" aria-pressed={value === g} onClick={() => onChange(g)}>{g === 'exitReason' ? 'exit reason' : g}</button>)}
    </div>
  );
}

/** The run's posted token total, with the model on hover; a dash until the box posts usage (S4). */
function UsageCell({ run }: { run: AdminCloudSession['current'] }) {
  const u = run?.usage;
  if (!u) return <span className="usage-dim">—</span>;
  return <span title={`${fmtK(u.input)} in · ${fmtK(u.output)} out · ${fmtK(u.cacheRead)} cache read · ${fmtK(u.cacheCreate)} cache create${u.model ? ` · ${u.model}` : ''}${u.calls != null ? ` · ${u.calls} calls` : ''}`}>{fmtK(u.total)}</span>;
}

type LiveRow = AdminCloudSession & { boxName: string; boxConnected: boolean };

export function AdminCloud({ range, now }: { range: AdminRange; now: number }) {
  const [params, setParams] = useSearchParams();
  const boxFilter = params.get('box');
  const [group, setGroup] = useState<CloudReportGroup>('day');
  const health = useAdminPolled(useCallback(() => adminApi.orchestratorHealth(), []), 30_000);
  const sessions = useAdminPolled(useCallback(() => adminApi.cloudSessions(daysForRange(range), 500), [range]), 30_000, { deps: [range] });
  const report = useAdminPolled(useCallback(() => adminApi.cloudReport(range, group), [range, group]), 60_000, { deps: [range, group] });
  const capacity = useAdminPolled(useCallback(() => adminApi.cloudCapacity(), []), 60_000);
  const pipeline = useAdminPolled(useCallback(() => adminApi.cloudPipeline(), []), 5 * 60_000);
  const h = health.data;
  const d = sessions.data;
  const r = report.data;
  const cap = capacity.data;
  const ownerBoxesByName = new Map(Object.values(cap?.owners ?? {}).map(o => [o.owner, o]));

  const link = (s: AdminCloudSession) => s.url
    ? <a href={s.url} target="_blank" rel="noreferrer" title={`Open on claude.ai (${s.sessionId ?? s.key})`}>{adminCloudName(s.owner, s.name)}</a>
    : <span title={s.key}>{adminCloudName(s.owner, s.name)}</span>;
  const liveCols: Column<LiveRow>[] = [
    { id: 'box', label: 'box', value: r => r.boxName },
    { id: 'owner', label: 'owner', value: r => r.owner },
    { id: 'slot', label: 'slot', value: r => r.current?.slot ?? null, align: 'right' },
    { id: 'state', label: 'state', value: r => r.state, render: r => <span className={`cloud-state cloud-state--${r.state}`}>{cloudStateLabel(r)}</span> },
    { id: 'status', label: 'status', value: r => r.live?.status ?? '', render: r => <LiveCell s={r} />, title: 'live working/waiting/ready from the session\'s status hooks' },
    { id: 'since', label: 'since', value: r => r.live?.updatedAt ? Date.parse(r.live.updatedAt) : null, render: r => fmtAgo(r.live?.updatedAt, now), title: 'last status write' },
    { id: 'from', label: 'from', value: r => platformLabel(r.clientPlatform) ?? '' },
    { id: 'started', label: 'started', value: r => r.current?.startedAt ?? r.firstSeenAt, render: r => fmtAgo(r.current?.startedAt ?? r.firstSeenAt, now) },
    { id: 'alive', label: 'tmux', value: r => r.current?.alive == null ? null : r.current.alive ? 1 : 0, render: r => tmuxLabel(r.current?.alive ?? null, r.boxConnected) },
    { id: 'tokens', label: 'tokens', value: r => r.current?.usage?.total ?? null, align: 'right', render: r => <UsageCell run={r.current} />, title: 'cumulative, posted by the session itself on each turn' },
    { id: 'session', label: 'session', value: r => r.key, render: link },
  ];
  const queuedCols: Column<AdminCloudSession>[] = [
    { id: 'owner', label: 'owner', value: r => r.owner },
    { id: 'since', label: 'queued since', value: r => r.queuedSince ?? r.lastSeenAt, render: r => fmtAgo(r.queuedSince ?? r.lastSeenAt, now) },
    { id: 'reason', label: 'reason', value: r => r.queuedReason ?? '' },
    // The owner's boxes and their states: "nudge them to start a box" or "raise the cap" (G13).
    { id: 'boxes', label: "owner's boxes", value: r => ownerBoxesByName.get(r.owner)?.boxes ?? '', render: r => ownerBoxesByName.get(r.owner)?.boxes ?? <span className="usage-dim">{cap ? 'no boxes' : '…'}</span> },
    { id: 'session', label: 'session', value: r => r.key, render: link },
  ];
  const recentCols: Column<AdminCloudSession>[] = [
    { id: 'owner', label: 'owner', value: r => r.owner },
    { id: 'box', label: 'box', value: r => r.current ? `${r.current.boxName} · ${r.current.slot}` : '' },
    { id: 'state', label: 'end', value: r => r.exitReason ?? r.state, render: r => <span className={`cloud-state cloud-state--${r.state}`}>{cloudStateLabel(r)}</span> },
    { id: 'from', label: 'from', value: r => platformLabel(r.clientPlatform) ?? '' },
    { id: 'ended', label: 'ended', value: r => r.current?.endedAt ?? r.lastSeenAt, render: r => fmtAgo(r.current?.endedAt ?? r.lastSeenAt, now) },
    { id: 'duration', label: 'slot held', value: r => r.current?.durationSec ?? null, align: 'right', render: r => fmtSeconds(r.current?.durationSec ?? null) },
    { id: 'tokens', label: 'tokens', value: r => r.current?.usage?.total ?? null, align: 'right', render: r => <UsageCell run={r.current} /> },
    { id: 'checkout', label: 'checkout', value: r => r.current?.checkoutBytes ?? null, align: 'right', title: 'the session directory when it ended; "kept" means unpushed work stayed on the box',
      render: r => <span className={r.current?.kept ? 'admin-warn' : ''}>{fmtBytesShort(r.current?.checkoutBytes)}{r.current?.kept ? ' · kept' : ''}</span> },
    { id: 'runs', label: 'runs', value: r => r.runs.length, align: 'right' },
    { id: 'session', label: 'session', value: r => r.key, render: link },
  ];
  const capCols: Column<BoxCapacity>[] = [
    { id: 'box', label: 'box', value: r => r.boxName },
    { id: 'owner', label: 'owner', value: r => r.owner ?? '', render: r => r.owner ?? <span className="usage-dim">warm pool</span> },
    { id: 'status', label: 'status', value: r => r.status, render: r => <StatusPill status={r.status} /> },
    { id: 'agent', label: 'agent', value: r => (r.connected ? 1 : 0), render: r => <span><Dot on={r.connected} /> {r.connected ? (r.capable ? 'ready for runners' : 'too old for runners') : 'offline'}</span> },
    { id: 'eligible', label: 'eligible', value: r => (r.eligible ? 1 : 0), render: r => r.eligible ? 'yes' : 'no', title: 'the spawn route would place a session here' },
    { id: 'slots', label: 'slots', value: r => r.slotsUsed, align: 'right', render: r => <span className={r.eligible && r.slotsUsed >= r.slotsMax ? 'admin-warn' : ''}>{r.slotsUsed} / {r.slotsMax}</span> },
    { id: 'pressure', label: 'disk · mem · load', value: r => r.host?.diskUsedPct ?? null, align: 'right', render: r => r.host ? <span className={pressureClass(r.host)}>{pressureCell(r.host)}{r.host.keptCheckouts ? ` · ${r.host.keptCheckouts} kept` : ''}</span> : <span className="usage-dim">—</span> },
  ];
  const pipeCols: Column<PipelineBox>[] = [
    { id: 'box', label: 'box', value: r => r.boxName },
    { id: 'owner', label: 'owner', value: r => r.owner ?? '' },
    { id: 'runs', label: 'runs', value: r => r.runs, align: 'right' },
    { id: 'started', label: 'started', value: r => r.runs ? r.withStarted / r.runs : null, align: 'right', render: r => pipelineShare(r, 'withStarted'), title: 'runs whose box posted started' },
    { id: 'ended', label: 'ended', value: r => r.runs ? r.withEnded / r.runs : null, align: 'right', render: r => pipelineShare(r, 'withEnded'), title: 'runs the box reported an end for' },
    { id: 'platform', label: 'platform', value: r => r.runs ? r.withPlatform / r.runs : null, align: 'right', render: r => pipelineShare(r, 'withPlatform') },
    { id: 'title', label: 'title', value: r => r.runs ? r.withTitle / r.runs : null, align: 'right', render: r => pipelineShare(r, 'withTitle'), title: 'counted, never read' },
    { id: 'lost', label: 'lost', value: r => r.lost, align: 'right', render: r => r.lost ? <span className="admin-bad">{r.lost}</span> : '0' },
    { id: 'commit', label: 'agent commit', value: r => r.agentCommit ?? '', render: r => <span className="admin-mono usage-dim">{r.agentCommit ? r.agentCommit.slice(0, 12) : (r.connected ? 'old agent' : 'offline')}</span> },
    { id: 'verdict', label: 'verdict', value: r => pipelineVerdict(r), render: r => { const v = pipelineVerdict(r); return <span className={v === 'ok' ? 'admin-ok' : v === 'no runs' ? 'usage-dim' : 'admin-warn'}>{v}</span>; } },
  ];

  const boxes = (d?.boxes ?? []).filter(b => !boxFilter || b.instanceId === boxFilter);
  const live: LiveRow[] = boxes.flatMap(b => b.sessions.map(s => ({ ...s, boxName: b.boxName, boxConnected: b.connected })));
  const recent = (d?.recent ?? []).filter(s => !boxFilter || s.current?.instanceId === boxFilter);
  const filteredBoxName = boxFilter ? (d?.boxes.find(b => b.instanceId === boxFilter)?.boxName ?? boxFilter) : null;
  const statusCounts = live.reduce<Record<string, number>>((acc, r) => { const k = r.live?.status ?? 'no status'; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});

  // Label by the grouping the report was computed for: the previous report
  // stays on screen until the new one lands after a picker click.
  const rGroup: CloudReportGroup = r?.groupBy ?? group;
  const chartRows = r ? reportChartRows(r).map(row => ({ ...row, label: rGroup === 'day' ? shortDate(String(row.label)) : String(row.label) })) : [];
  const endKeys = r ? stackKeys(r.rows.map(x => x.ends)) : [];
  const refusalKeys = r ? stackKeys(r.rows.map(x => x.refusals)) : [];
  const refusalRows = chartRows.map(row => Object.fromEntries(Object.entries(row).filter(([k]) => k === 'label' || k.startsWith('refusal:')).map(([k, v]) => [k.replace(/^refusal:/, ''), v])));
  const horizonNote = r && r.range.days > r.eventHorizonDays ? ` · events live ${r.eventHorizonDays} days, so this covers that much` : '';
  const vs = range === 'today' ? 'vs yesterday' : `vs prior ${range}`;
  const delta = (cur: number, prior: number) => { const p = deltaPct(cur, prior); return p == null ? '' : ` (${p > 0 ? '▲' : p < 0 ? '▼' : ''}${Math.abs(p).toFixed(0)}% ${vs})`; };

  return (
    <>
      {boxFilter && (
        <div className="dash-updated">
          showing box <b>{filteredBoxName}</b> only · <button type="button" className="admin-link" onClick={() => setParams({})}>show every box</button>
        </div>
      )}
      <div className="dash-grid-2">
        <ChartCard title="Orchestrator" subtitle={h ? (h.available ? 'claude-runner-orchestrator on this host' : 'not on this host, or down') : pendingText(health)} stale={health.loading}>
          {h && <KeyValues items={healthItems(h, now)} />}
          <div className="usage-dim dash-card-note">
            The health body is the unit's own; `connected` is the alert, `queue_counts` the backlog by state. History and charts: the orchestrator journal and metrics in your observability tool{' '}
            {h?.observabilityUrl ? <a href={h.observabilityUrl} target="_blank" rel="noreferrer">open →</a> : <span>(no OBSERVABILITY_UI_URL configured on this host)</span>}.
          </div>
        </ChartCard>
        <ChartCard title="Sessions now" subtitle={d ? `generated ${fmtAgo(d.generatedAt, now)}` : pendingText(sessions)} stale={sessions.loading}>
          {d && <KeyValues items={[
            ['live', <Counts counts={{ running: d.counts.running, starting: d.counts.starting }} />],
            ['status', <Counts counts={statusCounts} />],
            ['queued', String(d.counts.queued)],
            [`ended in ${d.days}d`, <Counts counts={{ ended: d.counts.ended, lost: d.counts.lost }} />],
            ['boxes with sessions', String(d.boxes.length)],
            ['capacity', cap ? <span>{cap.totals.slotsUsed} / {cap.totals.slotsUsed + cap.totals.slotsFree} slots on {cap.totals.eligibleBoxes} eligible box{cap.totals.eligibleBoxes === 1 ? '' : 'es'}{Object.values(cap.owners).some(o => o.atCap) ? <span className="admin-warn"> · {Object.values(cap.owners).filter(o => o.atCap).map(o => o.owner).join(', ')} at the cap</span> : ''}</span> : '…'],
          ]} />}
        </ChartCard>
      </div>

      <div className="dash-grid-2">
        <ChartCard title="Sessions over time" subtitle={r ? `${r.range.since} → ${r.range.until} (UTC) · ${r.totals.sessions} sessions${delta(r.totals.sessions, r.prior.sessions)} · ${r.totals.runs} runs` : pendingText(report)}
          value={r ? `${slotHours(r.totals.slotSeconds)}h slot time${delta(r.totals.slotSeconds, r.prior.slotSeconds)}${r.totals.tokens ? ` · ${fmtK(r.totals.tokens)} tokens` : ''}` : undefined} stale={report.loading}
          table={r ? { columns: [rGroup, 'sessions', 'runs', 'slot hours', 'tokens', 'lost'], rows: r.rows.map(x => [x.label, x.sessions, x.runs, slotHours(x.slotSeconds), fmtK(x.tokens), x.lost]) } : undefined}>
          <GroupPicker value={group} onChange={setGroup} />
          <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
            <ComposedChart data={chartRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
              <YAxis yAxisId="n" tick={TICK} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
              <YAxis yAxisId="h" orientation="right" tick={TICK} tickLine={false} axisLine={false} width={36} tickFormatter={fmtHours} />
              <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={v => String(v)} />} />
              <Bar yAxisId="n" dataKey="sessions" name="sessions" fill={SESSIONS_COLOR} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
              <Line yAxisId="h" type="monotone" dataKey="slotHours" name="slot hours" stroke={HOURS_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
          <SeriesLegend series={[{ id: 's', label: 'sessions', color: SESSIONS_COLOR }, { id: 'h', label: 'slot hours', color: HOURS_COLOR }]} />
          <div className="usage-dim dash-card-note">Slot time is how long runs held a slot in the range, idle tail included (the runner releases after two idle hours). Tokens are what the sessions posted about themselves, as provider `claude-cloud` on the Usage tab; a box whose hooks predate the usage post shows none.</div>
        </ChartCard>
        <ChartCard title="Latency" subtitle={r ? `from the event log · last ${Math.min(r.range.days, r.eventHorizonDays)} days` : pendingText(report)} stale={report.loading}>
          {r && <KeyValues items={[
            ['queue wait', fmtPercentiles(r.totals.queueWait, s => fmtSeconds(s))],
            ['spawn (placed → started)', fmtPercentiles(r.totals.spawn, s => fmtSeconds(s))],
            ['lost runs', `${r.totals.lost}${delta(r.totals.lost, r.prior.lost)}`],
            ['refusals', <Counts counts={r.refusals} />],
          ]} />}
          <div className="usage-dim dash-card-note">Queue wait is from the first refusal of an unbroken streak to the placement that ended it; spawn is from the backend's placement to the box's started report. Anthropic's own queue series is in your observability tool.</div>
        </ChartCard>
      </div>

      <div className="dash-grid-2">
        <ChartCard title="Ends by reason" subtitle={r ? `runs started in the range, by how they ended · grouped by ${rGroup}` : pendingText(report)} stale={report.loading}
          table={r ? { columns: [rGroup, ...endKeys], rows: r.rows.map(x => [x.label, ...endKeys.map(k => x.ends[k] ?? 0)]) } : undefined}>
          <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
            <BarChart data={chartRows} layout={rGroup === 'day' ? 'horizontal' : 'vertical'} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
              <CartesianGrid vertical={rGroup !== 'day'} horizontal={rGroup === 'day'} stroke={GRID_STROKE} />
              {rGroup === 'day' ? <>
                <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tick={TICK} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
              </> : <>
                <XAxis type="number" tick={TICK} tickLine={false} axisLine={false} allowDecimals={false} />
                <YAxis type="category" dataKey="label" tick={TICK} tickLine={false} axisLine={false} width={120} interval={0} />
              </>}
              <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={v => String(v)} total />} />
              {endKeys.map((k, i) => <Bar key={k} dataKey={k} name={k} stackId="e" fill={color(i)} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />)}
            </BarChart>
          </ResponsiveContainer>
          <SeriesLegend series={endKeys.map((k, i) => ({ id: k, label: k, color: color(i) }))} />
        </ChartCard>
        <ChartCard title="Refusals by reason" subtitle={r ? `why the spawn hook was refused${rGroup === 'day' || rGroup === 'owner' ? ` · grouped by ${rGroup}` : ' · totals (a refusal has no run to group by)'}${horizonNote}` : pendingText(report)} stale={report.loading}
          table={r ? { columns: ['reason', 'count'], rows: Object.entries(r.refusals).sort((a, b) => b[1] - a[1]) } : undefined}>
          {(rGroup === 'day' || rGroup === 'owner') ? (
            <>
              <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
                <BarChart data={refusalRows} layout={rGroup === 'day' ? 'horizontal' : 'vertical'} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
                  <CartesianGrid vertical={rGroup !== 'day'} horizontal={rGroup === 'day'} stroke={GRID_STROKE} />
                  {rGroup === 'day' ? <>
                    <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
                    <YAxis tick={TICK} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                  </> : <>
                    <XAxis type="number" tick={TICK} tickLine={false} axisLine={false} allowDecimals={false} />
                    <YAxis type="category" dataKey="label" tick={TICK} tickLine={false} axisLine={false} width={120} interval={0} />
                  </>}
                  <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={v => String(v)} total />} />
                  {refusalKeys.map((k, i) => <Bar key={k} dataKey={k} name={k} stackId="r" fill={color(i)} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />)}
                </BarChart>
              </ResponsiveContainer>
              <SeriesLegend series={refusalKeys.map((k, i) => ({ id: k, label: k, color: color(i) }))} />
            </>
          ) : (
            <div className="dash-rows">
              {r && Object.entries(r.refusals).sort((a, b) => b[1] - a[1]).map(([k, v]) => <div className="dash-row" key={k}><span className="dash-row-label">{k}</span><span className="dash-row-value">{v}</span></div>)}
              {r && Object.keys(r.refusals).length === 0 && <div className="usage-dim">no refusals in the range</div>}
            </div>
          )}
        </ChartCard>
      </div>

      <ChartCard title="Live runs" subtitle="one row per run on a box; the title is the owner's and is not shown" stale={sessions.loading}>
        <DataTable rows={live} columns={liveCols} rowKey={r => r.key} defaultSort="started" dense empty={boxFilter ? 'no cloud session is running on this box' : 'no cloud session is running on any box'} />
      </ChartCard>
      <ChartCard title="Queued" subtitle="sessions the spawn hook refused, with the reason the Activity tab shows and the owner's boxes" stale={sessions.loading}>
        <DataTable rows={d?.queued ?? []} columns={queuedCols} rowKey={r => r.key} defaultSort="since" dense empty="nothing queued" />
      </ChartCard>
      <ChartCard title="Recent ends" subtitle={d ? `ended and lost sessions in the last ${d.days} day${d.days === 1 ? '' : 's'}, newest first, at most 500` : pendingText(sessions)} stale={sessions.loading}>
        <DataTable rows={recent} columns={recentCols} rowKey={r => r.key} defaultSort="ended" dense empty="nothing ended in the window" />
      </ChartCard>
      <ChartCard title="Capacity" subtitle={cap ? `${cap.totals.slotsUsed} of ${cap.totals.slotsUsed + cap.totals.slotsFree} slots in use · cap ${cap.max} per box · every non-terminated box, judged by the spawn route's rule` : pendingText(capacity)} stale={capacity.loading}>
        <DataTable rows={cap?.boxes ?? []} columns={capCols} rowKey={r => r.instanceId} defaultSort="slots" dense empty="no boxes" />
        <div className="usage-dim dash-card-note">Slots used are open runs in Postgres; a vanished runner is closed by the lost sweep within ten minutes. Raising the cap is a configuration change.</div>
      </ChartCard>
      <ChartCard title="Pipeline health" subtitle={pipeline.data ? `per box, last ${pipeline.data.days} days: which box-side signals reach the backend` : pendingText(pipeline)} stale={pipeline.loading}>
        <DataTable rows={pipeline.data?.boxes ?? []} columns={pipeCols} rowKey={r => r.instanceId} defaultSort="runs" dense empty="no cloud runs in the window" />
      </ChartCard>
    </>
  );
}
