import React, { useCallback } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { adminApi, type BoxCostBox, type BoxCostMoney, type BoxCostPerson, type BoxReconcile, type BoxReconcileLine } from '../../services/adminApi';
import { ChartCard } from '../dashboard/ChartCard';
import { TICK, GRID_STROKE, SURFACE, BAR_MAX, CHART_HEIGHT, HUE, CURSOR, DashTooltip, SeriesLegend } from '../dashboard/chartTheme';
import { shortDate } from '../dashboard/range';
import { DataTable, KeyValues, fmtPct, pendingText, useAdminPolled, type Column } from './shared';
import { fmtUsd } from './spendText';

// The Spend tab's series colours, in its order, so the two charts read as one system.
const SERIES = [
  { id: 'active', label: 'active', color: HUE.blue },
  { id: 'idle', label: 'idle', color: HUE.amber },
  { id: 'overhead', label: 'pool & booting', color: HUE.purple },
  { id: 'orphan', label: 'no termag row', color: HUE.red },
  { id: 'storage', label: 'storage', color: HUE.green },
];

const fmtHours = (h: number) => (h >= 100 ? Math.round(h).toLocaleString('en-US') : h.toFixed(1));
const fmtRate = (usd: number) => `$${usd.toFixed(3)}`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The money columns both tables share. */
function moneyCols<T extends { usd: BoxCostMoney }>(): Column<T>[] {
  return [
    { id: 'compute', label: 'compute', value: x => x.usd.compute, align: 'right', render: x => fmtUsd(x.usd.compute) },
    { id: 'idle', label: 'of it idle', value: x => x.usd.idle, align: 'right', render: x => fmtUsd(x.usd.idle), title: 'running with no human input or agent work in the last 15 minutes' },
    { id: 'storage', label: 'storage', value: x => x.usd.storage, align: 'right', render: x => fmtUsd(x.usd.storage), title: 'root volume, billed in every power state' },
    { id: 'total', label: 'total', value: x => x.usd.total, align: 'right', render: x => fmtUsd(x.usd.total) },
  ];
}

const peopleCols: Column<BoxCostPerson>[] = [
  { id: 'name', label: 'person', value: x => x.name },
  { id: 'boxes', label: 'boxes', value: x => x.boxes, align: 'right' },
  { id: 'hours', label: 'running h', value: x => x.runningHours, align: 'right', render: x => fmtHours(x.runningHours) },
  { id: 'activeShare', label: 'active', value: x => x.activeShare, align: 'right', render: x => (x.activeShare == null ? '—' : fmtPct(x.activeShare)), title: 'share of running hours with someone or an agent working' },
  ...moneyCols<BoxCostPerson>(),
];

const boxCols: Column<BoxCostBox>[] = [
  { id: 'name', label: 'box', value: x => x.name ?? x.ec2InstanceId, render: x => (
    !x.name ? <span className="admin-bad" title="EC2 has it; termag has no row for it">{x.ec2InstanceId}</span>
      : x.teardownUnfinished ? <span className="admin-bad" title="termag terminated it and EC2 still had it an hour or more later: a teardown that didn't finish">{x.name} <span className="usage-dim">· {x.ec2InstanceId}</span></span>
        : <span>{x.name}</span>) },
  { id: 'owner', label: 'owner', value: x => x.owner ?? '' },
  { id: 'status', label: 'status', value: x => x.status ?? '' },
  { id: 'type', label: 'type', value: x => x.instanceType },
  { id: 'gb', label: 'GB', value: x => x.volumeGb, align: 'right' },
  { id: 'hours', label: 'running h', value: x => x.runningHours, align: 'right', render: x => fmtHours(x.runningHours) },
  { id: 'activeShare', label: 'active', value: x => x.activeShare, align: 'right', render: x => (x.activeShare == null ? '—' : fmtPct(x.activeShare)) },
  ...moneyCols<BoxCostBox>(),
];

type ReconcileRow = BoxReconcileLine & { kind: 'drift' | 'not metered' | 'not billed' };

