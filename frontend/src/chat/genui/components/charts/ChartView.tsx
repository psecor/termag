// Chart.tsx's drawing, a chunk of its own so recharts loads only for a spec
// that has a chart. The chrome is the dashboard's (chartTheme.tsx) and the
// colours its validated categorical palette (theme/seriesPalette.ts), assigned
// by series order, so a chart here reads like every other chart in termag.
import React from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BAR_MAX, GRID_STROKE, SeriesLegend, SURFACE, TICK, wash } from '../../../../pages/dashboard/chartTheme';
import { PALETTE } from '../../../../theme/seriesPalette';
import { CHART_HEIGHT, type ChartProps } from '../Chart';

const CURRENCY = new Set(['$', '€', '£', '¥']);
/** A value as shown: grouped digits and the unit ("$" before, "%" close after, a word after a space). */
export function formatValue(v: number, unit?: string): string {
  const n = v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (!unit) return n;
  if (CURRENCY.has(unit)) return v < 0 ? `−${unit}${n.replace(/^-/, '')}` : `${unit}${n}`;
  return unit === '%' ? `${n}%` : `${n} ${unit}`;
}

/** Axis ticks: short (1.2k, 3.4M), the unit left to the tooltip. */
const compact = (v: number) => (Math.abs(v) >= 1000 ? Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v) : String(v));

interface TipRow { name?: string; value?: number | null; color?: string; dataKey?: string | number }
function Tip({ active, payload, label, unit }: { active?: boolean; payload?: TipRow[]; label?: string | number; unit?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="dash-tip" role="tooltip">
      <div className="dash-tip-label">{label}</div>
      {payload.map(r => (
        <div className="dash-tip-row" key={String(r.dataKey)}>
          <i className="dash-tip-key" style={{ background: r.color }} />
          <span className="dash-tip-value">{r.value == null ? '–' : formatValue(r.value, unit)}</span>
          {payload.length > 1 && <span className="dash-tip-name">{r.name}</span>}
        </div>
      ))}
    </div>
  );
}

export default function ChartView({ label, kind = 'bar', x, series, stacked, unit, height = 'medium' }: ChartProps) {
  const data = x.map((at, i) => ({ x: String(at), ...Object.fromEntries(series.map((s, j) => [`s${j}`, s.values[i]])) }));
  const colors = series.map((_, j) => PALETTE[j]);
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke={GRID_STROKE} />
      <XAxis dataKey="x" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
      <YAxis tick={TICK} tickLine={false} axisLine={false} width={44} tickFormatter={compact} />
    </>
  );
  const tip = <Tooltip content={<Tip unit={unit} />} cursor={kind === 'bar' ? { fill: 'rgba(255,255,255,0.04)' } : { stroke: GRID_STROKE }} isAnimationActive={false} />;
  const margin = { top: 8, right: 8, left: 0, bottom: 0 };
  const dots = x.length <= 12;
  return (
    <figure className="genui-chart" aria-label={label} style={{ margin: 0 }}>
      <div aria-hidden="true">
        <ResponsiveContainer width="100%" height={CHART_HEIGHT[height]}>
          {kind === 'line' ? (
            <LineChart data={data} margin={margin}>
              {axes}{tip}
              {series.map((s, j) => (
                <Line key={j} dataKey={`s${j}`} name={s.name} type="monotone" stroke={colors[j]} strokeWidth={2} isAnimationActive={false}
                  dot={dots ? { r: 4, fill: colors[j], stroke: SURFACE, strokeWidth: 2 } : false} activeDot={{ r: 5, stroke: SURFACE, strokeWidth: 2 }} />
              ))}
            </LineChart>
          ) : kind === 'area' ? (
            <AreaChart data={data} margin={margin}>
              {axes}{tip}
              {series.map((s, j) => (
                <Area key={j} dataKey={`s${j}`} name={s.name} type="monotone" stackId={stacked ? 'stack' : undefined}
                  stroke={colors[j]} strokeWidth={2} fill={wash(colors[j], 0.14)} isAnimationActive={false} />
              ))}
            </AreaChart>
          ) : (
            <BarChart data={data} margin={margin} barCategoryGap="25%" barGap={2}>
              {axes}{tip}
              {series.map((s, j) => (
                <Bar key={j} dataKey={`s${j}`} name={s.name} stackId={stacked ? 'stack' : undefined} fill={colors[j]}
                  stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false}
                  radius={!stacked || j === series.length - 1 ? [4, 4, 0, 0] : 0} />
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
        <SeriesLegend series={series.map((s, j) => ({ id: String(j), label: s.name, color: colors[j] }))} mark={kind === 'bar' ? 'rect' : 'line'} />
      </div>
      {/* The same numbers as a table, for a screen reader: a chart's shape is not its only reading. */}
      <table className="genui-sr">
        <caption>{label}</caption>
        <thead><tr><th scope="col" />{series.map((s, j) => <th key={j} scope="col">{s.name}</th>)}</tr></thead>
        <tbody>
          {x.map((at, i) => (
            <tr key={i}><th scope="row">{String(at)}</th>{series.map((s, j) => <td key={j}>{s.values[i] == null ? '–' : formatValue(s.values[i]!, unit)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
