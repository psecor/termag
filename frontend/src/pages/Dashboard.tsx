import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDashboardData } from './dashboard/useDashboardData';
import { buildAttentionItems, liveSummary } from './dashboard/triage';
import { AttentionSection } from './dashboard/AttentionSection';
import { RangePicker } from './dashboard/RangePicker';
import { Range, rangeKeys } from './dashboard/range';
import { KpiRow, Kpi, deltaPct } from './dashboard/KpiRow';
import { WorktimeCharts } from './dashboard/WorktimeCharts';
import { TokensChart } from './dashboard/TokensChart';
import { ProjectBreakdown } from './dashboard/ProjectBreakdown';
import { ContextPanels } from './dashboard/ContextPanels';
import { RhythmCharts } from './dashboard/RhythmCharts';
import { dayTokens, fmtDurationShort, fmtK, fmtAge, EMPTY_USAGE_DAY } from '../utils/format';
import { median, previousNDaysUTC, todayDates, utcToday } from '../utils/dates';
import { HUMAN, mergeWtDays, agentDayMs } from '../utils/worktime';
import { TRAILING_MEDIAN_DAYS } from '../utils/thresholds';

const RANGE_KEY = 'termag:dashboardRange';

function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

/**
 * The personal dashboard. Mounted as its own route (no ProjectProvider / MainLayout)
 * so it opens no status WebSocket, no terminals, and — importantly — sends no human
 * heartbeat: time spent reading the dashboard must not count as working time.
 */
