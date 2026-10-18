import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtAge, fmtDurationShort, fmtK } from '../../utils/format';
import type { Signal, SignalSeverity } from '../../services/adminApi';
import { usePolled, type Polled, type PolledOptions } from '../dashboard/useDashboardData';

/** After a failed fetch the admin pages re-try this soon, not after the full poll interval. */
export const ADMIN_RETRY_MS = 15_000;

/** usePolled with a short retry after errors, so one failure doesn't leave a card empty for minutes. */
export function useAdminPolled<T>(fetcher: () => Promise<T>, intervalMs: number, opts: PolledOptions = {}) {
  return usePolled(fetcher, intervalMs, { retryMs: Math.min(intervalMs, ADMIN_RETRY_MS), ...opts });
}

/**
 * "500 Internal error" from an HTTP failure: the server's `error` message, else
 * the status text (axios's own message would repeat the status). A failure with
 * no response (network down) is its message.
 */
export function errorText(error: unknown): string {
  const e = error as { response?: { status?: number; statusText?: string; data?: { error?: string } }; message?: string } | null;
  const status = e?.response?.status;
  if (!status) return e?.message || 'request failed';
  const msg = e?.response?.data?.error || e?.response?.statusText;
  return msg ? `${status} ${msg}` : `${status}`;
}

/**
 * The detail of the row selected in a table (a box, a user), keyed by the
 * selection it was fetched for: a new selection never shows the previous
 * row's detail while its own loads. Refetched whenever `refreshKey` changes
 * (the table's poll), and ADMIN_RETRY_MS after a failure. A failed refresh
 * keeps the last good detail for the same row and reports the error beside it.
 */