const reconcileCols: Column<ReconcileRow>[] = [
  { id: 'kind', label: 'why', value: x => x.kind, render: x => <span className={x.kind === 'not metered' ? 'usage-dim' : 'admin-bad'}>{x.kind}</span> },
  { id: 'name', label: 'instance', value: x => x.name ?? x.ec2InstanceId, render: x => <span>{x.name ?? x.ec2InstanceId}{x.name ? <span className="usage-dim"> · {x.ec2InstanceId}</span> : null}</span> },
  { id: 'type', label: 'type', value: x => x.instanceType ?? '' },
  { id: 'mh', label: 'metered h', value: x => x.meteredHours, align: 'right', render: x => fmtHours(x.meteredHours) },
  { id: 'bh', label: 'billed h', value: x => x.billedHours, align: 'right', render: x => fmtHours(x.billedHours) },
  { id: 'gap', label: 'apart', value: x => Math.abs(x.meteredHours - x.billedHours), align: 'right', render: x => fmtHours(x.meteredHours - x.billedHours) },
  { id: 'bu', label: 'billed', value: x => x.billedUsd, align: 'right', render: x => fmtUsd(x.billedUsd) },
];

/** Metered against billed: the totals, then every instance that doesn't line up. */
function Reconcile({ rc, loading }: { rc: BoxReconcile | null | undefined; loading: boolean }) {
  const rows: ReconcileRow[] = rc ? [
    ...rc.drift.map(l => ({ ...l, kind: 'drift' as const })),
    ...rc.notBilled.map(l => ({ ...l, kind: 'not billed' as const })),
    ...rc.notMetered.map(l => ({ ...l, kind: 'not metered' as const })),
  ] : [];
  const span = rc ? (rc.days.length === 1 ? rc.days[0] : `${rc.days[0]} → ${rc.days[rc.days.length - 1]}`) : '';
  return (
    <ChartCard title="Metered vs billed" stale={loading}
      subtitle={rc ? `${span} (UTC), whole days the meter covered and the bill has settled (two days back)${rc.estimatedDays ? ` · ${plural(rc.estimatedDays, 'day', 'days')} still estimated by AWS` : ''}` : 'nothing to compare yet: needs a whole day the meter covered that Cost Explorer has had two days to settle (about three days after deploy, once the orchestrator can read Cost Explorer)'}>
      {rc && <KeyValues items={[
        ['boxes', `metered ${fmtHours(rc.meteredHours)} h · billed ${fmtHours(rc.billedHours)} h (${rc.billedHours > 0 ? fmtPct(rc.meteredHours / rc.billedHours) : '—'}) · billed ${fmtUsd(rc.billedUsd)}, metered ${fmtUsd(rc.meteredUsd)}`],
        ['apart', `${plural(rc.drift.length, 'box', 'boxes')} more than half an hour or 5% apart · ${plural(rc.notBilled.length, 'box', 'boxes')} metered with no bill`],
        ['not metered', `${plural(rc.notMetered.length, 'instance', 'instances')} billed ${fmtUsd(rc.notMeteredUsd)} and never metered: not boxes (the orchestrator, image builders), or boxes the meter missed`],
      ]} />}
      {rc && <DataTable rows={rows} columns={reconcileCols} rowKey={x => `${x.kind}:${x.ec2InstanceId}`} defaultSort="bu" dense empty="everything lines up" />}
    </ChartCard>
  );
}

