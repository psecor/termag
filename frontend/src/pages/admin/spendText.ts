/**
 * The Spend tab's text formats and number formatting.
 * The price table and the model mix are edited as text, one entry per line,
 * like the PR tab's repo groups; the server validates again.
 */
import type { SpendPrice, SpendSettings } from '../../services/adminApi';

/** "$5,238", "$0.55", "$12.4K" for big headline numbers when `compact`. */
export function fmtUsd(n: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (opts.compact && abs >= 1e6) return `$${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (opts.compact && abs >= 1e4) return `$${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}K`;
  if (abs >= 100) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  if (abs === 0) return '$0';
  return `$${n.toFixed(abs >= 0.01 ? 2 : 4)}`;
}

/** A share of the loaded cost: "1.5%", "0.04%". */
export function fmtShare(r: number | null | undefined): string {
  if (r == null || !Number.isFinite(r)) return '—';
  const p = r * 100;
  return `${p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2)}%`;
}

/** UTC day keys for the last `days` days ending today, inclusive. */
export function windowKeys(days: number, now: Date = new Date()): { from: string; to: string } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const key = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { from: key(today - (days - 1) * 86_400_000), to: key(today) };
}

const fmtNum = (n: number) => String(Math.round(n * 1e6) / 1e6);

/** One line per price: `provider model effectiveFrom input output cacheRead cacheWrite` (USD per million tokens). */
export function pricesToText(prices: SpendPrice[]): string {
  return prices.map(p => [p.provider, p.model, p.effectiveFrom, p.input, p.output, p.cacheRead, p.cacheWrite].map(v => typeof v === 'number' ? fmtNum(v) : v).join(' ')).join('\n');
}

export function textToPrices(text: string): SpendPrice[] | { error: string } {
  const out: SpendPrice[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 7) return { error: `price line ${i + 1}: want provider model effectiveFrom input output cacheRead cacheWrite` };
    const [provider, model, effectiveFrom, ...nums] = parts;
    const vals = nums.map(Number);
    if (vals.some(v => !Number.isFinite(v) || v < 0)) return { error: `price line ${i + 1}: prices must be numbers ≥ 0` };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) return { error: `price line ${i + 1}: effectiveFrom must be YYYY-MM-DD` };
    out.push({ provider, model, effectiveFrom, input: vals[0], output: vals[1], cacheRead: vals[2], cacheWrite: vals[3] });
  }
  return out;
}

/** One line per provider: `claude: claude-opus-5-5=0.8, claude-fable-5-1=0.2`. */
export function mixToText(mix: SpendSettings['modelMix']): string {
  return Object.entries(mix).map(([prov, models]) => `${prov}: ${Object.entries(models).map(([m, w]) => `${m}=${fmtNum(w)}`).join(', ')}`).join('\n');
}

export function textToMix(text: string): { mix: SpendSettings['modelMix'] } | { error: string } {
  const out: SpendSettings['modelMix'] = {};
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = /^([a-z0-9][a-z0-9._-]*)\s*:\s*(.+)$/.exec(line);
    if (!m) return { error: `mix line ${i + 1}: want provider: model=weight, model=weight` };
    const models: Record<string, number> = {};
    for (const part of m[2].split(',').map(s => s.trim()).filter(Boolean)) {
      const kv = /^([a-z0-9][a-z0-9._-]*)\s*=\s*([0-9.]+)$/.exec(part);
      if (!kv || !Number.isFinite(Number(kv[2]))) return { error: `mix line ${i + 1}: bad entry "${part}"` };
      models[kv[1]] = Number(kv[2]);
    }
    out[m[1]] = models;
  }
  return { mix: out };
}
