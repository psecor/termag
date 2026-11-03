// Posting a review card: the user posts, never the
// reviewer. Post review… opens a confirm that names the verdict (Request
// changes is the destructive button), who it posts as and who is notified,
// the summary and every inline comment with its line, and whether to say it
// was drafted with Claude. It reads the PR's head first and refuses if the PR
// moved since the reviewer read it, then posts once, pinned to that head
// (POST /api/prs/:owner/:repo/:n/review with comments and commitId), so a push
// in between can't take the comments.
import React, { useState } from 'react';
import { Alert, Button, ButtonGroup, Checkbox, Dialog, Heading, Modal, ModalOverlay, Text } from '@launchpad-ui/components';
import { LP_THEME } from '../../launchpad/theme';
import { prsApi } from '../../services/api';
import { apiErrorText, PRS_CHANGED_EVENT } from '../../utils/prPipeline';
import { inlineOf, summaryOf, type ReviewDecision, type ReviewFindings } from '../../chat/reviewCard';
import { parsePatch, patchHasLine } from '../../chat/diff';
import { isTicked, updateCard, useCardState } from '../../chat/reviewDrafts';
import { prShort } from '../../chat/reviews';
import { DECISION_WORD } from './ReviewCard';
import { withCode } from './reviewText';

const CREDIT = 'Drafted with Claude in termag.';
const DONE: Record<ReviewDecision, string> = { COMMENT: 'Commented', REQUEST_CHANGES: 'Requested changes', APPROVE: 'Approved' };

export function PostControl({ review, cardId, repo, number, viewer, author }: {
  review: ReviewFindings; cardId: string; repo: string; number: number; viewer: string | null; author: string | null;
}) {
  const state = useCardState(cardId);
  const [open, setOpen] = useState(false);
  const decision = state.decision ?? review.verdict;
  const picked = review.findings.filter(f => isTicked(state, f));
  if (state.posted) {
    return (
      <Alert status="success" className="rv-alert rv-posted">
        <Text elementType="p">
          <strong>{DONE[state.posted.event]}</strong> with {state.posted.comments} {state.posted.comments === 1 ? 'comment' : 'comments'}, as {viewer ?? 'you'}.
          {' '}Waiting on {author ?? 'the author'}: a push or a reply brings this back.
          {state.posted.url && <> <a href={state.posted.url} target="_blank" rel="noopener noreferrer">See it on GitHub</a></>}
        </Text>
      </Alert>
    );
  }
  return (
    <>
      <ButtonGroup className="rv-actions">
        <Button variant="primary" isDisabled={picked.length === 0 && decision !== 'APPROVE' && !review.summary.trim()} onPress={() => setOpen(true)}>Post review…</Button>
      </ButtonGroup>
      {open && <PostDialog review={review} cardId={cardId} decision={decision} repo={repo} number={number} viewer={viewer} author={author} onClose={() => setOpen(false)} />}
    </>
  );
}

