import React from 'react';
import { Link } from 'react-router-dom';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { ContextSeries } from '../../services/api';
import { fmtK } from '../../utils/format';
import { utcHourToLocalLabel } from '../../utils/dates';
import { CTX_COLOR } from '../../utils/worktime';
import { CONTEXT_WARN_TOKENS, CONTEXT_DANGER_TOKENS } from '../../utils/thresholds';
import { projectHref } from './AttentionSection';
import { TICK, DashTooltip, wash } from './chartTheme';
import { RangeKeys, shortDate } from './range';

interface Props { ctx: ContextSeries | null; keys: RangeKeys; stale: boolean }
const CAP = 8;
const PANEL_H = 90;

/**
 * Small multiples: one tiny area per project, same y-scale across panels so a
 * heavy project is visibly heavier. Reference lines mark the shared 500k / 1M
 * thresholds the sidebar badge and the Attention section use.
 */
export function ContextPanels({ ctx, keys, stale }: Props) {
  if (!ctx) return <section className="dash-section"><div className="dash-section-title">Context by project</div><div className="dash-card dash-stale"><div className="dash-placeholder" style={{ height: PANEL_H }} /></div></section>;

  const panels = ctx.projects.map(p => {
    const points = keys.isToday
      ? p.hoursToday.map(h => ({ x: String(h.hour), label: utcHourToLocalLabel(h.hour), v: h.peakTokens }))
      : keys.utc.map(d => ({ x: d, label: shortDate(d), v: p.days.find(x => x.date === d)?.peakTokens ?? 0 }));
    const peak = Math.max(0, ...points.map(pt => pt.v));
    return { p, points, peak };
  }).filter(x => x.peak > 0).sort((a, b) => b.peak - a.peak);
  const shown = panels.slice(0, CAP);
  const yMax = Math.max(CONTEXT_WARN_TOKENS * 1.1, ...shown.map(x => x.peak * 1.1));

  return (
    <section className={`dash-section ${stale ? 'dash-stale' : ''}`}>
      <div className="dash-section-title">
        Context by project <span className="usage-dim">peak tokens, {keys.label}{keys.isToday ? ' · local hours' : ''}</span>
        {panels.length > CAP && <span className="usage-dim">· top {CAP} of {panels.length}</span>}
      </div>
      {shown.length === 0 ? (
        <div className="dash-card"><div className="usage-dim">no context samples in this range</div></div>
      ) : (
        <div className="ctx-grid">
          {shown.map(({ p, points, peak }) => {
            const color = p.color ?? CTX_COLOR;
            return (
              <Link key={p.projectId} className="dash-card ctx-panel" to={projectHref(p.projectId)}>
                <div className="dash-card-head">
                  <span><i className="attn-dot" style={{ background: color, marginRight: 6 }} />{p.name}</span>
                  <span className={`dash-card-value ctx-${peak >= CONTEXT_DANGER_TOKENS ? 'danger' : peak >= CONTEXT_WARN_TOKENS ? 'warn' : 'ok'}`}>{fmtK(peak)}</span>
                </div>
                <ResponsiveContainer width="100%" height={PANEL_H}>
                  <AreaChart data={points} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={30} height={16} />
                    <YAxis hide domain={[0, yMax]} />
                    <ReferenceLine y={CONTEXT_WARN_TOKENS} stroke="var(--warning)" strokeWidth={1} strokeOpacity={0.6} />
                    <ReferenceLine y={CONTEXT_DANGER_TOKENS} stroke="var(--danger)" strokeWidth={1} strokeOpacity={0.6} />
                    <Tooltip cursor={{ stroke: 'var(--border)' }} content={<DashTooltip fmt={fmtK} />} />
                    <Area type="monotone" dataKey="v" name="peak context" stroke={color} strokeWidth={2} fill={wash(color)} isAnimationActive={false}
                      dot={false} activeDot={{ r: 4, stroke: 'var(--bg-surface)', strokeWidth: 2, fill: color }} />
                  </AreaChart>
                </ResponsiveContainer>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
