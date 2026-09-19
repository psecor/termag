import React from 'react';

/**
 * Shared Recharts chrome so every chart on the page reads as one system:
 * recessive hairline grid, muted small ticks, no axis rules, and a tooltip whose
 * value leads and whose series key is a short color stroke. Colors follow the
 * ENTITY (provider / project), never rank — filtering never repaints survivors.
 */

export const TICK = { fill: 'var(--text-muted)', fontSize: 10, fontFamily: 'inherit' } as const;
export const GRID_STROKE = 'var(--border)';
export const SURFACE = 'var(--bg-surface)';
export const BAR_MAX = 24;
export const CHART_HEIGHT = 200; // plot + x-axis band; the card never gets a nested scrollbar

/** `rgba(r, g, b, a)` from the provider registry → opaque `rgb(r, g, b)` for chart fills. */
export function opaque(color: string): string {
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  return m ? `rgb(${m[1]}, ${m[2]}, ${m[3]})` : color;
}

/** Series hue at a wash opacity for area fills. */
export function wash(color: string, alpha = 0.12): string {
  const m = color.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
  const h = color.replace('#', '');
  if (h.length === 6) {
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return color;
}

interface TooltipRow { name?: string; value?: number | string; color?: string; dataKey?: string | number }
interface DashTooltipProps {
  active?: boolean;
  payload?: TooltipRow[];
  label?: string | number;
  fmt: (v: number) => string;
  /** Optional label formatter (e.g. date key → "Sep 18"). */
  fmtLabel?: (l: string | number) => string;
  /** Show a total line when there are ≥2 series. */
  total?: boolean;
}

export function DashTooltip({ active, payload, label, fmt, fmtLabel, total }: DashTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const rows = payload.filter(r => typeof r.value === 'number' && (r.value as number) > 0);
  const sum = rows.reduce((s, r) => s + (r.value as number), 0);
  return (
    <div className="dash-tip" role="tooltip">
      {label !== undefined && <div className="dash-tip-label">{fmtLabel ? fmtLabel(label) : String(label)}</div>}
      {rows.map((r, i) => (
        <div className="dash-tip-row" key={`${r.dataKey ?? r.name ?? i}`}>
          <i className="dash-tip-key" style={{ background: r.color }} />
          <span className="dash-tip-value">{fmt(r.value as number)}</span>
          <span className="dash-tip-name">{r.name}</span>
        </div>
      ))}
      {total && rows.length >= 2 && (
        <div className="dash-tip-row dash-tip-total">
          <i className="dash-tip-key" style={{ background: 'transparent' }} />
          <span className="dash-tip-value">{fmt(sum)}</span>
          <span className="dash-tip-name">total</span>
        </div>
      )}
      {rows.length === 0 && <div className="dash-tip-name">no data</div>}
    </div>
  );
}

/** Legend for ≥2 series — rect swatch for bars/areas, line for lines. */
export function SeriesLegend({ series, mark = 'rect' }: { series: Array<{ id: string; label: string; color: string }>; mark?: 'rect' | 'line' }) {
  if (series.length < 2) return null;
  return (
    <div className="usage-legend" aria-label="legend">
      {series.map(s => (
        <span key={s.id}>
          <i style={{ background: s.color, ...(mark === 'line' ? { height: 2, width: 12, borderRadius: 1 } : {}) }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}
