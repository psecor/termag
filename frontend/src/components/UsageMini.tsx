import React, { useEffect, useState, useRef } from 'react';
import { usageApi, UsageDayData } from '../services/api';

// Opus pricing per million tokens
const PRICE_INPUT = 15;
const PRICE_OUTPUT = 75;
const PRICE_CACHE_READ = 1.875;
const PRICE_CACHE_CREATE = 3.75;

function dayCost(d: UsageDayData): number {
  return (
    (d.input * PRICE_INPUT +
      d.output * PRICE_OUTPUT +
      d.cacheRead * PRICE_CACHE_READ +
      d.cacheCreate * PRICE_CACHE_CREATE) / 1_000_000
  );
}

function fmt$(n: number): string {
  return n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`;
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

// Fill gradient: dark blue below 100%, brighter blue above
function fillGradient(pct: number): string {
  const fillPct = Math.min(200, pct);
  const midPoint = (100 / fillPct) * 100; // where 100% mark sits in the fill
  if (fillPct <= 100) {
    return 'rgba(31, 111, 235, 0.6)';
  }
  // Gradient from dark blue at bottom to bright blue at top
  return `linear-gradient(to top, rgba(31, 111, 235, 0.5) 0%, rgba(31, 111, 235, 0.6) ${midPoint}%, rgba(88, 166, 255, 0.9) 100%)`;
}

// ── Bar Chart (used in expanded overlay) ─────────────────────

interface BarChartProps {
  days: string[];
  data: Record<string, UsageDayData>;
  height: number;
}

function BarChart({ days, data, height }: BarChartProps) {
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

    const costs = days.map(d => {
      const dd = data[d] || EMPTY;
      return {
        output: (dd.output * PRICE_OUTPUT) / 1_000_000,
        input: (dd.input * PRICE_INPUT) / 1_000_000,
        cacheRead: (dd.cacheRead * PRICE_CACHE_READ) / 1_000_000,
        cacheCreate: (dd.cacheCreate * PRICE_CACHE_CREATE) / 1_000_000,
      };
    });

    const maxCost = Math.max(1, ...costs.map(c => c.output + c.input + c.cacheRead + c.cacheCreate));
    const gap = 2;
    const barW = Math.max(2, (w - gap * (days.length - 1)) / days.length);

    ctx.clearRect(0, 0, w, h);

    for (let i = 0; i < days.length; i++) {
      const x = i * (barW + gap);
      const c = costs[i];
      const total = c.cacheRead + c.cacheCreate + c.input + c.output;
      const barH = (total / maxCost) * (h - 1);

      let y = h;
      const segments = [
        { val: c.cacheRead, color: 'rgba(88, 166, 255, 0.25)' },
        { val: c.cacheCreate, color: 'rgba(88, 166, 255, 0.4)' },
        { val: c.input, color: 'rgba(88, 166, 255, 0.6)' },
        { val: c.output, color: 'rgba(88, 166, 255, 0.9)' },
      ];

      for (const seg of segments) {
        if (seg.val <= 0) continue;
        const segH = total > 0 ? (seg.val / total) * barH : 0;
        y -= segH;
        ctx.fillStyle = seg.color;
        ctx.fillRect(x, y, barW, segH);
      }
    }
  }, [days, data]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', height, display: 'block' }}
    />
  );
}

// ── Main Component ───────────────────────────────────────────

export function UsageMini() {
  const [data, setData] = useState<Record<string, UsageDayData> | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const load = () => usageApi.get()
      .then(r => { console.log('[UsageMini] loaded', Object.keys(r.days || {}).length, 'days'); setData(r.days); })
      .catch(e => console.warn('[UsageMini] fetch failed:', e?.response?.status, e?.message));
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  // Escape closes overlay and refocuses agent terminal
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setExpanded(false);
        // Refocus the agent terminal
        const agentPane = document.querySelector<HTMLElement>('#terminal-agent .xterm-helper-textarea');
        if (agentPane) agentPane.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  if (!data) return null;

  const today = todayStr();
  const month = lastNDays(30);
  const week = lastNDays(7);

  const todayData = data[today] || EMPTY;
  const todayCost = dayCost(todayData);

  // Trailing 14-day p50 (excluding today)
  const trailingDays = lastNDays(15).slice(0, 14);
  const trailingCosts = trailingDays.map(d => dayCost(data[d] || EMPTY));
  const p50 = median(trailingCosts);

  const pct = p50 > 0 ? Math.round((todayCost / p50) * 100) : 0;
  const fillPct = Math.min(200, pct); // cap fill at 200%

  const weekCost = week.reduce((sum, d) => sum + dayCost(data[d] || EMPTY), 0);
  const monthCost = month.reduce((sum, d) => sum + dayCost(data[d] || EMPTY), 0);

  return (
    <>
      {/* Thermometer gauge — always visible */}
      <div className="usage-thermo" onClick={() => setExpanded(!expanded)}>
        <div className="usage-thermo-pct">{pct}%</div>
        <div className="usage-thermo-tube">
          <div className="usage-thermo-fill" style={{
            height: `${(fillPct / 200) * 100}%`,
            background: fillGradient(pct),
          }} />
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
        <div className="usage-thermo-cost">{fmt$(todayCost)}</div>
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
                <span>{fmt$(monthCost)}</span>
                <span className="usage-dim">avg {fmt$(monthCost / 30)}/d</span>
              </div>
              <BarChart days={month} data={data} height={80} />
            </div>

            <div className="usage-overlay-section">
              <div className="usage-overlay-section-header">
                <span>7 days</span>
                <span>{fmt$(weekCost)}</span>
                <span className="usage-dim">avg {fmt$(weekCost / 7)}/d</span>
              </div>
              <BarChart days={week} data={data} height={60} />
            </div>

            <div className="usage-overlay-section">
              <div className="usage-overlay-section-header">
                <span>Today</span>
                <span>{fmt$(todayCost)}</span>
                <span className={`usage-overlay-pct ${pct > 120 ? 'usage-hot' : ''}`}>{pct}% of p50</span>
              </div>
              <div className="usage-overlay-tokens">
                <div className="usage-overlay-token-row">
                  <span className="usage-overlay-token-label">Output</span>
                  <span>{fmtK(todayData.output)} tokens</span>
                  <span className="usage-dim">{fmt$((todayData.output * PRICE_OUTPUT) / 1_000_000)}</span>
                </div>
                <div className="usage-overlay-token-row">
                  <span className="usage-overlay-token-label">Input</span>
                  <span>{fmtK(todayData.input)} tokens</span>
                  <span className="usage-dim">{fmt$((todayData.input * PRICE_INPUT) / 1_000_000)}</span>
                </div>
                <div className="usage-overlay-token-row">
                  <span className="usage-overlay-token-label">Cache read</span>
                  <span>{fmtK(todayData.cacheRead)} tokens</span>
                  <span className="usage-dim">{fmt$((todayData.cacheRead * PRICE_CACHE_READ) / 1_000_000)}</span>
                </div>
                <div className="usage-overlay-token-row">
                  <span className="usage-overlay-token-label">Cache write</span>
                  <span>{fmtK(todayData.cacheCreate)} tokens</span>
                  <span className="usage-dim">{fmt$((todayData.cacheCreate * PRICE_CACHE_CREATE) / 1_000_000)}</span>
                </div>
              </div>
            </div>

            <div className="usage-overlay-footer">
              <span className="usage-dim">p50 (14d trailing): {fmt$(p50)}/day</span>
            </div>

            <div className="usage-legend">
              <span><i style={{ background: 'rgba(88, 166, 255, 0.9)' }} />out</span>
              <span><i style={{ background: 'rgba(88, 166, 255, 0.6)' }} />in</span>
              <span><i style={{ background: 'rgba(88, 166, 255, 0.25)' }} />cache</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