function PostDialog({ review, cardId, decision, repo, number, viewer, author, onClose }: {
  review: ReviewFindings; cardId: string; decision: ReviewDecision; repo: string; number: number; viewer: string | null; author: string | null; onClose: () => void;
}) {
  const state = useCardState(cardId);
  const [credit, setCredit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = review.findings.filter(f => isTicked(state, f));
  const inline = picked.map(inlineOf).filter((c): c is NonNullable<typeof c> => c !== null);
  const summary = summaryOf(review, f => isTicked(state, f), credit ? CREDIT : null);
  const byLine = new Map<string, number>();
  for (const c of inline) byLine.set(`${c.path}:${c.line}`, (byLine.get(`${c.path}:${c.line}`) ?? 0) + 1);

  const post = async () => {
    setBusy(true); setError(null);
    try {
      // Pin to the head the reviewer read: a push since means the comments may not apply.
      const pr = await prsApi.overview(repo, number);
      const head = pr.headSha ?? '';
      // Without case: the reviewer may write the SHA in capitals, GitHub gives it in lower case.
      if (review.head && head && !head.toLowerCase().startsWith(review.head.slice(0, 7).toLowerCase())) {
        setError(`${author ?? 'The author'} pushed since the reviewer read it (now ${head.slice(0, 7)}). Ask it to read the new head first.`);
        return;
      }
      // GitHub refuses a whole review when one comment's line isn't in the diff: those go in the summary instead,
      // and so does every comment when the diff couldn't be read to tell.
      const diff = await prsApi.files(repo, number).catch(() => null);
      // A renamed file's comment may name its old path: it posts on the path GitHub's diff has now. A file at that
      // path now (a rename and a new file in its place) is the one it names.
      const fileOf = (path: string) => diff?.files.find(x => x.path === path) ?? diff?.files.find(x => x.previousPath === path);
      const placeable = (c: { path: string; line: number }) => {
        const f = fileOf(c.path);
        return !!f && patchHasLine(parsePatch(f.patch), c.line);
      };
      const onLines = inline.filter(placeable);
      const offLines = inline.filter(c => !placeable(c));
      const written = offLines.length
        ? [summaryOf(review, f => isTicked(state, f), null), offLines.map(c => `- \`${c.path}:${c.line}\`: ${c.body}`).join('\n'), credit ? CREDIT : ''].filter(Boolean).join('\n\n')
        : summary;
      // GitHub needs a body with COMMENT and REQUEST_CHANGES, inline comments or not: with no summary, the
      // reviewer's take (the card's "My take"), else what's on the lines.
      const body = written.trim() || decision === 'APPROVE' ? written
        : review.take.trim() || `${onLines.length} ${onLines.length === 1 ? 'comment' : 'comments'} on the lines.`;
      const res = await prsApi.review(repo, number, decision, body, {
        comments: onLines.map(c => ({ path: fileOf(c.path)?.path ?? c.path, line: c.line, side: 'RIGHT', body: credit ? `${c.body}\n\n${CREDIT}` : c.body })),
        ...(head ? { commitId: head, title: pr.title, author: pr.author } : {}),
      });
      updateCard(cardId, { posted: { event: decision, comments: onLines.length, at: new Date().toISOString(), url: res.url } });
      window.dispatchEvent(new Event(PRS_CHANGED_EVENT));
      onClose();
    } catch (err) {
      setError(apiErrorText(err, 'GitHub refused the review'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalOverlay isOpen isDismissable={!busy} onOpenChange={open => { if (!open) onClose(); }} className={LP_THEME}>
      <Modal size="medium" className="rv-confirm">
        <Dialog role="alertdialog" className="rv-confirm-dialog">
          <Heading slot="title" level={2} size="medium">{DECISION_WORD[decision]} on {prShort(repo, number)}?</Heading>
          <Text elementType="p" slot="subtitle">
            This posts to GitHub as <strong>{viewer ?? 'you'}</strong>{author ? <>, and <strong>{author}</strong> is notified</> : null}.
          </Text>
          <ul className="rv-confirm-list">
            <li><span className="rv-confirm-k">Summary</span><span className="rv-confirm-v">{withCode(summary.split('\n\n')[0] || '(none)')}</span></li>
            {[...byLine.entries()].map(([at, n]) => (
              <li key={at}><span className="rv-confirm-k">Inline</span><span className="rv-confirm-v">{n} {n === 1 ? 'comment' : 'comments'} on <code>{at}</code></span></li>
            ))}
          </ul>
          <Checkbox isSelected={credit} onChange={setCredit} className="rv-confirm-credit">Say it was drafted with Claude</Checkbox>
          <p className="rv-confirm-fine">Adds “{CREDIT}” to the summary and each comment.</p>
          {error && <p className="rv-confirm-error" role="alert">{error}</p>}
          <ButtonGroup className="rv-confirm-buttons">
            <Button variant="minimal" onPress={onClose} isDisabled={busy}>Cancel</Button>
            <Button variant={decision === 'REQUEST_CHANGES' ? 'destructive' : 'primary'} autoFocus isDisabled={busy} onPress={() => { void post(); }}>
              {busy ? 'Posting…' : DECISION_WORD[decision]}
            </Button>
          </ButtonGroup>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
