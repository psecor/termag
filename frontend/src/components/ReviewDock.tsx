import React from 'react';
import { Terminal } from './Terminal';
import { reviewApi } from '../services/api';
import { reviewStateLabel, reviewStateText, type ReviewStatus } from '../utils/review';
import type { SessionReview } from '../types';

interface Props {
  projectId: string;
  instanceId: string | null | undefined;
  workstream: string;
  sessionName: string;
  status: Pick<ReviewStatus, 'alive' | 'state' | 'pr' | 'url' | 'reviewer'>;
  /** The sweep's review meta riding the agent session's status. */
  review?: SessionReview | null;
  expanded: boolean;
  onToggle: () => void;
  onStop: () => void;
}

/**
 * The review pane's home at the bottom of the ctrl column. Collapsed it is a
 * one-line bar ("Review · PR #123 · Devin reviewing… / needs an answer /
 * Review ready"); expanded it takes
 * half the column's height and attaches a terminal to the `review` tmux
 * session so Devin's output can be read and answered in place. Stop kills the
 * session and the dock goes away. Its state comes from the backend's review
 * sweep via the status channel, not from polling.
 */
export function ReviewDock({ projectId, instanceId, workstream, sessionName, status, review, expanded, onToggle, onStop }: Props) {
  const label = reviewStateLabel(status);
  // Clicking into the Devin pane is what "reading the review" means: post
  // seen while the review is ready, so the ring clears.
  // Only wired while `done` — the browser is the only poster, and a review
  // still running keeps its ring whatever the pane's focus does.
  const seenDue = review?.state === 'done';
  const onTerminalFocus = React.useCallback(() => {
    if (seenDue) reviewApi.seen(projectId, workstream).catch(() => {});
  }, [seenDue, projectId, workstream]);
  return (
    <div className={`review-dock ${expanded ? 'is-expanded' : ''}`}>
      <div
        className="review-dock-bar"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        title={expanded ? 'Collapse the review pane' : 'Expand the review pane'}
      >
        <span className="review-dock-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className="review-dock-title">Review</span>
        {status.pr != null && (
          status.url
            ? <a className="review-dock-pr" href={status.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>PR #{status.pr}</a>
            : <span className="review-dock-pr">PR #{status.pr}</span>
        )}
        <span className={`review-dock-state is-${label}`}>{reviewStateText(label, status.reviewer)}</span>
        <span className="review-dock-spacer" />
        <button
          type="button"
          className="review-dock-btn"
          onClick={e => { e.stopPropagation(); onToggle(); }}
        >
          {expanded ? 'Collapse' : 'Expand'}
        </button>
        <button
          type="button"
          className="review-dock-btn review-dock-btn--stop"
          title="Stop the review and close this pane"
          onClick={e => { e.stopPropagation(); onStop(); }}
        >
          ✕
        </button>
      </div>
      {expanded && (
        <div className="review-dock-body">
          <Terminal
            sessionName={sessionName}
            projectId={projectId}
            workstream={workstream}
            instanceId={instanceId}
            active={true}
            autoFocus={false}
            onFocus={seenDue ? onTerminalFocus : undefined}
            key={`${projectId}-${workstream}-review`}
          />
        </div>
      )}
    </div>
  );
}
