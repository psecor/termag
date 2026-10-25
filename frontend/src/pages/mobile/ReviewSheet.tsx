// The phone's take on the desktop ReviewButton dialog: guess which PR the
// agent is working on, let the user confirm or retype it, and start Devin in
// the workstream's `review` tmux session. The result shows up as a third tab.
import React, { useEffect, useRef, useState } from 'react';
import { reviewApi } from '../../services/api';
import { guessExplanation, parsePrInputFull, reviewTargetView, type PrGuess } from '../../utils/review';
import { reviewSubmitLabel } from '../../mobile/review';
import { Sheet, apiError } from './Sheet';

interface Props {
  projectId: string;
  projectName: string;
  workstream: string;
  /** A review pane is alive for this workstream: starting replaces it. */
  hasReview: boolean;
  /** The PR that pane is reviewing, when known. */
  currentPr?: number | null;
  /** Jump to the running review's tab instead of starting another. */
  onOpenCurrent?: () => void;
  onStarted: (r: { pr: number; url: string | null; session: string }) => void;
  /** A PR handed in from outside (a share): wins over the guess. */
  initialValue?: string;
  onClose: () => void;
}

export function ReviewSheet({ projectId, projectName, workstream, hasReview, currentPr, onOpenCurrent, onStarted, initialValue, onClose }: Props) {
  const [guessing, setGuessing] = useState(true);
  const [guess, setGuess] = useState<PrGuess | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);
  const [repo, setRepo] = useState<{ repo: string | null; known: boolean }>({ repo: null, known: false });
  const [value, setValue] = useState(initialValue ?? '');
  // A ref: the guess lands after the sheet opened, maybe after the user typed.
  const touched = useRef(initialValue != null && initialValue !== '');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    reviewApi.guess(projectId, workstream)
      .then(r => {
        if (cancelled) return;
        setGuess(r.guess); setBranch(r.branch); setGhError(r.ghError); setRepo({ repo: r.repo ?? null, known: r.repoKnown === true });
        if (r.guess && !touched.current) setValue(String(r.guess.number));
      })
      .catch(err => { if (!cancelled) setError(apiError(err, 'Could not look up the PR')); })
      .finally(() => { if (!cancelled) setGuessing(false); });
    return () => { cancelled = true; };
  }, [projectId, workstream]);

  const parsed = parsePrInputFull(value);
  const pr = parsed?.number ?? null;
  // The repository the PR is in, as on the desktop dialog (utils/review.ts).
  const target = reviewTargetView({ pr, typedUrl: parsed?.url ?? null, guess, repo: repo.repo, repoKnown: repo.known });

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pr == null || starting || target.problem) return;
    setStarting(true); setError(null);
    try {
      const r = await reviewApi.start(projectId, { workstream, pr, url: target.url });
      onStarted({ pr: r.pr, url: r.url, session: r.session });
      onClose();
    } catch (err) {
      setError(apiError(err, 'Could not start the review'));
      setStarting(false);
    }
  };

  return (
    <Sheet title={`Review a PR with Devin · ${projectName}${workstream !== 'main' ? ` · ${workstream}` : ''}`} onClose={() => { if (!starting) onClose(); }}>
      <form className="m-form" onSubmit={start}>
        {hasReview && (
          <p className="m-form-note" role="status">
            Devin is on {currentPr != null ? <strong>PR #{currentPr}</strong> : 'a review'} in this workstream now
            {onOpenCurrent && <> · <button type="button" className="m-link" onClick={onOpenCurrent} disabled={starting}>open it</button></>}.
            Starting another review replaces it.
          </p>
        )}
        <label className="m-field">
          <span className="m-field-label">Pull request{guessing && ' · guessing…'}</span>
          <input
            className="m-text" autoFocus autoCapitalize="off" autoCorrect="off" spellCheck={false}
            placeholder={guessing ? '…' : repo.repo || !repo.known ? '123 or a GitHub PR URL' : 'owner/repo#123 or a PR URL'}
            value={value} onChange={e => { setValue(e.target.value); touched.current = true; }} disabled={starting}
          />
        </label>
        <p className="m-form-note">
          {guessing ? 'Checking the branch, the agent pane and recent PR events…' : guessExplanation(guess, branch)}
          {!guessing && guess?.url && <> · <a className="m-link" href={guess.url} target="_blank" rel="noreferrer">open</a></>}
        </p>
        {!guessing && pr != null && target.repo && (
          <p className="m-form-note"><strong>{target.repo} #{pr}</strong>{target.title && <> — {target.title}</>}</p>
        )}
        {!guessing && target.mismatch && <p className="m-form-note">Not this workstream's repository ({target.mismatch}). Check it is the PR you mean.</p>}
        {!guessing && target.problem && <div className="m-form-error" role="alert">{target.problem}</div>}
        {!guessing && !guess && ghError && <p className="m-form-note">gh could not be asked: {ghError}</p>}
        {error && <div className="m-form-error" role="alert">{error}</div>}
        <button type="submit" className="m-primary" disabled={pr == null || starting || !!target.problem}>
          {reviewSubmitLabel({ pr, currentPr, hasReview, starting })}
        </button>
        <p className="m-form-note">
          Starts <code>devin</code> in a review pane next to the agent; it opens as a third tab.
        </p>
      </form>
    </Sheet>
  );
}
