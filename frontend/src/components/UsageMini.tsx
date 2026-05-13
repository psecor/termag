import React, { useEffect, useState, useRef } from 'react';
import { usageApi, UsageDayData, UsageResponse, worktimeApi, WorktimeResponse, WorktimeDay, visitsApi, VisitsStats } from '../services/api';
import { PROVIDERS, ProviderConfig } from '../providers/registry';

const SWITCH_COLOR = '#5eead4'; // teal — distinct from agent orange + human yellow

// ── Formatting helpers ──────────────────────────────────────────

function dayTokens(d: UsageDayData): number {
  return d.input + d.output + d.cacheRead + d.cacheCreate;
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function fmtDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function fmtDurationShort(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  const mins = Math.round((ms % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h${mins > 0 ? mins : ''}`;
  return `${mins}m`;
}

// ── Date helpers ────────────────────────────────────────────────

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function utcToday(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Both local and UTC today strings (deduplicated) — covers timezone mismatch with server */
function todayDates(): string[] {
  const lt = localToday();
  const ut = utcToday();
  return lt === ut ? [lt] : [lt, ut];
}

function lastNDays(n: number): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    result.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return result;
}

/** Same as lastNDays but in UTC */
function lastNDaysUTC(n: number): string[] {
  const result: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    result.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }
  return result;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Worktime helpers ────────────────────────────────────────────

type WtDayData = Record<string, WorktimeDay>; // provider → { totalMs, sessions }

/** Sum totalMs across all providers for one day */
function dayMs(dw: WtDayData | undefined): number {
  if (!dw) return 0;
  return Object.values(dw).reduce((s, v) => s + v.totalMs, 0);
}

/** Merge worktime from multiple date strings (handles UTC/local overlap) */
function mergeWtDays(wt: WorktimeResponse, dates: string[]): WtDayData {
  const merged: WtDayData = {};
  for (const dt of dates) {
    const dw = wt.days[dt];
    if (!dw) continue;
    for (const [pid, v] of Object.entries(dw)) {
      if (!merged[pid]) merged[pid] = { totalMs: 0, sessions: 0 };
      merged[pid].totalMs += v.totalMs;
      merged[pid].sessions += v.sessions;
    }
  }
  return merged;
}

/** Providers that have worktime data in the response */
function activeWtProviders(wt: WorktimeResponse): ProviderConfig[] {
  const seen = new Set<string>();
  for (const dw of Object.values(wt.days)) {
    for (const pid of Object.keys(dw)) seen.add(pid);
  }
  return Object.values(PROVIDERS).filter(p => seen.has(p.id));
}

// ── Visual constants ────────────────────────────────────────────

const EMPTY: UsageDayData = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0 };
const THERMO_MAX_MS = 8 * 3_600_000; // 8 hours
const THERMO_MID_MS = 4 * 3_600_000; // 4 hours
const GRAD_MARKS = [1, 2, 3, 4, 5, 6, 7, 8]; // hours

function fillGradient(pct: number, color: { base: string; bright: string }): string {
  if (pct <= 50) return color.base;
  const midPoint = (50 / pct) * 100;
  return `linear-gradient(to top, ${color.base} 0%, ${color.base} ${midPoint}%, ${color.bright} 100%)`;
}

// ── Stacked Horizontal Bar (single day) ────────────────────────

interface WtStackedBarProps {
  data: WtDayData;
  providers: ProviderConfig[];
  maxMs: number;
  height: number;
}

function WtStackedBar({ data, providers, maxMs, height }: WtStackedBarProps) {
  const segments = providers
    .map(p => ({ provider: p, ms: data[p.id]?.totalMs || 0 }))
    .filter(s => s.ms > 0);
  const total = segments.reduce((s, seg) => s + seg.ms, 0);
  if (total === 0) return null;
  const fillPct = Math.min(100, (total / maxMs) * 100);

  return (
    <div className="wt-stacked-bar" style={{ height }}>
      <div className="wt-stacked-bar-track">
        <div className="wt-stacked-bar-fill" style={{ width: `${fillPct}%` }}>
          {segments.map(seg => (
            <div
              key={seg.provider.id}
              className="wt-stacked-bar-seg"
              style={{
                width: `${(seg.ms / total) * 100}%`,
                background: seg.provider.color.base,
              }}
              title={`${seg.provider.displayName}: ${fmtDuration(seg.ms)}`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Working Time Bar Chart ──────────────────────────────────────

interface WtBarChartProps {
  days: string[];
  wt: WorktimeResponse;
  providers: ProviderConfig[];
  height: number;
}

function WtBarChart({ days, wt, providers, height }: WtBarChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const perDay = days.map(d => {
      const dw = wt.days[d] || {};
      const byProvider: Record<string, number> = {};
      let total = 0;
      for (const p of providers) {
        const ms = dw[p.id]?.totalMs || 0;
        byProvider[p.id] = ms;
        total += ms;
      }
      return { byProvider, total };
    });

    const maxMs = Math.max(1, ...perDay.map(t => t.total));
    const gap = 2;
    const barW = Math.max(2, (w - gap * (days.length - 1)) / days.length);

    ctx.clearRect(0, 0, w, h);

    for (let i = 0; i < days.length; i++) {
      const x = i * (barW + gap);
      const t = perDay[i];
      const barH = (t.total / maxMs) * (h - 1);

      let y = h;
      for (let j = providers.length - 1; j >= 0; j--) {
        const p = providers[j];
        const val = t.byProvider[p.id] || 0;
        if (val <= 0) continue;
        const segH = t.total > 0 ? (val / t.total) * barH : 0;
        y -= segH;
        ctx.fillStyle = p.color.base;
        ctx.fillRect(x, y, barW, segH);
      }
    }
  }, [days, wt, providers]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height, display: 'block' }}
    />
  );
}

// ── Token Bar Chart ─────────────────────────────────────────────

interface TokenBarChartProps {
  days: string[];
  providerData: Record<string, Record<string, UsageDayData>>;
  providers: ProviderConfig[];
  height: number;
}

function TokenBarChart({ days, providerData, providers, height }: TokenBarChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const perDay = days.map(d => {
      const byProvider: Record<string, number> = {};
      let total = 0;
      for (const p of providers) {
        const tok = dayTokens((providerData[p.id] || {})[d] || EMPTY);
        byProvider[p.id] = tok;
        total += tok;
      }
      return { byProvider, total };
    });

    const maxTok = Math.max(1, ...perDay.map(t => t.total));
    const gap = 2;
    const barW = Math.max(2, (w - gap * (days.length - 1)) / days.length);

    ctx.clearRect(0, 0, w, h);

    for (let i = 0; i < days.length; i++) {
      const x = i * (barW + gap);
      const t = perDay[i];
      const barH = (t.total / maxTok) * (h - 1);

      let y = h;
      for (let j = providers.length - 1; j >= 0; j--) {
        const p = providers[j];
        const val = t.byProvider[p.id] || 0;
        if (val <= 0) continue;
        const segH = t.total > 0 ? (val / t.total) * barH : 0;
        y -= segH;
        ctx.fillStyle = p.color.base;
        ctx.fillRect(x, y, barW, segH);
      }
    }
  }, [days, providerData, providers]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height, display: 'block' }}
    />
  );
}

// ── Plain Count Bar Chart (single colour, unsegmented) ─────────

interface CountBarChartProps {
  values: number[];
  height: number;
  color: string;
}

function CountBarChart({ values, height, color }: CountBarChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const max = Math.max(1, ...values);
    const gap = 2;
    const barW = Math.max(2, (w - gap * (values.length - 1)) / values.length);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color;
    for (let i = 0; i < values.length; i++) {
      const x = i * (barW + gap);
      const barH = (values[i] / max) * (h - 1);
      const y = h - barH;
      ctx.fillRect(x, y, barW, barH);
    }
  }, [values, color]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height, display: 'block' }}
    />
  );
}

// ── Thermometer Tube ────────────────────────────────────────────

interface ThermoTubeProps {
  ms: number;
  color: { base: string; bright: string };
  label: string;
}

function ThermoTube({ ms, color, label }: ThermoTubeProps) {
  const pct = THERMO_MAX_MS > 0 ? (ms / THERMO_MAX_MS) * 100 : 0;
  const clampedPct = Math.min(100, pct);
  return (
    <div className="usage-thermo-tube">
      <div className="usage-thermo-fill" style={{
        height: `${clampedPct}%`,
        background: fillGradient(pct, color),
      }} />
      <div className="usage-thermo-tube-label">{label}</div>
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────────

export function UsageMini() {
  const [tokenResponse, setTokenResponse] = useState<UsageResponse | null>(null);
  const [worktime, setWorktime] = useState<WorktimeResponse | null>(null);
  const [visits, setVisits] = useState<VisitsStats | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const load = () => {
      usageApi.get()
        .then(r => setTokenResponse(r))
        .catch(e => {
          console.warn('[UsageMini] usage fetch failed:', e?.response?.status, e?.message);
          if (!retryTimer) {
            retryTimer = setTimeout(() => { retryTimer = null; load(); }, 15_000);
          }
        });
      worktimeApi.get(30)
        .then(r => setWorktime(r))
        .catch(() => {});
      visitsApi.stats(30)
        .then(r => setVisits(r))
        .catch(() => {});
    };
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => { clearInterval(interval); if (retryTimer) clearTimeout(retryTimer); };
  }, []);

  // Escape closes overlay
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpanded(false);
        const agentPane = document.querySelector<HTMLElement>('#terminal-agent .xterm-helper-textarea');
        if (agentPane) agentPane.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  // Need at least worktime to render the thermometer
  if (!worktime) return null;

  const today = localToday();
  const tDates = todayDates();
  const allWtProviders = activeWtProviders(worktime);
  const agentProviders = allWtProviders.filter(p => p.id !== 'human');
  const humanConfig = PROVIDERS['human'];

  // Today's working time (merged across local/UTC date)
  const todayWt = mergeWtDays(worktime, tDates);
  const todayAgentWt: WtDayData = {};
  const todayHumanMs = todayWt['human']?.totalMs || 0;
  for (const [pid, v] of Object.entries(todayWt)) {
    if (pid !== 'human') todayAgentWt[pid] = v;
  }
  const todayAgentMs = Object.values(todayAgentWt).reduce((s, v) => s + v.totalMs, 0);

  // Trailing 14-day p50 working time (use UTC days since server stores UTC)
  const trailingUTC = lastNDaysUTC(15).slice(0, 14);
  const wtP50 = median(trailingUTC.map(d => dayMs(worktime.days[d])));

  // Per-provider ms for tube fill (agents only)
  const wtMsByProvider: Record<string, number> = {};
  for (const p of agentProviders) {
    wtMsByProvider[p.id] = todayWt[p.id]?.totalMs || 0;
  }

  // Working time over longer periods (agents only)
  const allWtDates = Object.keys(worktime.days);
  const weekUTC = lastNDaysUTC(7);
  const monthUTC = lastNDaysUTC(30);
  const weekAgentMs = weekUTC.reduce((s, d) => {
    const dw = worktime.days[d] || {};
    return s + Object.entries(dw).filter(([k]) => k !== 'human').reduce((a, [, v]) => a + v.totalMs, 0);
  }, 0);
  const monthAgentMs = monthUTC.reduce((s, d) => {
    const dw = worktime.days[d] || {};
    return s + Object.entries(dw).filter(([k]) => k !== 'human').reduce((a, [, v]) => a + v.totalMs, 0);
  }, 0);
  const weekHumanMs = weekUTC.reduce((s, d) => (worktime.days[d]?.['human']?.totalMs || 0) + s, 0);
  const monthHumanMs = monthUTC.reduce((s, d) => (worktime.days[d]?.['human']?.totalMs || 0) + s, 0);

  // Token data (secondary, for overlay detail)
  const tokenData = tokenResponse?.days ?? {};
  const providerTokenData = tokenResponse?.providers ?? {};
  const tokenProviders = Object.values(PROVIDERS).filter(p => {
    const data = providerTokenData[p.id];
    return data && Object.keys(data).length > 0;
  });
  const todayTok = dayTokens(tokenData[today] || EMPTY);
  const week = lastNDays(7);
  const month = lastNDays(30);
  const weekTok = week.reduce((sum, d) => sum + dayTokens(tokenData[d] || EMPTY), 0);
  const monthTok = month.reduce((sum, d) => sum + dayTokens(tokenData[d] || EMPTY), 0);

  return (
    <>
      {/* Thermometer — working time */}
      <div className="usage-thermo" onClick={() => setExpanded(!expanded)}>
        <div className="usage-thermo-header">
          <span className="usage-thermo-pct">{todayAgentMs > 0 ? `${Math.round((todayAgentMs / THERMO_MID_MS) * 100)}%` : '--'}</span>
          <span className="usage-thermo-pct usage-thermo-pct-human">{todayHumanMs > 0 ? `${Math.round((todayHumanMs / THERMO_MID_MS) * 100)}%` : '--'}</span>
        </div>
        <div className="usage-thermo-tubes">
          <div className="usage-thermo-tube usage-thermo-tube-stacked">
            {agentProviders.map(p => {
              const ms = wtMsByProvider[p.id] || 0;
              if (ms <= 0) return null;
              const segPct = (ms / THERMO_MAX_MS) * 100;
              return (
                <div
                  key={p.id}
                  className="usage-thermo-stack-seg"
                  style={{ height: `${Math.min(segPct, 100)}%`, background: p.color.base }}
                  title={`${p.displayName}: ${fmtDurationShort(ms)}`}
                />
              );
            })}
          </div>
          <div className="usage-thermo-tube usage-thermo-tube-stacked">
            {todayHumanMs > 0 && (
              <div
                className="usage-thermo-stack-seg"
                style={{
                  height: `${Math.min((todayHumanMs / THERMO_MAX_MS) * 100, 100)}%`,
                  background: humanConfig.color.base,
                }}
                title={`You: ${fmtDurationShort(todayHumanMs)}`}
              />
            )}
          </div>
          <div className="usage-thermo-marks">
            {GRAD_MARKS.map(mark => (
              <div
                key={mark}
                className={`usage-thermo-mark ${mark === 4 ? 'usage-thermo-mark-100' : ''}`}
                style={{ bottom: `${(mark / 8) * 100}%` }}
              >
                <span>{mark}h</span>
              </div>
            ))}
          </div>
        </div>
        <div className="usage-thermo-footer">
          <span className="usage-thermo-cost">{todayAgentMs > 0 ? fmtDurationShort(todayAgentMs) : '--'}</span>
          <span className="usage-thermo-cost usage-thermo-cost-human">{todayHumanMs > 0 ? fmtDurationShort(todayHumanMs) : '--'}</span>
        </div>
      </div>

      {/* Expanded overlay */}
      {expanded && (
        <div className="usage-overlay-backdrop" onClick={() => setExpanded(false)}>
          <div className="usage-overlay" onClick={e => e.stopPropagation()}>
            <div className="usage-overlay-header">
              <span>Activity</span>
              <button className="usage-overlay-close" onClick={() => setExpanded(false)}>×</button>
            </div>

            {/* Agent working time — 30 day chart */}
            {allWtDates.length > 0 && (
              <div className="usage-overlay-section">
                <div className="usage-overlay-section-header">
                  <span>Agents — 30d</span>
                  <span>{fmtDuration(monthAgentMs)}</span>
                  <span className="usage-dim">avg {fmtDuration(Math.round(monthAgentMs / 30))}/d</span>
                </div>
                <WtBarChart days={monthUTC} wt={worktime} providers={agentProviders} height={80} />
              </div>
            )}

            {/* Agent working time — 7 day chart */}
            {allWtDates.length > 0 && (
              <div className="usage-overlay-section">
                <div className="usage-overlay-section-header">
                  <span>Agents — 7d</span>
                  <span>{fmtDuration(weekAgentMs)}</span>
                  <span className="usage-dim">avg {fmtDuration(Math.round(weekAgentMs / 7))}/d</span>
                </div>
                <WtBarChart days={weekUTC} wt={worktime} providers={agentProviders} height={60} />
              </div>
            )}

            {/* Agent today breakdown */}
            <div className="usage-overlay-section">
              <div className="usage-overlay-section-header">
                <span>Agents — today</span>
                <span>{fmtDuration(todayAgentMs)}</span>
                <span className={`usage-overlay-pct ${todayAgentMs > THERMO_MID_MS ? 'usage-hot' : ''}`}>
                  {todayAgentMs > 0 ? `${Math.round((todayAgentMs / THERMO_MAX_MS) * 100)}% of 8h` : ''}
                </span>
              </div>
              <WtStackedBar data={todayAgentWt} providers={agentProviders} maxMs={THERMO_MAX_MS} height={16} />
              <div className="usage-overlay-tokens">
                {Object.entries(todayAgentWt).map(([pid, v]) => {
                  const config = PROVIDERS[pid];
                  return (
                    <div key={pid} className="usage-overlay-token-row">
                      <span className="usage-overlay-token-label" style={{ color: config?.color.bright ?? '#888' }}>
                        {config?.displayName ?? pid}
                      </span>
                      <span>{fmtDuration(v.totalMs)}</span>
                      <span className="usage-dim">{v.sessions} ses</span>
                    </div>
                  );
                })}
                {Object.keys(todayAgentWt).length === 0 && (
                  <div className="usage-dim">No agent working time today</div>
                )}
              </div>
            </div>

            {/* Your activity — 30 day chart */}
            {monthHumanMs > 0 && (
              <div className="usage-overlay-section">
                <div className="usage-overlay-section-header">
                  <span>You — 30d</span>
                  <span>{fmtDuration(monthHumanMs)}</span>
                  <span className="usage-dim">avg {fmtDuration(Math.round(monthHumanMs / 30))}/d</span>
                </div>
                <WtBarChart days={monthUTC} wt={worktime} providers={[humanConfig]} height={80} />
              </div>
            )}

            {/* Your activity — 7 day chart */}
            {weekHumanMs > 0 && (
              <div className="usage-overlay-section">
                <div className="usage-overlay-section-header">
                  <span>You — 7d</span>
                  <span>{fmtDuration(weekHumanMs)}</span>
                  <span className="usage-dim">avg {fmtDuration(Math.round(weekHumanMs / 7))}/d</span>
                </div>
                <WtBarChart days={weekUTC} wt={worktime} providers={[humanConfig]} height={60} />
              </div>
            )}

            {/* Your activity — today */}
            <div className="usage-overlay-section">
              <div className="usage-overlay-section-header">
                <span>You — today</span>
                <span>{todayHumanMs > 0 ? fmtDuration(todayHumanMs) : '--'}</span>
              </div>
              {todayHumanMs > 0 && (
                <WtStackedBar data={{ human: todayWt['human'] }} providers={[humanConfig]} maxMs={THERMO_MAX_MS} height={16} />
              )}
              <div className="usage-overlay-tokens">
                {todayHumanMs > 0 ? (
                  <div className="usage-overlay-token-row">
                    <span className="usage-overlay-token-label" style={{ color: humanConfig.color.bright }}>Active time</span>
                    <span>{fmtDuration(todayHumanMs)}</span>
                    <span className="usage-dim">{todayWt['human']?.sessions || 0} ses</span>
                  </div>
                ) : (
                  <div className="usage-dim">No activity recorded yet today</div>
                )}
              </div>
            </div>

            {/* Project switches — 30d */}
            {visits && visits.totalSwitches > 0 && (
              <div className="usage-overlay-section">
                <div className="usage-overlay-section-header">
                  <span>Project switches — 30d</span>
                  <span>{visits.totalSwitches}</span>
                  <span className="usage-dim">avg {(visits.totalSwitches / 30).toFixed(1)}/d</span>
                </div>
                <CountBarChart
                  values={visits.days.map(d => d.switches)}
                  height={60}
                  color={SWITCH_COLOR}
                />
              </div>
            )}

            {/* Project switches — today */}
            {visits && (
              <div className="usage-overlay-section">
                <div className="usage-overlay-section-header">
                  <span>Project switches — today</span>
                  <span>{visits.todaySwitches}</span>
                  <span className="usage-dim">
                    {visits.meanDwellMs > 0
                      ? `avg dwell ${fmtDuration(visits.meanDwellMs)}`
                      : '--'}
                  </span>
                </div>
                {visits.todaySwitches > 0 && (
                  <CountBarChart
                    values={visits.perHourToday}
                    height={40}
                    color={SWITCH_COLOR}
                  />
                )}
                <div className="usage-overlay-tokens">
                  {visits.stdevInterSwitchMs > 0 && (
                    <div className="usage-overlay-token-row">
                      <span className="usage-overlay-token-label" style={{ color: SWITCH_COLOR }}>
                        σ between switches
                      </span>
                      <span>{fmtDuration(visits.stdevInterSwitchMs)}</span>
                    </div>
                  )}
                  {visits.todaySwitches === 0 && (
                    <div className="usage-dim">No project switches yet today</div>
                  )}
                </div>
              </div>
            )}

            {/* Token usage — secondary detail with charts */}
            {tokenProviders.length > 0 && (
              <>
                <div className="usage-overlay-section">
                  <div className="usage-overlay-section-header">
                    <span>Tokens — 30d</span>
                    <span>{fmtK(monthTok)}</span>
                    <span className="usage-dim">avg {fmtK(Math.round(monthTok / 30))}/d</span>
                  </div>
                  <TokenBarChart days={month} providerData={providerTokenData} providers={tokenProviders} height={60} />
                </div>

                <div className="usage-overlay-section">
                  <div className="usage-overlay-section-header">
                    <span>Tokens — today</span>
                    <span>{fmtK(todayTok)}</span>
                    <span className="usage-dim">{fmtK(weekTok)} 7d</span>
                  </div>
                  <div className="usage-overlay-tokens">
                    {tokenProviders.map(p => {
                      const tok = dayTokens((providerTokenData[p.id] || {})[today] || EMPTY);
                      return (
                        <div key={p.id} className="usage-overlay-token-row">
                          <span className="usage-overlay-token-label" style={{ color: p.color.bright }}>{p.displayName}</span>
                          <span>{fmtK(tok)}</span>
                          {p.usagePrecision === 'estimated' && (
                            <span className="usage-dim" title="Estimated from context window %">(est)</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}

            <div className="usage-overlay-footer">
              {wtP50 > 0 && <span className="usage-dim">p50 (14d): {fmtDuration(wtP50)} working time</span>}
            </div>

            <div className="usage-legend">
              {allWtProviders.map((p: ProviderConfig) => (
                <span key={p.id}><i style={{ background: p.color.base }} />{p.displayName}</span>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