/** The Spend tab's Boxes section: what the AWS boxes cost in the window. */
export function AdminBoxCost({ from, to }: { from: string; to: string }) {
  const report = useAdminPolled(useCallback(() => adminApi.boxCost(from, to), [from, to]), 5 * 60_000, { deps: [from, to] });
  const r = report.data;
  const t = r?.totals;
  const rows = (r?.days ?? []).map(d => ({ label: shortDate(d.day), active: d.active, idle: d.idle, overhead: d.pool + d.boot, orphan: d.orphan, storage: d.storage, total: d.total }));
  const since = r?.meteredFrom ? r.meteredFrom.slice(0, 10) : null;
  const partial = r && since && since > r.window.since;
  // Idle as a share of the time someone owned the box, not of everything: pool and stray time are nobody's.
  const owned = t ? t.active + t.idle + t.boot : 0;

  return (
    <>
      <ChartCard title="Boxes" value={t ? fmtUsd(t.total, { compact: true }) : undefined} stale={report.loading}
        subtitle={r ? `${r.window.since} → ${r.window.until} (UTC) · EC2 compute and root volumes, metered from EC2 every few minutes, at the bill's effective rates${partial ? ` · metered from ${since} only` : ''}${!since ? ' · nothing metered in this window yet' : ''}` : pendingText(report)}
        table={r ? { columns: ['day', ...SERIES.map(s => s.label), 'total'], rows: rows.map(d => [d.label, ...SERIES.map(s => fmtUsd((d as Record<string, unknown>)[s.id] as number)), fmtUsd(d.total)]) } : undefined}>
        {t && r && <KeyValues items={[
          ['compute', `${fmtUsd(t.compute)} for ${fmtHours(t.runningHours)} running hours on ${plural(t.boxes, 'box', 'boxes')}: active ${fmtUsd(t.active)} · idle ${fmtUsd(t.idle)} · booting ${fmtUsd(t.boot)} · warm pool ${fmtUsd(t.pool)}${t.orphan > 0 ? ` · no termag row ${fmtUsd(t.orphan)}` : ''}`],
          ['idle', owned > 0 ? `${fmtPct(t.idle / owned)} of owned boxes' compute (${fmtUsd(t.idle)}) ran 15 minutes or more after the last human input or agent work. An upper bound on what hibernating sooner would save: auto-hibernate waits an hour or more and also counts SSH sessions, load and box updates, which the meter does not see` : '—'],
          ['storage', `${fmtUsd(t.storage)} for root volumes, in every power state`],
          ['parked now', `${plural(r.parked.boxes, 'stopped or hibernated box keeps', 'stopped or hibernated boxes keep')} ${r.parked.gb.toLocaleString('en-US')} GB: ${fmtUsd(r.parked.monthlyUsd)} a month`],
          ...(t.orphan > 0 ? [['no termag row', `${fmtUsd(t.orphan)} of compute on instances EC2 runs that termag has no live row for (red in the boxes table)`] as [string, string]] : []),
          ['rates', `${Object.entries(r.rates.perHour).map(([k, v]) => `${k} ${fmtRate(v)}/h`).join(' · ')} · gp3 ${fmtRate(r.rates.gp3PerGbMonth)}/GB-month · ${r.rates.source}`],
          ...(r.unrated.length ? [['unrated', `${r.unrated.join(', ')}: no rate, compute counted as $0`] as [string, string]] : []),
        ]} />}
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={48} tickFormatter={v => fmtUsd(v, { compact: true })} />
            <Tooltip cursor={CURSOR} content={<DashTooltip fmt={v => fmtUsd(v)} total />} />
            {SERIES.map(s => <Bar key={s.id} dataKey={s.id} name={s.label} stackId="b" fill={s.color} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />)}
          </BarChart>
        </ResponsiveContainer>
        <SeriesLegend series={SERIES} />
      </ChartCard>

      <Reconcile rc={r?.reconcile} loading={report.loading} />

      <ChartCard title="Box cost by person" subtitle="owned boxes only; the warm pool and boxes with no termag row belong to nobody" stale={report.loading}>
        <DataTable rows={r?.people ?? []} columns={peopleCols} rowKey={x => x.userId} defaultSort="total" dense empty={r ? 'no box hours in this window' : pendingText(report)} />
      </ChartCard>

      <ChartCard title="Box cost by box" subtitle="type and GB as of the box's latest metered day; red: EC2 had it with no termag row, or kept it an hour past its teardown" stale={report.loading}>
        <DataTable rows={r?.boxes ?? []} columns={boxCols} rowKey={x => x.ec2InstanceId} defaultSort="total" dense empty={r ? 'no box hours in this window' : pendingText(report)} />
      </ChartCard>
    </>
  );
}
