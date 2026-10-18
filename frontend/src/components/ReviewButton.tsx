import React, { useEffect, useRef, useState } from 'react';
import { reviewApi, type ReviewGuessResponse } from '../services/api';
import { guessExplanation, MAX_REVIEW_BODY, parsePrInputFull, renderReviewTemplate, reviewPromptHeader, reviewTargetView, type PrGuess } from '../utils/review';
import { Dialog } from './Dialog';

interface Props {
  projectId: string;
  workstream: string;
  /** A review pane is already alive for this workstream: starting replaces it. */
  hasReview: boolean;
  onStarted: (r: { pr: number; url: string | null; session: string; reviewer?: string }) => void;
}

/**
 * "Review" — the overlay button in the lower-right of the agent pane. Click:
 * a small dialog guesses which PR the agent is working on (the current
 * branch's PR via gh, else the PR the agent just opened, else the last PR
 * mentioned in its pane), prefills it, and lets you retype or confirm. The
 * dialog names the repository the PR is in (the workstream's GitHub remote
 * unless a URL or owner/repo#N says otherwise) and refuses a bare number in a
 * directory without one: the reviewer would have to guess. Start
 * launches Devin with a review prompt in the project's `review` tmux session;
 * the dock under the ctrl pane shows it (ReviewDock). "Edit prompt" shows the
 * whole prompt: a fixed line naming the PR, the template body, which can be
 * edited for this one review, and a fixed line asking the reviewer to sign
 * anything it posts as the user (every dialog starts from the template again).
 */
/** Does the text name this PR number (not as part of a longer number)? */
function namesPr(body: string, pr: number): boolean {
  return new RegExp(`(^|\\D)${pr}(\\D|$)`).test(body);
}

type Reviewer = NonNullable<ReviewGuessResponse['reviewers']>[number];

// The last reviewer picked, per browser: a dialog opens on it next time.
const REVIEWER_KEY = 'termag.review.reviewer';
function storedReviewer(): string | null {
  try { return localStorage.getItem(REVIEWER_KEY); } catch { return null; }
}
function storeReviewer(id: string): void {
  try { localStorage.setItem(REVIEWER_KEY, id); } catch { /* private mode */ }
}

