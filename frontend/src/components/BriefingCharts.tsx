import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { BriefingCharts as Charts } from '../services/api';
import { PROVIDERS } from '../providers/registry';
import { HUMAN } from '../utils/worktime';
import { fmtDurationShort, fmtK } from '../utils/format';
import { ChartCard } from '../pages/dashboard/ChartCard';
import { TICK, GRID_STROKE, BAR_MAX, DashTooltip, SeriesLegend, opaque } from '../pages/dashboard/chartTheme';
import { shortDate } from '../pages/dashboard/range';

const H = 3_600_000;
const HEIGHT = 140;
const hoursTick = (ms: number) => (ms >= H ? `${Math.round(ms / H)}h` : ms > 0 ? `${Math.round(ms / 60_000)}m` : '0');

// The dashboard's own colors for the same two entities, so "you" and "agents"
// read the same here as in the Activity chart below the card.
const YOU = opaque(PROVIDERS[HUMAN].color.bright);
const AGENTS = opaque(PROVIDERS.claude.color.base);
const SERIES = [{ id: 'agentMs', label: 'Agents', color: AGENTS }, { id: 'humanMs', label: 'You', color: YOU }];

/**
 * The briefing's "At a glance": the last seven days
 * of your time beside the agents', tokens per day on a chart of its own (a
 * different measure gets its own axis), and the window's time per project.
 * Series come from the briefing row, so an old briefing keeps its charts.
 */
export function BriefingCharts({ charts }: { charts: Charts }) {
  const days = charts.days.map(d => ({ ...d, label: shortDate(d.day) }));
  const anyTime = days.some(d => d.humanMs + d.agentMs > 0);
  const anyTokens = days.some(d => d.tokens > 0);
  const maxProject = Math.max(1, ...charts.projects.map(p => p.humanMs + p.agentMs));
  if (!anyTime && !anyTokens && charts.projects.length === 0) return null;

  return (
    <div className="briefing-charts">
      {anyTime && (
        <ChartCard
          title="Last 7 days"
          subtitle="agents beside you"
          table={{ columns: ['day', 'agents', 'you'], rows: days.map(d => [d.label, fmtDurationShort(d.agentMs), fmtDurationShort(d.humanMs)]) }}
        >
          <ResponsiveContainer width="100%" height={HEIGHT}>
            <BarChart data={days} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap="25%" barGap={2}>
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
              <YAxis tick={TICK} tickLine={false} axisLine={false} width={32} tickFormatter={hoursTick} />
              <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={fmtDurationShort} />} />
              <Bar dataKey="agentMs" name="Agents" fill={AGENTS} maxBarSize={BAR_MAX} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="humanMs" name="You" fill={YOU} maxBarSize={BAR_MAX} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
          <SeriesLegend series={SERIES} />
        </ChartCard>
      )}
      {anyTokens && (
        <ChartCard
          title="Tokens"
          subtitle="per day"
          table={{ columns: ['day', 'tokens'], rows: days.map(d => [d.label, fmtK(Math.round(d.tokens))]) }}
        >
          <ResponsiveContainer width="100%" height={HEIGHT}>
            <BarChart data={days} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barCategoryGap="25%">
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
              <YAxis tick={TICK} tickLine={false} axisLine={false} width={46} tickFormatter={(n: number) => fmtK(Math.round(n))} />
              <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={n => fmtK(Math.round(n))} />} />
              <Bar dataKey="tokens" name="Tokens" fill={AGENTS} maxBarSize={BAR_MAX} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      )}
      {charts.projects.length > 0 && (
        <ChartCard
          title="This window"
          subtitle="time per project"
          table={{ columns: ['project', 'agents', 'you'], rows: charts.projects.map(p => [p.name, fmtDurationShort(p.agentMs), fmtDurationShort(p.humanMs)]) }}
        >
          <div className="briefing-project-bars">
            {charts.projects.map(p => (
              <div className="briefing-project-bar" key={p.projectId}>
                <span className="briefing-project-name" title={p.name}>{p.name}</span>
                <span className="briefing-project-track">
                  <span
                    className="briefing-project-seg"
                    style={{ width: `${(p.agentMs / maxProject) * 100}%`, background: AGENTS }}
                    title={`Agents: ${fmtDurationShort(p.agentMs)}`}
                  />
                  <span
                    className="briefing-project-seg"
                    style={{ width: `${(p.humanMs / maxProject) * 100}%`, background: YOU }}
                    title={`You: ${fmtDurationShort(p.humanMs)}`}
                  />
                </span>
                <span className="briefing-project-value">{fmtDurationShort(p.agentMs + p.humanMs)}</span>
              </div>
            ))}
          </div>
          <SeriesLegend series={SERIES} />
        </ChartCard>
      )}
    </div>
  );
}
