// PieChart.tsx's drawing, a chunk of its own so recharts loads only for a
// spec that has a donut. The tooltip and legend are the dashboard's
// (chartTheme.tsx) and the colours its validated categorical palette
// (theme/seriesPalette.ts), assigned by slice order, so a donut here reads like
// every other chart in termag.
import React from 'react';
import { Pie, PieChart, Sector, Tooltip, type PieSectorShapeProps } from 'recharts';
import { SURFACE } from '../../../../pages/dashboard/chartTheme';
import { PALETTE } from '../../../../theme/seriesPalette';
import { PIE_SIZE, type PieChartProps } from '../PieChart';

/** The ring: thin, with room outside it for the hovered slice to lift. */
const OUTER = PIE_SIZE / 2 - 4;
const INNER = OUTER - 20;
const LIFT = 3;

const CURRENCY = new Set(['$', '€', '£', '¥']);
/** A value as shown: grouped digits (or 12.9K when compact) and the unit ("$" before, "%" close after, a word after a space). */
export function formatValue(v: number, unit?: string, compact = false): string {
  const n = compact && Math.abs(v) >= 10_000
    ? Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v)
    : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (!unit) return n;
  if (CURRENCY.has(unit)) return v < 0 ? `−${unit}${n.replace(/^-/, '')}` : `${unit}${n}`;
  return unit === '%' ? `${n}%` : `${n} ${unit}`;
}

/** A slice's share of the whole: whole percents from 10%, one decimal under it, "<0.1%" for a sliver, "–" with no whole. */
export function formatShare(part: number, whole: number): string {
  if (whole <= 0) return '–';
  const pct = (part / whole) * 100;
  if (pct === 0) return '0%';
  if (pct < 0.1) return '<0.1%';
  return pct >= 10 ? `${Math.round(pct)}%` : `${Number(pct.toFixed(1))}%`;
}

interface Datum { name: string; value: number; fill: string; share: string }
interface TipRow { name?: string; value?: number; payload?: Datum }
function Tip({ active, payload, unit }: { active?: boolean; payload?: TipRow[]; unit?: string }) {
  const row = payload?.[0];
  if (!active || !row?.payload) return null;
  return (
    <div className="dash-tip" role="tooltip">
      <div className="dash-tip-label">{row.payload.name}</div>
      <div className="dash-tip-row">
        <i className="dash-tip-key" style={{ background: row.payload.fill }} />
        <span className="dash-tip-value">{formatValue(row.payload.value, unit)}</span>
        <span className="dash-tip-name">{row.payload.share}</span>
      </div>
    </div>
  );
}

/** A slice, lifted outward while it is hovered (the tooltip's active item). */
const SliceShape = (p: PieSectorShapeProps) => <Sector {...p} outerRadius={p.isActive ? p.outerRadius + LIFT : p.outerRadius} />;

export default function PieChartView({ label, slices, unit, totalLabel }: PieChartProps) {
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const data: Datum[] = slices.map((s, i) => ({ name: s.label, value: s.value, fill: PALETTE[i], share: formatShare(s.value, total) }));
  // Empty slices draw nothing (a zero-width sector would still show its gap); they keep their colour, legend entry and row.
  const drawn = data.filter(d => d.value > 0);
  return (
    <figure className="genui-piechart" aria-label={label}>
      <div className="genui-piechart-drawing" aria-hidden="true">
        <div className="genui-piechart-plot" style={{ width: PIE_SIZE, height: PIE_SIZE }}>
          <PieChart width={PIE_SIZE} height={PIE_SIZE} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            {drawn.length > 0 ? (
              <>
                <Tooltip content={<Tip unit={unit} />} isAnimationActive={false} />
                {/* Clockwise from 12 o'clock. The surface-coloured 2px stroke is the gap between slices; one slice has no neighbour to keep apart. */}
                <Pie data={drawn} dataKey="value" nameKey="name" startAngle={90} endAngle={-270} innerRadius={INNER} outerRadius={OUTER}
                  stroke={drawn.length > 1 ? SURFACE : 'none'} strokeWidth={2} shape={SliceShape} isAnimationActive={false} />
              </>
            ) : (
              // Nothing to divide: the empty ring.
              <Pie data={[{ name: '', value: 1 }]} dataKey="value" startAngle={90} endAngle={-270} innerRadius={INNER} outerRadius={OUTER}
                fill="var(--bg-active)" stroke="none" isAnimationActive={false} />
            )}
          </PieChart>
          {totalLabel && (
            <div className="genui-piechart-center">
              <span className="genui-piechart-total">{formatValue(total, unit, true)}</span>
              <span className="genui-piechart-total-label">{totalLabel}</span>
            </div>
          )}
        </div>
        {/* Every slice, a lone one too: a slice's name and share are shown only here. The
            dashboard's SeriesLegend (same look) draws nothing for one series. */}
        <div className="usage-legend" aria-label="legend">
          {data.map((d, i) => <span key={i}><i style={{ background: d.fill }} />{d.name} {d.share}</span>)}
        </div>
      </div>
      {/* The same numbers as a table, for a screen reader: a donut's shape is not its only reading. */}
      <table className="genui-sr">
        <caption>{label}</caption>
        <thead><tr><th scope="col">Slice</th><th scope="col">Value</th><th scope="col">Share</th></tr></thead>
        <tbody>
          {data.map((d, i) => <tr key={i}><th scope="row">{d.name}</th><td>{formatValue(d.value, unit)}</td><td>{d.share}</td></tr>)}
        </tbody>
        <tfoot><tr><th scope="row">Total</th><td>{formatValue(total, unit)}</td><td>{total > 0 ? '100%' : '–'}</td></tr></tfoot>
      </table>
    </figure>
  );
}
