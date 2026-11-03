// A box's recent fleet operations in the Fleet card (box_events, backend
// services/boxEvents.ts): resizes and disk grows, newest first, each with who
// asked, the change, how it ended and when.
import React from 'react';
import type { BoxOperation } from '../../services/adminApi';
import { fmtAgo } from './shared';

/** One operation in a line: "resize small → large by zane (owner) · done · 3m ago". */
export function boxOperationLine(op: BoxOperation, now: number): string {
  const change = op.from || op.to ? ` ${op.from ?? '?'} → ${op.to ?? '?'}` : '';
  const who = op.actor ? ` by ${op.actor} (${op.actorRole})` : ` (${op.actorRole})`;
  const state = op.running ? `${op.phase}…` : op.phase;
  return `${op.kind}${change}${who} · ${state} · ${fmtAgo(op.startedAt, now)}`;
}

export function AdminBoxEvents({ events, now }: { events: BoxOperation[] | undefined; now: number }) {
  if (!events?.length) return <span className="usage-dim">none recorded</span>;
  return (
    <ul className="admin-box-events">
      {events.map(op => (
        <li key={op.id} className={op.phase === 'failed' ? 'admin-bad' : undefined} title={new Date(op.startedAt).toLocaleString()}>
          {boxOperationLine(op, now)}
          {op.reason && <span className="usage-dim"> · “{op.reason}”</span>}
          {op.error && <div className="usage-dim">{op.error}</div>}
        </li>
      ))}
    </ul>
  );
}
