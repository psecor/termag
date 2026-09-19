import React from 'react';

export interface TableSpec {
  columns: string[];
  rows: Array<Array<string | number>>;
}

interface Props {
  title: string;
  value?: string;
  subtitle?: string;
  /** Dim the card while a refetch is in flight — the frame never blanks. */
  stale?: boolean;
  table?: TableSpec;
  children: React.ReactNode;
}

/** Card shell: title · headline value · dim subtitle, the chart, and a collapsed data table twin. */
export function ChartCard({ title, value, subtitle, stale, table, children }: Props) {
  return (
    <section className={`dash-card ${stale ? 'dash-stale' : ''}`}>
      <div className="dash-card-head">
        <span>{title}</span>
        {subtitle && <span className="usage-dim">{subtitle}</span>}
        {value && <span className="dash-card-value">{value}</span>}
      </div>
      {children}
      {table && table.rows.length > 0 && (
        <details>
          <summary>data</summary>
          <table>
            <thead><tr>{table.columns.map(c => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>
              {table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}
            </tbody>
          </table>
        </details>
      )}
    </section>
  );
}
