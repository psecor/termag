import React from 'react';

export interface Kpi {
  id: string;
  label: string;
  value: string;
  /** Signed change vs the prior period; null = no comparison available. */
  deltaPct: number | null;
  /** Whether an increase is good (time, flow) or bad (tokens, context). */
  upIsGood: boolean;
  /** e.g. "vs prior 7 days" / "vs typical day" */
  vs: string;
  note?: string;
}

export function deltaPct(cur: number, prior: number): number | null {
  if (!Number.isFinite(cur) || !Number.isFinite(prior) || prior <= 0) return null;
  return ((cur - prior) / prior) * 100;
}

export function KpiRow({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="dash-kpis">
      {kpis.map(k => {
        const d = k.deltaPct;
        const dir = d == null ? null : d > 0.5 ? 'up' : d < -0.5 ? 'down' : 'flat';
        const tone = dir === null || dir === 'flat' ? '' : (dir === 'up') === k.upIsGood ? 'good' : 'bad';
        return (
          <div className="dash-tile" key={k.id}>
            <div className="dash-tile-label">{k.label}</div>
            <div className="dash-tile-value">{k.value}</div>
            <div className={`dash-tile-delta ${tone}`}>
              {d == null ? (k.note ?? '—') : dir === 'flat' ? `flat ${k.vs}` : `${dir === 'up' ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}% ${k.vs}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}
