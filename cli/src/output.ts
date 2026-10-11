/** Left-aligned columns, two spaces apart; the last column is not padded. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

/** 2026-10-02T14:05:00.000Z → 2026-10-02 14:05 UTC. Locale-independent on purpose. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
