// A Standard row's body under the chrome refresh's view options:
// the title and the age, then where it is
// and its state, then the agent's last words. Compact rows are the title and
// the age alone (OpenItems.tsx).
import React from 'react';
import type { RowState } from '../../chat/rowState';

/** How many rows a folded parent hides, beside its name. Hidden from assistive tech: its caret's label says it. */
export function FoldedCount({ n }: { n: number }) {
  return <span className="chat-item-folded" aria-hidden="true">+{n}</span>;
}

export function StandardRowBody({ name, age, where, state, folded = null }: {
  name: React.ReactNode;
  age: string | null;
  /** The project and workstream under a titled session, or a file's space and path. */
  where: string | null;
  state: RowState | null;
  /** A folded parent's hidden rows (FoldedCount). */
  folded?: number | null;
}) {
  return (
    <span className="chat-item-body">
      <span className="chat-item-top">
        <span className="chat-item-name">{name}</span>
        {folded !== null && <FoldedCount n={folded} />}
        {age && <span className="chat-item-age" aria-hidden="true">{age}</span>}
      </span>
      {(where || state) && (
        <span className="chat-item-sub" data-status={state?.kind}>
          {where && <span className="chat-item-where">{where}</span>}
          {/* The row's screen-reader text already says the state. */}
          {state && <span className="chat-item-state" aria-hidden="true">{state.text}</span>}
        </span>
      )}
      {state?.message && <span className="chat-item-msg">{state.message}</span>}
    </span>
  );
}