export function useSelectedDetail<T>(selected: string | null, fetch: (id: string) => Promise<T>, refreshKey: readonly unknown[]) {
  const [loaded, setLoaded] = useState<{ id: string; detail: T | null; error: unknown } | null>(null);
  const [retry, setRetry] = useState(0);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const key = JSON.stringify(refreshKey);
  useEffect(() => {
    if (!selected) { setLoaded(null); return; }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    fetchRef.current(selected)
      .then(detail => { if (live) setLoaded({ id: selected, detail, error: null }); })
      .catch(error => {
        if (!live) return;
        setLoaded(prev => ({ id: selected, detail: prev?.id === selected ? prev.detail : null, error }));
        timer = setTimeout(() => setRetry(n => n + 1), ADMIN_RETRY_MS);
      });
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [selected, key, retry]);
  const mine = loaded?.id === selected ? loaded : null;
  return { detail: mine?.detail ?? null, error: mine?.error ?? null };
}

/** Subtitle suffix for a detail card whose last refresh failed. */
export function refreshFailedText(error: unknown): string {
  return error ? ` · refresh failed: ${errorText(error)}, retrying` : '';
}

/**
 * The placeholder for a card with no data yet: "loading…" while the first
 * fetch is out, the failure once it has failed, so an error never reads as a
 * load that takes forever.
 */
export function pendingText(p: Pick<Polled<unknown>, 'error'>): string {
  return p.error ? `failed to load: ${errorText(p.error)} · retrying` : 'loading…';
}

export const fmtAgo = (iso: string | null | undefined, now: number): string => iso ? `${fmtAge(now - Date.parse(iso))} ago` : '—';
/** For timestamps that may lie ahead (token expiry): "in 6d 23h", or "expired 2h ago" once past. */
export const fmtUntil = (iso: string | null | undefined, now: number): string => {
  if (!iso) return '—';
  const delta = Date.parse(iso) - now;
  return delta >= 0 ? `in ${fmtAge(delta)}` : `expired ${fmtAge(-delta)} ago`;
};
export const fmtPct = (r: number | null | undefined): string => r == null ? '—' : `${Math.round(r * 100)}%`;
export const fmtBytes = (b: number): string => b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} kB` : `${b} B`;
export const fmtMs = (ms: number): string => ms > 0 ? fmtDurationShort(ms) : '0';
export const fmtTok = (n: number): string => n > 0 ? fmtK(n) : '0';
export const fmtSeconds = (s: number | null): string => s == null ? '—' : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;

/** Sortable table. Columns declare how to pull a sortable value and how to render. */
export interface Column<T> {
  id: string; label: string;
  value: (row: T) => string | number | null | undefined;
  render?: (row: T) => React.ReactNode;
  align?: 'left' | 'right';
  title?: string;
}
export function DataTable<T>({ rows, columns, rowKey, defaultSort, defaultDesc = true, empty = 'nothing to show', dense }: {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; defaultSort: string; defaultDesc?: boolean; empty?: string; dense?: boolean;
}) {
  const [sort, setSort] = useState(defaultSort);
  const [desc, setDesc] = useState(defaultDesc);
  const sorted = useMemo(() => {
    const col = columns.find(c => c.id === sort) ?? columns[0];
    return [...rows].sort((a, b) => {
      const va = col.value(a), vb = col.value(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return desc ? -c : c;
    });
  }, [rows, columns, sort, desc]);
  const click = (id: string) => { if (id === sort) setDesc(d => !d); else { setSort(id); setDesc(true); } };
  return (
    <div className="admin-table-wrap">
      <table className={`admin-table ${dense ? 'admin-table--dense' : ''}`}>
        <thead>
          <tr>{columns.map(c => (
            <th key={c.id} className={c.align ?? 'left'} title={c.title} onClick={() => click(c.id)} aria-sort={sort === c.id ? (desc ? 'descending' : 'ascending') : 'none'}>
              {c.label}{sort === c.id ? (desc ? ' ▾' : ' ▴') : ''}
            </th>
          ))}</tr>
        </thead>
        <tbody>
          {sorted.length === 0 && <tr><td colSpan={columns.length} className="usage-dim">{empty}</td></tr>}
          {sorted.map(r => (
            <tr key={rowKey(r)}>{columns.map(c => <td key={c.id} className={c.align ?? 'left'}>{c.render ? c.render(r) : (c.value(r) ?? '—')}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  return <span className={`admin-pill admin-pill--${status.replace(/[^a-z_-]/gi, '')}`}>{status.replace('_', ' ')}</span>;
}

export function Dot({ on, title }: { on: boolean; title?: string }) {
  return <i className="attn-dot" title={title ?? (on ? 'connected' : 'offline')} style={{ background: on ? 'var(--success)' : 'var(--text-muted)' }} />;
}

const CHIP: Record<SignalSeverity, { glyph: string; label: string }> = {
  critical: { glyph: '●', label: 'critical' }, warning: { glyph: '▲', label: 'warn' }, notice: { glyph: '○', label: 'note' }, good: { glyph: '✓', label: 'good' },
};

export function signalHref(s: Signal): string | null {
  // Cloud session and orchestrator signals land on the Cloud tab, narrowed to the box when there is one.
  if (s.kind.startsWith('cloud_') || s.kind === 'orchestrator_down') return s.instanceId ? `/admin/cloud?box=${encodeURIComponent(s.instanceId)}` : '/admin/cloud';
  if (s.instanceId) return `/admin/fleet?box=${encodeURIComponent(s.instanceId)}`;
  if (s.userId) return `/admin/users?user=${encodeURIComponent(s.userId)}`;
  return null;
}

export function SignalsList({ signals, loaded, show = 10, now }: { signals: Signal[]; loaded: boolean; show?: number; now: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? signals : signals.slice(0, show);
  return (
    <section className="dash-section" aria-labelledby="sig-h">
      <div className="dash-section-title" id="sig-h">Signals {loaded && signals.length > 0 && <span className="dash-count">{signals.length}</span>}</div>
      {!loaded ? <div className="attn-empty dash-stale"><span className="attn-empty-glyph">…</span><div>checking the fleet</div></div>
      : signals.length === 0 ? <div className="attn-empty"><span className="attn-empty-glyph" aria-hidden>✓</span><div>Nothing stuck, idle or burning.</div></div>
      : (
        <>
          <div className="attn-list">
            {shown.map(s => {
              const chip = CHIP[s.severity];
              const href = signalHref(s);
              const body = (
                <>
                  <span className={`attn-chip attn-chip--${s.severity}`}>{chip.glyph} {chip.label}</span>
                  <span className="attn-body">
                    <span className="attn-title">{s.title}</span>
                    <span className="attn-detail">{s.detail}{s.since ? ` · since ${fmtAgo(s.since, now)}` : ''}</span>
                  </span>
                  <span className="attn-action">{s.kind.replace(/_/g, ' ')} {href ? '→' : ''}</span>
                </>
              );
              return href ? <Link key={s.id} className="attn-item" to={href}>{body}</Link> : <div key={s.id} className="attn-item">{body}</div>;
            })}
          </div>
          {signals.length > show && (
            <div className="attn-foot"><button type="button" className="btn-ghost btn-tiny" onClick={() => setAll(a => !a)}>{all ? 'Show fewer' : `+${signals.length - show} more`}</button></div>
          )}
        </>
      )}
    </section>
  );
}

export function KeyValues({ items }: { items: Array<[string, React.ReactNode]> }) {
  return <div className="dash-rows">{items.map(([k, v]) => <div className="dash-row" key={k}><span className="dash-row-label">{k}</span><span className="dash-row-value">{v}</span></div>)}</div>;
}

export function Counts({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort(([, a], [, b]) => b - a);
  return <span>{entries.length ? entries.map(([k, v]) => `${v} ${k}`).join(' · ') : '—'}</span>;
}
