// The review card: a review session's reviewer
// returns its findings in a ```review fence (chat/reviewCard.ts), which the
// chat draws here rather than as generative UI, because its Post is termag's
// own (PostReviewDialog.tsx). Its take, then what it would post, in tiers,
// ticked by default; each finding with a line opens Files changed there, where
// its inline comment shows as a draft. The verdict is GitHub's three. What was
// checked and found clean folds away. A follow-up round's card lists each of
// the user's comments against the new head, and the gates (FollowUpCard.tsx).
import React, { createContext, useContext, useEffect } from 'react';
import { Alert, Button, ButtonGroup, Checkbox, Disclosure, DisclosurePanel, Heading, ProgressBar, Text, ToggleButton, ToggleButtonGroup } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import type { CodeFence } from '../../chat/codeFence';
import { GenUiItemContext } from '../../chat/genui/SpecFence';
import { PlainCodeBlock } from '../../chat/Markdown';
import { readReviewFence, type ReviewDecision, type ReviewFindings, type ReviewTier } from '../../chat/reviewCard';
import { cardKey, isTicked, updateCard, useCardState } from '../../chat/reviewDrafts';
import { prShort, sameHead, type PostedRound } from '../../chat/reviews';
import { withCode } from './reviewText';

/** The review session a card belongs to (SdkChatView provides it). */
export interface ReviewCardSession {
  projectId: string;
  workstream: string;
  repo: string;
  number: number;
  /** Who a post goes out as (the PR pipeline's viewer). */
  viewer: string | null;
  /** Show Files changed at a finding's line (the side panel's Pull request tab). */
  showLine: () => void;
  /** Rendered for a findings card's foot: the post control (PostReviewDialog.tsx). */
  postSlot?: (review: ReviewFindings, key: string) => React.ReactNode;
  /** The PR's latest round posted from a card, as the server keeps it (pr_review_rounds); null for none. */
  posted?: PostedRound | null;
  /** Rendered for a follow-up card (FollowUpCard.tsx). */
  followUp?: (fence: Extract<ReturnType<typeof readReviewFence>, { kind: 'followup' }>) => React.ReactNode;
}
export const ReviewCardContext = createContext<ReviewCardSession | null>(null);

const TIER: Record<ReviewTier, string> = { 'blocks-merge': 'Blocks merge', 'blocks-flag': 'Blocks the flag', recommend: 'Recommend', question: 'Question' };
export const DECISION_WORD: Record<ReviewDecision, string> = { COMMENT: 'Comment', REQUEST_CHANGES: 'Request changes', APPROVE: 'Approve' };
const TAKE: Record<ReviewDecision, string> = { COMMENT: 'comment', REQUEST_CHANGES: 'request changes', APPROVE: 'approve' };

/** CodeFenceContext's renderer for a ```review fence; null for any other, so other renderers get it. */
export function renderReviewFence(block: CodeFence): React.ReactNode | null {
  if (block.lang !== 'review') return null;
  // A closed block without the card's shape is left to Markdown, which shows it as the code it is.
  if (!block.open && !readReviewFence(block.text)) return null;
  if (block.open) return <OpenReviewFence block={block} />;
  return <ReviewFenceView text={block.text} />;
}

/**
 * A fence not closed (yet): the card once its JSON is whole, since a reply can end without closing it; Writing the
 * review while the reply still streams (the SDK chat's GenUiItemContext); else, a finished reply, its code.
 */
function OpenReviewFence({ block }: { block: CodeFence }) {
  const { streaming } = useContext(GenUiItemContext);
  if (readReviewFence(block.text)) return <ReviewFenceView text={block.text} />;
  if (!streaming) return <PlainCodeBlock block={block} />;
  return (
    <div className="rv-card rv-card-writing" role="status">
      <ProgressBar variant="spinner" size="small" isIndeterminate aria-label="Writing the review" />
      Writing the review…
    </div>
  );
}

function ReviewFenceView({ text }: { text: string }) {
  const session = useContext(ReviewCardContext);
  const fence = readReviewFence(text);
  if (!fence) return null;
  // Without a review session to approve from (the PR list still loading, or the session not a review's), the
  // follow-up still shows what it found, read-only, as a findings card does.
  if (fence.kind === 'followup') return session?.followUp ? <>{session.followUp(fence)}</> : <FollowUpReadOnly fence={fence} />;
  if (!session) return <FindingsCard review={fence} cardId={null} session={null} />;
  return <FindingsCard review={fence} cardId={cardKey(session.projectId, session.workstream, fence.round, text)} session={session} />;
}

/** What a follow-up found: each posted comment and what the new head does about it, and anything new. */
export function FollowUpList({ fence }: { fence: Extract<ReturnType<typeof readReviewFence>, { kind: 'followup' }> }) {
  return (
    <ul className="rv-addressed">
      {fence.addressed.map(a => (
        <li key={a.title} data-fixed={a.fixed || undefined}>
          <Icon name={a.fixed ? 'check-circle' : 'warning'} size="medium" aria-hidden="true" className="rv-ok" />
          <span className="rv-finding-title">{a.title}</span>
          <p className="rv-why">{withCode(a.how)}</p>
        </li>
      ))}
      {fence.fresh.map(f => (
        <li key={f} data-fixed={undefined}><Icon name="warning" size="medium" aria-hidden="true" className="rv-ok" /><span className="rv-finding-title">New in the changed lines</span><p className="rv-why">{withCode(f)}</p></li>
      ))}
    </ul>
  );
}

