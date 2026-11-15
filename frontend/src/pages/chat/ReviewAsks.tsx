// The sidebar redesign's way into reviews (user-projects-enabled), all LaunchPad: the
// blue "Review N pull requests" row, a call to action counting only the PRs that ask for your review and that you
// haven't started (chat/reviews.ts reviewAsks), with the requesters' avatars (LaunchPad's InitialsAvatar: their
// initials, no image from GitHub); and with none asking, a Reviews button beside New session, so reviews always have
// a way in. A started review is an ordinary card in its project (SessionCard.tsx's review mark), so the old
// Reviews section's list is gone under the flag.
import React from 'react';
import { InitialsAvatar, LinkButton, Tooltip, TooltipTrigger } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { loginInitials } from '../../chat/reviews';
import { AppRouter } from './SidebarChrome';

const AVATARS_SHOWN = 3;

export function ReviewAsksRow({ count, requesters }: { count: number; requesters: readonly string[] }) {
  const words = `Review ${count} pull ${count === 1 ? 'request' : 'requests'}`;
  const who = requesters.length ? `Asked by ${requesters.join(', ')}` : words;
  const shown = requesters.slice(0, AVATARS_SHOWN);
  return (
    <AppRouter>
      <div className={`${LP_THEME} sb-reviews`}>
        <LinkButton href="/chat/reviews" variant="minimal" className="sb-reviews-row" aria-label={`${words}. ${who}`} data-tip={who}>
          <Icon name="preview" size="medium" aria-hidden="true" />
          {/* The short words where the sidebar is narrow (sessionCard.css), so neither is cut short. */}
          <span className="sb-reviews-label" aria-hidden="true">
            <span className="sb-reviews-long">{words}</span>
            <span className="sb-reviews-short">Review {count} {count === 1 ? 'PR' : 'PRs'}</span>
          </span>
          {shown.length > 0 && (
            <span className="sb-reviews-who" aria-hidden="true">
              {shown.map(login => <InitialsAvatar key={login} size="small" className="sb-reviews-ava">{loginInitials(login)}</InitialsAvatar>)}
              {requesters.length > AVATARS_SHOWN && <span className="sb-reviews-more">+{requesters.length - AVATARS_SHOWN}</span>}
            </span>
          )}
        </LinkButton>
      </div>
    </AppRouter>
  );
}

/** Beside New session while nothing asks for your review: the Reviews page, with your team's PRs and the repositories you follow. */
export function ReviewsButton() {
  return (
    <AppRouter>
      <TooltipTrigger delay={300}>
        <LinkButton href="/chat/reviews" variant="minimal" className="sb-reviews-button" aria-label="Reviews">
          <Icon name="preview" size="medium" aria-hidden="true" />
        </LinkButton>
        <Tooltip placement="bottom" className={LP_THEME}>Reviews</Tooltip>
      </TooltipTrigger>
    </AppRouter>
  );
}
