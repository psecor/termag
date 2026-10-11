import React, { useEffect, useRef, useState } from 'react';
import { reviewApi } from '../services/api';
import { guessExplanation, parsePrInputFull, type PrGuess } from '../utils/review';

interface Props {
  projectId: string;
  workstream: string;
  /** A review pane is already alive for this workstream: starting replaces it. */
  hasReview: boolean;
  onStarted: (r: { pr: number; url: string | null; session: string }) => void;
}

/**
 * "Review" — the overlay button in the lower-right of the agent pane. Click:
 * a small dialog guesses which PR the agent is working on (the current
 * branch's PR via gh, else the PR the agent just opened, else the last PR
 * mentioned in its pane), prefills it, and lets you retype or confirm. Start
 * launches Devin with a review prompt in the project's `review` tmux session;
 * the dock under the ctrl pane shows it (ReviewDock).
 */
export function ReviewButton({ projectId, workstream, hasReview, onStarted }: Props) {
  const [open, setOpen] = useState(false);
  const [guessing, setGuessing] = useState(false);
  const [guess, setGuess] = useState<PrGuess | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);
  const [value, setValue] = useState('');
  // A ref, not state: the guess effect reads it when the result lands, which
  // can be after the user started typing; a state value captured when the
  // dialog opened would still be false and the prefill would clobber them.
  const touchedRef = useRef(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Guess when the dialog opens. A prefill never overwrites what the user typed.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setGuessing(true); setGuess(null); setBranch(null); setGhError(null); setError(null);
    reviewApi.guess(projectId, workstream)
      .then(r => {
        if (cancelled) return;
        setGuess(r.guess); setBranch(r.branch); setGhError(r.ghError);
        if (r.guess && !touchedRef.current) setValue(String(r.guess.number));
      })
      .catch(err => { if (!cancelled) setError(err?.response?.data?.error ?? 'Could not look up the PR'); })
      .finally(() => { if (!cancelled) setGuessing(false); });
    return () => { cancelled = true; };
  }, [open, projectId, workstream]);

  // Select the prefilled number so typing replaces it.
  useEffect(() => {
    if (!open || guessing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open, guessing]);

  const close = () => { if (starting) return; setOpen(false); setValue(''); touchedRef.current = false; setError(null); };

  const parsed = parsePrInputFull(value);
  const pr = parsed?.number ?? null;
  const canStart = pr != null && !starting;

  const start = async () => {
    if (!canStart || pr == null) return;
    setStarting(true); setError(null);
    try {
      // A pasted URL is kept; otherwise the guess's URL applies only to the guessed number.
      const url = parsed?.url ?? (guess && guess.number === pr ? guess.url : null);
      const r = await reviewApi.start(projectId, { workstream, pr, url });
      onStarted({ pr: r.pr, url: r.url, session: r.session });
      setStarting(false);
      setOpen(false); setValue(''); touchedRef.current = false;
    } catch (err: any) {
      setStarting(false);
      setError(err?.response?.data?.error ?? 'Could not start the review');
    }
  };

  return (
    <>
      <button
        type="button"
        className="review-fab"
        title="Review the PR being worked on with Devin"
        onClick={() => setOpen(true)}
      >
        Review
      </button>
      {open && (
        <div className="confirm-backdrop" onClick={close}>
          <form
            className="confirm-dialog review-dialog"
            onClick={e => e.stopPropagation()}
            onSubmit={e => { e.preventDefault(); void start(); }}
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}
          >
            <div className="review-dialog-title">Review a pull request with Devin</div>
            <label className="review-dialog-label" htmlFor="review-pr-input">
              PR number{guessing && <span className="review-dialog-guessing"> · guessing…</span>}
            </label>
            <input
              id="review-pr-input"
              ref={inputRef}
              className="review-dialog-input"
              value={value}
              placeholder={guessing ? '…' : '123'}
              onChange={e => { setValue(e.target.value); touchedRef.current = true; }}
              autoComplete="off"
              spellCheck={false}
              disabled={starting}
            />
            <div className="review-dialog-hint">
              {guessing ? 'Checking the branch, the agent pane and recent PR events…' : guessExplanation(guess, branch)}
              {!guessing && guess?.url && (
                <> · <a href={guess.url} target="_blank" rel="noreferrer">open</a></>
              )}
            </div>
            {!guessing && !guess && ghError && (
              <div className="review-dialog-hint review-dialog-hint--muted" title={ghError}>gh could not be asked: {ghError}</div>
            )}
            <div className="review-dialog-note">
              Starts <code>devin</code> in a review pane under the ctrl terminal.
              {hasReview && ' The running review is replaced.'}
            </div>
            {error && <div className="review-dialog-error">{error}</div>}
            <div className="confirm-actions">
              <button type="button" className="confirm-btn confirm-btn-cancel" onClick={close} disabled={starting}>Cancel</button>
              <button type="submit" className="confirm-btn review-btn-primary" disabled={!canStart}>
                {starting ? 'Starting…' : pr != null ? `Review PR #${pr}` : 'Review'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
