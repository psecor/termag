// The page a review on a repository with no project waits on (simple-ui-review-clone-enabled). Review moves here at once instead of waiting on its button. The page
// shows the clone's steps as chat/reviewClone.ts reports them (the box waking, the project made, the clone) and,
// once the review starts in the new project, replaces itself with that session, whose Review tab carries on. A clone
// that fails says why here, with the way back to try again.
import React, { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ProgressBar } from '@launchpad-ui/components';
import { cloneOutcomeFor, cloneProgressText, noteCloneOutcome, useCloneOutcome, useReviewClone } from '../../chat/reviewClone';
import { prPath, prShort } from '../../chat/reviews';
import { chatHref } from '../../chat/simpleChat';
import { ChatHistoryButton } from './chatChrome';

/** What the page says: a step, the failure, or (nothing started from this page load) that nothing is starting. */
export function cloneStartView(
  progress: Parameters<typeof cloneProgressText>[0] | null,
  outcome: ReturnType<typeof useCloneOutcome>,
): { kind: 'step'; text: string } | { kind: 'error'; text: string } | { kind: 'idle' } {
  if (outcome && 'error' in outcome) return { kind: 'error', text: outcome.error };
  // Done: the session opens next (this page goes as it does).
  if (outcome && 'to' in outcome) return { kind: 'step', text: 'Opening the session…' };
  if (progress) return { kind: 'step', text: cloneProgressText(progress) };
  if (outcome) return { kind: 'step', text: 'Starting the review…' };
  return { kind: 'idle' };
}

export function ReviewCloneStart() {
  const { owner = '', name = '', number: raw = '' } = useParams();
  const repo = `${owner}/${name}`;
  const number = Number(raw);
  const navigate = useNavigate();
  const progress = useReviewClone(repo);
  const outcome = useCloneOutcome(repo, number);
  // The review is starting in its session: that page replaces this one, so Back goes to the PR.
  useEffect(() => {
    if (!outcome || !('to' in outcome)) return;
    navigate(chatHref(outcome.to.projectId, outcome.to.workstream), { replace: true, state: outcome.to.state });
  }, [outcome, navigate]);
  // Forgotten once this page has gone, not before: cleared while it still shows, it would say nothing is starting.
  useEffect(() => () => {
    const left = cloneOutcomeFor(repo, number);
    if (left && 'to' in left) noteCloneOutcome(repo, number, null);
  }, [repo, number]);
  const view = cloneStartView(progress, outcome);
  const pr = prShort(repo, number);
  const back = <Link to={prPath(repo, number)}>Back to {pr}</Link>;
  return (
    <div className="chat-view">
      <section className="chat-conv">
        <header className="chat-header">
          <ChatHistoryButton />
          <div className="chat-title">
            <Link to={prPath(repo, number)} className="rv-crumb">{pr}</Link>
            <span className="chat-crumb-sep rv-sep" aria-hidden="true">/</span>
            <span className="chat-title-name">{view.kind === 'error' ? "Couldn't start the review" : view.kind === 'idle' ? 'Nothing starting' : 'Starting the review'}</span>
          </div>
        </header>
        <div className="chat-transcript">
          <div className="rv-clone-start">
            {view.kind === 'error' && (
              <>
                <p className="rv-note rv-pane-error" role="alert">{view.text}</p>
                <p className="rv-note">{back} to try again.</p>
              </>
            )}
            {view.kind === 'step' && (
              <p className="rv-note rv-clone-step" role="status">
                <ProgressBar variant="spinner" size="small" isIndeterminate aria-label="Starting" />
                {view.text}
              </p>
            )}
            {view.kind === 'idle' && <p className="rv-note">Nothing is starting here now. {back}.</p>}
          </div>
        </div>
      </section>
    </div>
  );
}