export default function Dashboard() {
  const data = useDashboardData();
  const now = useNow(15_000);
  const [range, setRange] = useState<Range>(() => (localStorage.getItem(RANGE_KEY) as Range) || '7d');
  useEffect(() => { localStorage.setItem(RANGE_KEY, range); }, [range]);
  const keys = useMemo(() => rangeKeys(range), [range]);

  // Triage is always "now", independent of the range picker.
  const items = useMemo(() => buildAttentionItems({
    sessions: data.sessions.data,
    projects: data.projects.data,
    usage: data.usage.data,
    usageUnavailable: data.usageUnavailable,
    worktimeByProject: data.worktimeByProject.data?.rows ?? null,
    todayKeys: todayDates(),
    todayUTC: utcToday(),
    baselineUTC: previousNDaysUTC(TRAILING_MEDIAN_DAYS, 1),
  }, now), [data.sessions.data, data.projects.data, data.usage.data, data.usageUnavailable, data.worktimeByProject.data, now]);
  const summary = useMemo(() => liveSummary(data.sessions.data), [data.sessions.data]);

  // KPI tiles for the selected range, with a delta vs the prior period
  // (Today compares against the median of the trailing 14 UTC days).
  const kpis = useMemo<Kpi[]>(() => {
    const wt = data.worktime.data;
    const usage = data.usage.data;
    const visits = data.visits.data;
    const warp = data.warp.data;
    const ctx = data.ctx.data;
    const vs = keys.isToday ? 'vs typical day' : `vs prior ${keys.utc.length} days`;
    const priorOf = (perDay: (d: string) => number, priorKeys: string[]) => {
      if (keys.isToday) {
        const vals = priorKeys.map(perDay).filter(v => v > 0);
        return vals.length >= 3 ? median(vals) : NaN;
      }
      return priorKeys.reduce((s, d) => s + perDay(d), 0);
    };
    const out: Kpi[] = [];

    const agentMs = wt ? Object.entries(mergeWtDays(wt, keys.worktime)).filter(([k]) => k !== HUMAN).reduce((s, [, v]) => s + v.totalMs, 0) : NaN;
    const agentPrior = wt ? priorOf(d => agentDayMs(wt.days[d]), keys.priorWorktime) : NaN;
    out.push({ id: 'agent', label: 'Agent time', value: wt ? fmtDurationShort(agentMs) : '…', deltaPct: deltaPct(agentMs, agentPrior), upIsGood: true, vs });

    const humanMs = wt ? mergeWtDays(wt, keys.worktime)[HUMAN]?.totalMs ?? 0 : NaN;
    const humanPrior = wt ? priorOf(d => wt.days[d]?.[HUMAN]?.totalMs ?? 0, keys.priorWorktime) : NaN;
    out.push({ id: 'human', label: 'Your time', value: wt ? fmtDurationShort(humanMs) : '…', deltaPct: deltaPct(humanMs, humanPrior), upIsGood: true, vs });

    const tok = usage ? keys.utc.reduce((s, d) => s + dayTokens(usage.days[d] ?? EMPTY_USAGE_DAY), 0) : NaN;
    const tokPrior = usage ? priorOf(d => dayTokens(usage.days[d] ?? EMPTY_USAGE_DAY), keys.priorUtc) : NaN;
    out.push({
      id: 'tokens', label: 'Tokens', value: usage ? fmtK(tok) : data.usageUnavailable ? 'unavailable' : '…',
      deltaPct: deltaPct(tok, tokPrior), upIsGood: false, vs, note: data.usageUnavailable ? 'agent offline' : undefined,
    });

    const sw = visits ? (keys.isToday ? visits.todaySwitches : visits.days.filter(d => keys.utc.includes(d.date)).reduce((s, d) => s + d.switches, 0)) : NaN;
    const swPrior = visits ? priorOf(d => visits.days.find(x => x.date === d)?.switches ?? 0, keys.priorUtc) : NaN;
    out.push({ id: 'switches', label: 'Project switches', value: visits ? String(sw) : '…', deltaPct: deltaPct(sw, swPrior), upIsGood: false, vs });

    const flowMin = warp ? warp.days.filter(d => keys.utc.includes(d.date)).reduce((s, d) => s + d.activeMinutes, 0) : NaN;
    const flowPrior = warp ? priorOf(d => warp.days.find(x => x.date === d)?.activeMinutes ?? 0, keys.priorUtc) : NaN;
    out.push({ id: 'flow', label: 'Time in flow', value: warp ? fmtDurationShort(flowMin * 60_000) : '…', deltaPct: deltaPct(flowMin, flowPrior), upIsGood: true, vs });

    let peak = 0, peakName = '';
    if (ctx) for (const p of ctx.projects) {
      const v = keys.isToday
        ? Math.max(0, ...p.hoursToday.map(h => h.peakTokens))
        : Math.max(0, ...p.days.filter(d => keys.utc.includes(d.date)).map(d => d.peakTokens));
      if (v > peak) { peak = v; peakName = p.name; }
    }
    out.push({ id: 'ctx', label: 'Peak context', value: ctx ? (peak > 0 ? fmtK(peak) : '—') : '…', deltaPct: null, upIsGood: false, vs, note: peakName || 'no samples' });
    return out;
  }, [data.worktime.data, data.usage.data, data.usageUnavailable, data.visits.data, data.warp.data, data.ctx.data, keys]);

  const updated = data.checkedAt ? `updated ${fmtAge(now - data.checkedAt)} ago` : 'loading…';

  return (
    <div className="dash-root">
      <div className="dash-page">
        <header className="dash-header">
          <h1>Dashboard</h1>
          <Link to="/">← workspace</Link>
          <span className="dash-updated">{updated}</span>
        </header>

        <AttentionSection items={items} summary={summary} loaded={data.sessions.data !== null} checkedAt={data.checkedAt} now={now} />

        <RangePicker value={range} onChange={setRange} />

        <KpiRow kpis={kpis} />

        {/* Per-project views first — they're the ones that answer "where did it go". */}
        <ProjectBreakdown
          rows={data.worktimeByProject.data?.rows ?? null}
          sessions={data.sessions.data}
          projects={data.projects.data}
          ctx={data.ctx.data}
          keys={keys}
          now={now}
          stale={data.worktimeByProject.loading}
        />

        <ContextPanels ctx={data.ctx.data} keys={keys} stale={data.ctx.loading} />

        <WorktimeCharts wt={data.worktime.data} keys={keys} stale={data.worktime.loading} />

        <TokensChart usage={data.usage.data} unavailable={data.usageUnavailable} keys={keys} stale={data.usage.loading} />

        <RhythmCharts visits={data.visits.data} warp={data.warp.data} keys={keys} stale={data.visits.loading || data.warp.loading} />

        <footer className="dash-footer usage-dim">
          Times are banked when a session stops working, so in-flight work shows up a little late. Token dates are UTC.
        </footer>
      </div>
    </div>
  );
}