function FollowUpReadOnly({ fence }: { fence: Extract<ReturnType<typeof readReviewFence>, { kind: 'followup' }> }) {
  return (
    <div className="rv-card">
      <CardHead label="This PR" round={fence.round} head={fence.head} />
      <h4 className="rv-sub">Your comments</h4>
      <FollowUpList fence={fence} />
      <p className="rv-note rv-pad">Approve from the PR's review session, where its gates are read.</p>
    </div>
  );
}

export function CardHead({ label, round, head, right }: { label: string; round: number; head: string; right?: React.ReactNode }) {
  return (
    <div className="rv-card-head">
      <Icon name="preview" size="medium" aria-hidden="true" />
      <span className="rv-card-title">Review</span>
      <span className="rv-card-meta">{label} · round {round}{head && <> · head <code>{head.slice(0, 7)}</code></>}</span>
      {right && <span className="rv-card-right">{right}</span>}
    </div>
  );
}

function FindingsCard({ review, cardId, session }: { review: ReviewFindings; cardId: string | null; session: ReviewCardSession | null }) {
  const local = useCardState(cardId);
  // Posted is the server's word (this round's record, the latest or an earlier one), else this browser's.
  // This card's head's round, not its number's: a reviewer may give round 1 again after a post.
  const mine = session?.posted ? [session.posted, ...(session.posted.earlier ?? [])].find(r => sameHead(r.headSha, review.head)) : undefined;
  const server = mine ? { event: mine.event, comments: mine.comments, at: mine.postedAt, url: null } : null;
  const state = server && !local.posted ? { ...local, posted: server } : local;
  // The card registers what the reviewer found, so the side panel's Files changed can draw the drafts.
  useEffect(() => {
    // Once per card: each fence has its own state, so no two cards write the same one.
    if (cardId && !local.findings) updateCard(cardId, { findings: review, registeredAt: Date.now() });
    if (cardId && server && !local.posted) updateCard(cardId, { posted: server });
  }, [cardId, review, local.findings, local.posted, server]);
  const decision = state.decision ?? review.verdict;
  const ticked = review.findings.filter(f => isTicked(state, f));
  const label = session ? prShort(session.repo, session.number) : 'This PR';
  return (
    <div className="rv-card">
      <CardHead label={label} round={review.round} head={review.head} right={`${ticked.length} of ${review.findings.length} ticked`} />
      <Alert status={review.verdict === 'REQUEST_CHANGES' ? 'warning' : review.verdict === 'APPROVE' ? 'success' : 'info'} className="rv-alert">
        <Text elementType="p"><strong>My take: {TAKE[review.verdict]}.</strong> {withCode(review.take)}</Text>
      </Alert>
      {review.findings.length > 0 && <h4 className="rv-sub">What I'd post</h4>}
      <ul className="rv-findings">
        {review.findings.map(f => {
          const on = isTicked(state, f);
          return (
            <li key={f.id} className="rv-finding" data-off={on ? undefined : ''} data-focus={state.focus === f.id ? '' : undefined}>
              <Checkbox isSelected={on} isDisabled={!cardId} onChange={v => cardId && updateCard(cardId, { ticks: { [f.id]: v } })} className="rv-check">
                <span className="rv-finding-title">{f.title}</span>
              </Checkbox>
              <span className="rv-tier" data-tier={f.tier}>{TIER[f.tier]}</span>
              <p className="rv-why">{withCode(f.why)}{f.ask && <> <span className="rv-ask">Ask: {withCode(f.ask)}</span></>}</p>
              {f.at && (
                <Button variant="minimal" size="small" className="rv-loc" isDisabled={!session}
                  onPress={() => { if (cardId) updateCard(cardId, { focus: f.id, focusAt: Date.now() }); session?.showLine(); }}>
                  <code>{f.at.path}:{f.at.line}</code>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {review.checked.length > 0 && (
        <Disclosure className="rv-checked">
          {({ isExpanded }) => (
            <>
              <Heading level={5} className="rv-checked-head">
                <Button slot="trigger" variant="minimal" size="small" className="rv-checked-trigger">
                  <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size="small" aria-hidden="true" />
                  What I checked<span className="rv-checked-sum">{review.checked.length} clean</span>
                </Button>
              </Heading>
              <DisclosurePanel>
                <ul className="rv-checked-list">{review.checked.map(c => <li key={c}><Icon name="check-circle" size="small" aria-hidden="true" />{withCode(c)}</li>)}</ul>
              </DisclosurePanel>
            </>
          )}
        </Disclosure>
      )}
      {cardId && state.posted && <div className="rv-foot">{session?.postSlot?.(review, cardId)}</div>}
      {cardId && !state.posted && (
        <div className="rv-foot">
          <div className="rv-foot-row">
            <ToggleButtonGroup aria-label="Verdict" appearance="elevated" selectionMode="single" disallowEmptySelection
              selectedKeys={new Set([decision])}
              onSelectionChange={keys => { const v = [...keys][0] as ReviewDecision | undefined; if (v) updateCard(cardId, { decision: v }); }}
              className="rv-verdict">
              <ToggleButton id="COMMENT" size="small">Comment</ToggleButton>
              <ToggleButton id="REQUEST_CHANGES" size="small">Request changes</ToggleButton>
              <ToggleButton id="APPROVE" size="small">Approve</ToggleButton>
            </ToggleButtonGroup>
            {session?.viewer && <span className="rv-as">Posts as {session.viewer}</span>}
          </div>
          {session?.postSlot ? session.postSlot(review, cardId) : (
            <ButtonGroup className="rv-actions">
              <Button variant="primary" isDisabled>Post review…</Button>
            </ButtonGroup>
          )}
        </div>
      )}
    </div>
  );
}
