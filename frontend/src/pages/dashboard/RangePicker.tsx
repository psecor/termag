import React from 'react';
import { Range, RANGES } from './range';

export function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div className="dash-range" role="group" aria-label="date range">
      {RANGES.map(r => (
        <button key={r.id} type="button" aria-pressed={value === r.id} onClick={() => onChange(r.id)}>
          {r.label}
        </button>
      ))}
    </div>
  );
}
