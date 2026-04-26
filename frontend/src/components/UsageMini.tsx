import React, { useEffect, useState, useRef } from 'react';
import { usageApi, UsageDayData, UsageResponse } from '../services/api';

function dayTokens(d: UsageDayData): number {
  return d.input + d.output + d.cacheRead + d.cacheCreate;
}

function fmtK(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const EMPTY: UsageDayData = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, calls: 0 };

// Gradation marks for the thermometer (bottom to top)
const GRAD_MARKS = [25, 50, 75, 100, 125, 150, 200];

// Provider colors
const CLAUDE_COLOR = { base: 'rgba(31, 111, 235, 0.6)', bright: 'rgba(88, 166, 255, 0.9)' };
const CODEX_COLOR = { base: 'rgba(35, 170, 100, 0.6)', bright: 'rgba(72, 220, 140, 0.9)' };

function fillGradient(pct: number, color: { base: string; bright: string }): string {
  const fillPct = Math.min(200, pct);
  const midPoint = (100 / fillPct) * 100;
  if (fillPct <= 100) return color.base;
  return `linear-gradient(to top, ${color.base} 0%, ${color.base} ${midPoint}%, ${color.bright} 100%)`;
}

// ── Bar Chart (used in expanded overlay) ─────────────────────

interface BarChartProps {
  days: string[];
  claudeData: Record<string, UsageDayData>;
  codexData: Record<string, UsageDayData>;
  height: number;
}

function BarChart({ days, claudeData, codexData, height }: BarChartProps) {
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

    const perDay = days.map(d => ({
      claude: dayTokens(claudeData[d] || EMPTY),
      codex: dayTokens(codexData[d] || EMPTY),
    }));

    const maxTok = Math.max(1, ...perDay.map(t => t.claude + t.codex));
    const gap = 2;
    const barW = Math.max(2, (w - gap * (days.length - 1)) / days.length);

    ctx.clearRect(0, 0, w, h);

    for (let i = 0; i < days.length; i++) {
      const x = i * (barW + gap);
      const t = perDay[i];
      const total = t.claude + t.codex;
      const barH = (total / maxTok) * (h - 1);

      let y = h;
      // Codex on bottom (green), Claude on top (blue)
      const segments = [
        { val: t.codex, color: CODEX_COLOR.base },
        { val: t.claude, color: CLAUDE_COLOR.base },
      ];

      for (const seg of segments) {
        if (seg.val <= 0) continue;
        const segH = total > 0 ? (seg.val / total) * barH : 0;
        y -= segH;
        ctx.fillStyle = seg.color;
        ctx.fillRect(x, y, barW, segH);
      }
    }
  }, [days, claudeData, codexData]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height, display: 'block' }}
    />
  );
}

// ── Thermometer Tube ─────────────────────────────────────────

interface ThermoTubeProps {
  pct: number;
  color: { base: string; bright: string };
  label: string;
}

