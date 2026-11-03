// A small trend line with no axes, to sit beside a Stat or in a row of text.
// Hand-rolled SVG: LaunchPad has no chart, and recharts is too heavy for a
// mark this small that one spec may draw dozens of times. The marks follow
// termag's charts: a 2px line, the latest point an 8px dot in a 2px ring.
import React, { useState } from 'react';
import { z } from 'zod';
import { defineGenUiComponent } from './index';
import './Sparkline.css';

/** The drawing's size and inset, px: room for the end dot and its ring. */
const W = 120;
const H = 32;
const PAD = 6;

const props = z.object({
  label: z.string().min(1).max(200),
  values: z.array(z.number().finite()).min(2).max(100),
  tone: z.enum(['default', 'success', 'warning', 'danger']).optional(),
  unit: z.string().max(12).optional(),
  showLast: z.boolean().optional(),
});

const CURRENCY = new Set(['$', '€', '£', '¥']);
/** A value as shown: grouped digits and the unit ("$" before, "%" close after, a word after a space). */
export function formatValue(v: number, unit?: string): string {
  const n = v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (!unit) return n;
  if (CURRENCY.has(unit)) return v < 0 ? `−${unit}${n.replace(/^-/, '')}` : `${unit}${n}`;
  return unit === '%' ? `${n}%` : `${n} ${unit}`;
}

/** Each value's point in the drawing, oldest at the left; a flat series sits in the middle. */
export function sparkPoints(values: number[]): Array<[number, number]> {
  const min = Math.min(...values);
  const span = Math.max(...values) - min;
  const step = (W - 2 * PAD) / (values.length - 1);
  return values.map((v, i) => [PAD + i * step, span === 0 ? H / 2 : PAD + (1 - (v - min) / span) * (H - 2 * PAD)]);
}

/** What a screen reader hears for the line: its span, low and high. */
export function sparkSummary(label: string, values: number[], unit?: string): string {
  const f = (v: number) => formatValue(v, unit);
  return `${label}: ${values.length} values, from ${f(values[0])} to ${f(values[values.length - 1])}, low ${f(Math.min(...values))}, high ${f(Math.max(...values))}`;
}

function Sparkline({ label, values, tone = 'default', unit, showLast }: z.infer<typeof props>) {
  const [hover, setHover] = useState<number | null>(null);
  const points = sparkPoints(values);
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join('');
  const last = points[points.length - 1];
  // The point nearest the pointer's x, so the reader aims at a moment, never at a 2px line.
  const track = (e: React.PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / (box.width || W)) * W;
    setHover(Math.max(0, Math.min(values.length - 1, Math.round(((x - PAD) / (W - 2 * PAD)) * (values.length - 1)))));
  };
  const at = hover == null ? null : points[hover];
  return (
    <span className="genui-sparkline" data-tone={tone} role="img" aria-label={sparkSummary(label, values, unit)}>
      <span className="genui-sparkline-plot">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} onPointerMove={track} onPointerLeave={() => setHover(null)}>
          <path className="genui-sparkline-line" d={d} />
          <circle className="genui-sparkline-end" cx={last[0]} cy={last[1]} r={5} />
          {at && hover !== values.length - 1 && <circle className="genui-sparkline-hover" cx={at[0]} cy={at[1]} r={5} />}
        </svg>
        {at && hover != null && (
          <span className="dash-tip genui-sparkline-tip" style={{ left: at[0] }}>
            <span className="dash-tip-value">{formatValue(values[hover], unit)}</span>
          </span>
        )}
      </span>
      {showLast && <span className="genui-sparkline-last">{formatValue(values[values.length - 1], unit)}</span>}
    </span>
  );
}

export default defineGenUiComponent({
  name: 'Sparkline',
  props,
  description: 'A small trend line with no axes, oldest value first, for beside a Stat or in a horizontal Stack (the last 12 days of p95 latency, deploys per week); use a Chart when the reader needs axes or several series. values is 2 to 100 numbers; tone colours the line (success, warning, danger) when the trend is good or bad news; showLast prints the latest value after it, with unit ("ms", "%", "$"). label says what it shows, for screen readers.',
  Component: ({ props: p }) => <Sparkline {...p} />,
});
