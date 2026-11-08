import type { SoftwareCell } from '../../services/adminApi';

/** Since when a pending reboot has waited, from the `reboot` row's raw (`since 2026-11-02T06:10:00Z · …`; backend versions.ts rebootPendingSince). */
export function rebootSince(raw: string | null | undefined): string | null {
  const m = /\bsince (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/.exec(raw ?? '');
  return m ? m[1] : null;
}

/** How long, in the matrix's short form: "3 d", "5 h", "20 min". Null without a since. */
export function pendingFor(raw: string | null | undefined, now: number): string | null {
  const since = rebootSince(raw);
  if (!since) return null;
  const min = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
  return min >= 2 * 1440 ? `${Math.floor(min / 1440)} d` : min >= 120 ? `${Math.floor(min / 60)} h` : `${min} min`;
}

/** Why, from the raw: everything after the since ("kernel 6.8.0-1068-aws installed · packages: linux-base"). */
export function rebootWhy(raw: string | null | undefined): string | null {
  const rest = (raw ?? '').split(' · ').filter(p => !/^since /.test(p) && !/^booted /.test(p)).join(' · ');
  return rest || null;
}

/** The matrix cell's text for the `reboot` component: "pending · 3 d", "no", or the version as is. */
export function rebootCellText(cell: SoftwareCell, now: number): string {
  if (cell.state !== 'pending') return cell.version ?? '—';
  const f = pendingFor(cell.raw, now);
  return f ? `pending · ${f}` : 'pending';
}

/** The host panel's line for a pending reboot, null when there is none. */
export function rebootPanelText(cell: SoftwareCell | undefined, now: number): string | null {
  if (!cell || cell.state !== 'pending') return null;
  const since = rebootSince(cell.raw);
  const f = pendingFor(cell.raw, now);
  const why = rebootWhy(cell.raw);
  return `Reboot pending${since ? ` since ${since.replace('T', ' ').replace(/:\d{2}Z$/, ' UTC')} (${f})` : ''}${why ? `: ${why}` : ''}. The next boot (a park and start, a resize) takes it.`;
}

/**
 * A line split so its kernel versions ("6.8.0-1068-aws", "6.8.0-1068") can be set in monospace and the
 * words around them in the UI font. Joined back, the parts are the line.
 */
export function kernelParts(text: string): Array<{ text: string; kernel: boolean }> {
  return text.split(/(\b\d+\.\d+\.\d+-[0-9A-Za-z][0-9A-Za-z.+~-]*)/).filter(Boolean).map(t => ({ text: t, kernel: /^\d+\.\d+\.\d+-/.test(t) }));
}