function ThermoTube({ pct, color, label }: ThermoTubeProps) {
  const fillPct = Math.min(200, pct);
  return (
    <div className="usage-thermo-tube">
      <div className="usage-thermo-fill" style={{
        height: `${(fillPct / 200) * 100}%`,
        background: fillGradient(pct, color),
      }} />
      <div className="usage-thermo-tube-label">{label}</div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────

export function UsageMini() {
  const [response, setResponse] = useState<UsageResponse | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const load = () => usageApi.get()
      .then(r => {
        console.log('[UsageMini] loaded', Object.keys(r.days || {}).length, 'days');
        setResponse(r);
      })
      .catch(e => {
        console.warn('[UsageMini] fetch failed:', e?.response?.status, e?.message);
        // Retry sooner if we have no data yet (agent might not be connected)
        if (!retryTimer) {
          retryTimer = setTimeout(() => { retryTimer = null; load(); }, 15_000);
        }
      });
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => { clearInterval(interval); if (retryTimer) clearTimeout(retryTimer); };
  }, []);

  // Escape closes overlay and refocuses agent terminal
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

  if (!response) return null;

  const data = response.days;
  const claudeData = response.providers?.claude || {};
  const codexData = response.providers?.codex || {};

  const today = todayStr();
  const month = lastNDays(30);
  const week = lastNDays(7);

  const todayData = data[today] || EMPTY;
  const todayTok = dayTokens(todayData);
  const todayClaudeTok = dayTokens(claudeData[today] || EMPTY);
  const todayCodexTok = dayTokens(codexData[today] || EMPTY);

  // Trailing 14-day p50 (excluding today) — shared baseline for both tubes
  const trailingDays = lastNDays(15).slice(0, 14);
  const combinedP50 = median(trailingDays.map(d => dayTokens(data[d] || EMPTY)));

  // Both tubes use the same combined p50 so they're directly comparable
  const claudePct = combinedP50 > 0 ? Math.round((todayClaudeTok / combinedP50) * 100) : 0;
  const codexPct = combinedP50 > 0 ? Math.round((todayCodexTok / combinedP50) * 100) : 0;
  const combinedPct = combinedP50 > 0 ? Math.round((todayTok / combinedP50) * 100) : 0;

  const weekTok = week.reduce((sum, d) => sum + dayTokens(data[d] || EMPTY), 0);
  const monthTok = month.reduce((sum, d) => sum + dayTokens(data[d] || EMPTY), 0);

  const hasCodex = Object.keys(codexData).length > 0;

  return (
    <>
      {/* Thermometer gauges — always visible */}
      <div className="usage-thermo" onClick={() => setExpanded(!expanded)}>
        <div className="usage-thermo-pct">{combinedPct}%</div>
        <div className="usage-thermo-tubes">
          <ThermoTube pct={claudePct} color={CLAUDE_COLOR} label="CL" />
          {hasCodex && <ThermoTube pct={codexPct} color={CODEX_COLOR} label="CX" />}
          {/* Shared grad marks overlay */}
          <div className="usage-thermo-marks">
            {GRAD_MARKS.map(mark => (
              <div
                key={mark}
                className={`usage-thermo-mark ${mark === 100 ? 'usage-thermo-mark-100' : ''}`}
                style={{ bottom: `${(mark / 200) * 100}%` }}
              >
                <span>{mark}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="usage-thermo-cost">{fmtK(todayTok)}</div>
      </div>

      {/* Expanded overlay */}
      {expanded && (
        <div className="usage-overlay-backdrop" onClick={() => setExpanded(false)}>
          <div className="usage-overlay" onClick={e => e.stopPropagation()}>
            <div className="usage-overlay-header">
              <span>Usage</span>
              <button className="usage-overlay-close" onClick={() => setExpanded(false)}>×</button>
            </div>

            <div className="usage-overlay-section">
              <div className="usage-overlay-section-header">
                <span>30 days</span>
                <span>{fmtK(monthTok)} tokens</span>
                <span className="usage-dim">avg {fmtK(Math.round(monthTok / 30))}/d</span>
              </div>
              <BarChart days={month} claudeData={claudeData} codexData={codexData} height={80} />
            </div>

            <div className="usage-overlay-section">
              <div className="usage-overlay-section-header">
                <span>7 days</span>
                <span>{fmtK(weekTok)} tokens</span>
                <span className="usage-dim">avg {fmtK(Math.round(weekTok / 7))}/d</span>
              </div>
              <BarChart days={week} claudeData={claudeData} codexData={codexData} height={60} />
            </div>

            <div className="usage-overlay-section">
              <div className="usage-overlay-section-header">
                <span>Today</span>
                <span>{fmtK(todayTok)} tokens</span>
                <span className={`usage-overlay-pct ${combinedPct > 120 ? 'usage-hot' : ''}`}>{combinedPct}% of p50</span>
              </div>
              <div className="usage-overlay-tokens">
                <div className="usage-overlay-token-row">
                  <span className="usage-overlay-token-label" style={{ color: CLAUDE_COLOR.bright }}>Claude</span>
                  <span>{fmtK(todayClaudeTok)}</span>
                  <span className="usage-dim">{claudePct}%</span>
                </div>
                {hasCodex && (
                  <div className="usage-overlay-token-row">
                    <span className="usage-overlay-token-label" style={{ color: CODEX_COLOR.bright }}>Codex</span>
                    <span>{fmtK(todayCodexTok)}</span>
                    <span className="usage-dim">{codexPct}%</span>
                  </div>
                )}
              </div>
            </div>

            <div className="usage-overlay-footer">
              <span className="usage-dim">p50 (14d): {fmtK(combinedP50)} combined</span>
            </div>

            <div className="usage-legend">
              <span><i style={{ background: CLAUDE_COLOR.base }} />Claude</span>
              <span><i style={{ background: CODEX_COLOR.base }} />Codex</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
