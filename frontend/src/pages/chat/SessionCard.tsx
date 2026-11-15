// A session's card in the Projects view under user-projects-enabled:
// no left gutter, the project's icon with the
// model's mark on its corner, the title, and on the right one status chip,
// its mark and how long the session has been in that status. Standard adds
// one line, flush under the icon: the branch, the PR, and a box icon whose
// tooltip says which box and whether it's up. Compact is the first line alone.
// The card's controls float over its right end on hover or focus and never
// take width: the chip keeps its place under them, hidden, so nothing reflows.
// The open card is a filled background, never a border.
import React from 'react';
import { Link } from 'react-router-dom';
import { ProgressBar } from '@launchpad-ui/components';
import type { RowState } from '../../chat/rowState';
import { chipKind } from '../../chat/sessionCard';
import './sessionCard.css';

/** The chip's mark: one meaning each (a spinner, amber or red, blue for unseen, a tick, a ring). */
function ChipMark({ state }: { state: RowState }) {
  if (state.kind === 'working') return <ProgressBar variant="spinner" size="small" isIndeterminate aria-label="Working" />;
  if (state.kind === 'approval' || state.kind === 'unread' || state.kind === 'error' || state.unseen) return <span className="sc-dot" />;
  if (state.kind === 'off') return <span className="sc-ring" />;
  // Hand-drawn: LaunchPad's check is drawn on a 20 px grid and blurs at 10. Centred in its box, so on the time's cap height.
  return <svg className="sc-tick" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.25 6.5 11.75 13 4.25" /></svg>;
}

/** What a card says, for the link SessionCard draws and for an archived card's button (ArchivedRows.tsx). */
export interface CardLinesProps {
  title: string;
  /** A review session: a review mark before the title. */
  review?: boolean;
  /** The project's icon, with the model's mark on it (ProjectGlyph). */
  glyph: React.ReactNode;
  state: RowState;
  /** Time in this status (chat/sessionCard.ts chipAge); null when unknown. */
  age: string | null;
  standard: boolean;
  branch: string | null;
  pr: string | null;
  /** The box's name, for the box icon; null for none. */
  box: string | null;
  boxTip: string | null;
  /** What a screen reader hears after the title. */
  sr: string;
}

/**
 * A review session's mark, before its title: drawn here at 12 px, the mock's pull-request glyph, since LaunchPad's
 * icons are drawn on a 20 px grid and blur scaled down to a mark this size (simple-ui-launchpad-controls).
 */
function ReviewMark() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="4" cy="3.5" r="1.6" /><circle cx="4" cy="12.5" r="1.6" /><circle cx="12" cy="12.5" r="1.6" />
      <path d="M4 5.1v5.8M12 10.9V7a2 2 0 0 0-2-2H7.5M9 3.4 7.4 5 9 6.6" />
    </svg>
  );
}

/** The card's first line (the icon, the title, the chip) and Standard's second, inside whatever the card is. */
export function CardLines({ title, review = false, glyph, state, age, standard, branch, pr, box, boxTip, sr }: CardLinesProps) {
  return (
    <>
      <span className="sc-l1">
        {glyph}
        {review && <span className="sc-review" data-tip="A review session"><ReviewMark /><span className="chat-sr">Review: </span></span>}
        <span className="sc-title">{title}</span>
        <span className="sc-chip" data-kind={chipKind(state.kind)} data-unseen={state.unseen || undefined} aria-hidden="true">
          <span className="sc-chip-mark"><ChipMark state={state} /></span>
          {age && <span className="sc-chip-time">{age}</span>}
        </span>
      </span>
      {standard && (
        <span className="sc-l2" aria-hidden="true">
          <svg className="sc-branch-icon" viewBox="0 0 16 16">
            <circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5.5" r="1.5" />
            <path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-6 4.2" />
          </svg>
          <span className="sc-branch">{branch ?? 'main'}</span>
          {pr && <span className="sc-pr">{pr}</span>}
          {box && (
            <span className="sc-box" data-tip={boxTip ?? box}>
              <svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="4.5" rx="1.2" /><rect x="2" y="9" width="12" height="4.5" rx="1.2" /></svg>
            </span>
          )}
        </span>
      )}
      <span className="chat-sr">, {sr}</span>
    </>
  );
}

export function SessionCard({
  href, standard, open, state, tip, depth = 0, actions, onKeyDown, ...lines
}: CardLinesProps & {
  href: string;
  open: boolean;
  tip: string;
  depth?: number;
  /** Float over the card's right end while it is hovered or focused. */
  actions?: React.ReactNode;
  onKeyDown?: React.KeyboardEventHandler;
}) {
  return (
    <div className="sc-wrap" style={depth ? { '--sc-depth': depth } as React.CSSProperties : undefined}>
      <Link to={href} draggable={false} className="sc" aria-current={open ? 'page' : undefined}
        data-state={state.kind} data-unseen={state.unseen || undefined} data-density={standard ? 'standard' : 'compact'}
        data-tip={tip} onKeyDown={onKeyDown}>
        <CardLines standard={standard} state={state} {...lines} />
      </Link>
      {actions && <span className="sc-over">{actions}</span>}
    </div>
  );
}
