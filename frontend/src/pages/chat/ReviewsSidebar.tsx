// The sidebar's Reviews section, above the
// spaces: the reviews that need the user (Your call, Changed since your
// review), the ones being read, and every review session, with the marks every
// session row has (blue when it's your call, the spinner while a reviewer
// reads, amber when it needs an answer). Its head opens the Reviews page and
// counts what needs you plus what asks you by name; "N to review" goes there
// too. A review session lives here, not in its space.
import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Icon } from '@launchpad-ui/icons';
import { NEEDS_YOU, prShort, sidebarItems, type QueueItem, type ReviewQueue } from '../../chat/reviews';
import type { RowStateKind } from '../../chat/rowState';
import { reviewHref, reviewLinkState } from './reviewLinks';
import { useReviewsData } from './reviewsData';
import { StatusMark } from './StatusMark';
import { myReviewCount } from '../../utils/prPipeline';
import type { PrPipelineResponse } from '../../services/api';

function markOf(it: QueueItem): RowStateKind {
  if (it.section === 'reviewing') return 'working';
  if (it.why.some(w => w.endsWith('needs an answer'))) return 'approval';
  // A review session waiting on the author, or not started yet, has nothing new.
  return NEEDS_YOU.includes(it.section) ? 'unread' : 'done';
}

/** The row for the page you're on: the same path and the same workstream (none is main), not a prefix of it. */
export function sameLink(here: string, to: string): boolean {
  const a = new URL(here, 'http://termag.local');
  const b = new URL(to, 'http://termag.local');
  return a.pathname === b.pathname && (a.searchParams.get('ws') ?? 'main') === (b.searchParams.get('ws') ?? 'main');
}

/**
 * The section's count: what needs you, plus the lab's own count of requests that name you, not deferred (grouped
 * ones too), less what the queue has elsewhere. A PR asked again after your review is counted once, in what needs
 * you; one you reviewed (Waiting on the author, or Reviewed) not at all, though GitHub often keeps its request.
 */
export function sidebarCount(queue: ReviewQueue, prs: PrPipelineResponse | null, now: number): { count: number; toReview: number } {
  const elsewhere = new Set([...queue.items.filter(i => NEEDS_YOU.includes(i.section) || i.section === 'waiting'), ...queue.reviewed]
    .map(i => `${i.repo.toLowerCase()}#${i.number}`));
  const toReview = myReviewCount(prs, now, r => !elsewhere.has(`${(r.repo ?? '').toLowerCase()}#${r.number}`));
  return { count: queue.needYou + toReview, toReview };
}

export function ReviewsSidebar() {
  const { queue, prs, more } = useReviewsData();
  const { pathname, search } = useLocation();
  const here = `${pathname}${search}`;
  // Every review session lives here: the queue's, and the ones it doesn't list (reviewsData moreReviewSessions).
  const shown = [...sidebarItems(queue), ...more];
  const { count, toReview } = sidebarCount(queue, prs, Date.now());
  const onPage = pathname === '/chat/reviews';
  return (
    <ul className="chat-list chat-items rv-side" aria-label="Reviews">
      <li className="chat-group" data-group="reviews">
        <div className="chat-group-head">
          <Link to="/chat/reviews" className="chat-group-toggle rv-side-head" aria-current={onPage ? 'page' : undefined}>
            <Icon name="preview" size="small" aria-hidden="true" className="rv-side-icon" />
            <span className="chat-group-name">Reviews</span>
            {count > 0 && <span className="chat-group-count" aria-label={`${count} for you`}>{count}</span>}
          </Link>
        </div>
        <ul className="chat-group-list">
          {shown.map(i => {
            const to = reviewHref(i);
            const active = to !== '/chat/reviews' && sameLink(here, to);
            return (
              <li key={i.key} className="chat-item-li">
                <Link to={to} state={reviewLinkState(i)} className={`chat-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} data-kind="chat"
                  data-tip={`${prShort(i.repo, i.number)} ${i.title}\n${i.why.join(' · ')}`}>
                  <StatusMark kind={markOf(i)} />
                  <span className="chat-item-name"><span className="rv-side-num">{prShort(i.repo, i.number)}</span> {i.title}</span>
                </Link>
              </li>
            );
          })}
          {toReview > 0 && (
            <li className="chat-item-li">
              <Link to="/chat/reviews" className="chat-item rv-side-more">
                <span className="chat-status-mark" aria-hidden="true" />
                <span className="chat-item-name">{toReview} to review</span>
              </Link>
            </li>
          )}
        </ul>
      </li>
    </ul>
  );
}