export function ReviewButton({ projectId, workstream, hasReview, onStarted }: Props) {
  const [open, setOpen] = useState(false);
  const [guessing, setGuessing] = useState(false);
  const [guess, setGuess] = useState<PrGuess | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);
  const [repo, setRepo] = useState<{ repo: string | null; known: boolean }>({ repo: null, known: false });
  const [value, setValue] = useState('');
  // A ref, not state: the guess effect reads it when the result lands, which
  // can be after the user started typing; a state value captured when the
  // dialog opened would still be false and the prefill would clobber them.
  const touchedRef = useRef(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [promptTemplate, setPromptTemplate] = useState<string | null>(null);
  const [promptFooter, setPromptFooter] = useState<string | null>(null);
  // Empty when the backend predates the picker: it then always starts Devin.
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [reviewerId, setReviewerId] = useState<string | null>(null);
  const [promptSource, setPromptSource] = useState<{ source: string; label: string | null; warnings: string[] } | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  // null = not edited: the textarea follows the template for whichever PR is typed.
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  // The PR the template was filled in for when the user started editing: an
  // edit freezes that number into the text, and retyping the PR does not follow.
  const [draftPr, setDraftPr] = useState<number | null>(null);

  // Guess when the dialog opens. A prefill never overwrites what the user typed.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setGuessing(true); setGuess(null); setBranch(null); setGhError(null); setRepo({ repo: null, known: false }); setError(null); setPromptTemplate(null); setPromptFooter(null); setPromptSource(null);
    reviewApi.guess(projectId, workstream)
      .then(r => {
        if (cancelled) return;
        setGuess(r.guess); setBranch(r.branch); setGhError(r.ghError); setRepo({ repo: r.repo ?? null, known: r.repoKnown === true }); setPromptTemplate(r.promptTemplate ?? null); setPromptFooter(r.promptFooter ?? null);
        setPromptSource({ source: r.promptSource ?? 'builtin', label: r.promptSourceLabel ?? null, warnings: r.promptWarnings ?? [] });
        const list = r.reviewers ?? [];
        setReviewers(list);
        const stored = storedReviewer();
        setReviewerId(list.some(x => x.id === stored) ? stored : (r.defaultReviewer ?? list[0]?.id ?? null));
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

  const reset = () => { setValue(''); touchedRef.current = false; setError(null); setShowPrompt(false); setPromptDraft(null); setDraftPr(null); };
  const close = () => { if (starting) return; setOpen(false); reset(); };

  const parsed = parsePrInputFull(value);
  const pr = parsed?.number ?? null;
  const target = reviewTargetView({ pr, typedUrl: parsed?.url ?? null, guess, repo: repo.repo, repoKnown: repo.known });
  const prUrl = target.url;
  const promptBody = promptDraft ?? (promptTemplate != null ? renderReviewTemplate(promptTemplate, pr, prUrl) : '');
  const promptInvalid = promptDraft != null && (!promptDraft.trim() || promptDraft.length > MAX_REVIEW_BODY);
  const canStart = pr != null && !starting && !promptInvalid && !target.problem;
  const reviewer = reviewers.find(x => x.id === reviewerId) ?? null;
  const reviewerLabel = reviewer?.name ?? 'Devin';
  const footer = reviewer?.footer ?? promptFooter;

  const start = async () => {
    if (!canStart || pr == null) return;
    setStarting(true); setError(null);
    try {
      // An unedited prompt is not sent: the backend applies the same template.
      const r = await reviewApi.start(projectId, {
        workstream, pr, url: prUrl,
        ...(promptDraft != null ? { prompt: promptDraft } : {}),
        ...(reviewer ? { reviewer: reviewer.id } : {}),
      });
      if (reviewer) storeReviewer(reviewer.id);
      onStarted({ pr: r.pr, url: r.url, session: r.session, reviewer: r.reviewer ?? reviewer?.id });
      setStarting(false);
      setOpen(false); reset();
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
        title="Review the PR being worked on"
        onClick={() => setOpen(true)}
      >
        Review
      </button>
      {open && (
        <Dialog
          title={<>Review a pull request with {reviewerLabel}</>}
          className={`review-dialog${showPrompt ? ' review-dialog--wide' : ''}`}
          onClose={close}
        >
          <form onSubmit={e => { e.preventDefault(); void start(); }}>
            <div className="npf-field">
              <label htmlFor="review-pr-input">
                Pull request{guessing && <span className="review-dialog-guessing"> · guessing…</span>}
              </label>
              <input
                id="review-pr-input"
                ref={inputRef}
                value={value}
                placeholder={guessing ? '…' : repo.repo || !repo.known ? '123 or a PR URL' : 'owner/repo#123 or a PR URL'}
                onChange={e => { setValue(e.target.value); touchedRef.current = true; }}
                autoComplete="off"
                spellCheck={false}
                disabled={starting}
              />
            </div>
            <div className="review-dialog-hint">
              {guessing ? 'Checking the branch, the agent pane and recent PR events…' : guessExplanation(guess, branch)}
              {!guessing && guess?.url && (
                <> · <a href={guess.url} target="_blank" rel="noreferrer">open</a></>
              )}
            </div>
            {!guessing && pr != null && target.repo && (
              <div className="review-dialog-target">
                <a href={target.url!} target="_blank" rel="noreferrer">{target.repo} #{pr}</a>
                {target.title && <> — {target.title}</>}
              </div>
            )}
            {!guessing && target.mismatch && (
              <div className="review-dialog-hint review-dialog-warning">
                Not this workstream's repository ({target.mismatch}). Check it is the PR you mean.
              </div>
            )}
            {!guessing && target.problem && <div className="review-dialog-error">{target.problem}</div>}
            {!guessing && !guess && ghError && (
              <div className="review-dialog-hint review-dialog-hint--muted" title={ghError}>gh could not be asked: {ghError}</div>
            )}
            {reviewers.length > 1 && (
              <div className="npf-field review-dialog-reviewer">
                <label htmlFor="review-reviewer">Reviewer</label>
                <select
                  id="review-reviewer"
                  value={reviewerId ?? ''}
                  onChange={e => setReviewerId(e.target.value)}
                  disabled={starting}
                >
                  {reviewers.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </div>
            )}
            {promptTemplate != null && (
              <div className="review-dialog-prompt">
                <div className="review-dialog-prompt-bar">
                  <button
                    type="button"
                    className="review-dialog-link"
                    aria-expanded={showPrompt}
                    onClick={() => setShowPrompt(v => !v)}
                  >
                    {showPrompt ? '▾' : '▸'} {promptDraft != null ? 'Edit prompt (edited)' : 'Edit prompt'}
                  </button>
                  {showPrompt && promptDraft != null && (
                    <button type="button" className="review-dialog-link" onClick={() => { setPromptDraft(null); setDraftPr(null); }} disabled={starting}>
                      Reset
                    </button>
                  )}
                </div>
                {showPrompt && (promptSource?.label || !!promptSource?.warnings.length) && (
                  <div className="review-dialog-hint review-dialog-prompt-source">
                    {promptSource.label && <>Template: <code>{promptSource.label}</code></>}
                    {/* The repo file is read from the checkout under review: a PR can change it. */}
                    {promptSource.source === 'repo' && ' (from the checked-out branch; read it before starting)'}
                    {promptSource.warnings.map(w => <div key={w} className="review-dialog-error">Skipped {w}</div>)}
                  </div>
                )}
                {showPrompt && (
                  <>
                    {/* Mirrors reviewPromptHeader in backend/src/services/review.ts; not editable. */}
                    <div className="review-dialog-prompt-header">{reviewPromptHeader(pr, prUrl)}</div>
                    <textarea
                      className={`review-dialog-textarea${footer ? ' review-dialog-textarea--mid' : ''}`}
                      value={promptBody}
                      onChange={e => { if (promptDraft == null) setDraftPr(pr); setPromptDraft(e.target.value); }}
                      rows={8}
                      spellCheck={false}
                      disabled={starting}
                      aria-label="Review prompt"
                    />
                    {footer && (
                      <div className="review-dialog-prompt-header review-dialog-prompt-footer">{footer}</div>
                    )}
                    {promptDraft != null && !promptDraft.trim() && (
                      <div className="review-dialog-error">The prompt is empty.</div>
                    )}
                    {promptDraft != null && draftPr != null && pr != null && pr !== draftPr && namesPr(promptDraft, draftPr) && (
                      <div className="review-dialog-hint">The edited prompt still names PR #{draftPr}. Reset refills it for #{pr}.</div>
                    )}
                    {promptBody.length > MAX_REVIEW_BODY * 0.9 && (
                      <div className={promptBody.length > MAX_REVIEW_BODY ? 'review-dialog-error' : 'review-dialog-hint'}>
                        {promptBody.length} / {MAX_REVIEW_BODY} characters
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
            <div className="review-dialog-note">
              Starts {reviewerLabel} in a review pane under the ctrl terminal{reviewer ? <>, in {reviewer.note}</> : ''}.
              {hasReview && ' The running review is replaced.'}
            </div>
            {error && <div className="review-dialog-error">{error}</div>}
            <div className="confirm-actions">
              <button type="button" className="confirm-btn confirm-btn-cancel" onClick={close} disabled={starting}>Cancel</button>
              <button type="submit" className="confirm-btn confirm-btn-primary" disabled={!canStart}>
                {starting ? 'Starting…' : pr != null ? `Review PR #${pr}` : 'Review'}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
