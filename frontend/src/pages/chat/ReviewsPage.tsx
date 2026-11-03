// The Reviews page, at /chat/reviews: every PR
// that wants the user's review, from the lab's PR pipeline, ordered by what
// needs them: Your call (a reviewer is done and nothing is posted), Changed
// since your review, To review (asks you by name, with the lab's review groups
// as cards), Reviewing, Waiting on the author, and Asks your team. Deferred
// requests wait folded at the foot, and so do finished reviews (approved, or
// the PR merged or closed). Each section links the same list on GitHub.
// A row opens its review (a session, or the session whose review pane reads
// it), else the PR's page; Review on a row starts one (ReviewMenu.tsx).
import React, { startTransition, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, ButtonGroup, Disclosure, DisclosurePanel, Heading, IconButton, Menu, MenuItem, MenuTrigger, Popover, Text } from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { prsApi } from '../../services/api';
import { fmtAge } from '../../utils/format';
import { memberReview, memberBotReview } from '../../utils/prReviewGroups';
import { PRS_CHANGED_EVENT, rowParam } from '../../utils/prPipeline';
import { githubListUrl, leftToReview, prPath, prShort, SECTION_NAME, SECTION_ORDER, type QueueGroup, type QueueItem, type QueueSection } from '../../chat/reviews';
import { desktopPrHref } from '../../chat/desktopLinks';
import { ChatHistoryButton } from './chatChrome';
import { reviewHref, reviewLinkState } from './reviewLinks';
import { ReviewMenu } from './ReviewMenu';
import { useReviewsData } from './reviewsData';
import { StatusMark } from './StatusMark';
import { checkTheFixes, fixesAsked, useFixesAsks } from './FollowUpStrip';
import type { RowStateKind } from '../../chat/rowState';

const HINT: Partial<Record<QueueSection, string>> = {
  'your-call': 'A reviewer is done. Nothing has been posted.',
  pushed: 'The author pushed or asked again',
};

function markOf(it: QueueItem): RowStateKind {
  if (it.section === 'reviewing') return 'working';
  if (it.why.some(w => w.endsWith('needs an answer'))) return 'approval';
  if (it.section === 'your-call' || it.section === 'pushed') return 'unread';
  return 'done';
}

function changed() { window.dispatchEvent(new Event(PRS_CHANGED_EVENT)); }

function RowMore({ it }: { it: QueueItem }) {
  const deferable = it.row != null && (it.section === 'to-review' || it.section === 'team');
  return (
    <MenuTrigger>
      <IconButton icon="more-horiz" variant="minimal" size="small" aria-label={`${prShort(it.repo, it.number)}: more`} className="rv-row-more" />
      <Popover placement="bottom end" className={`${LP_THEME} chat-menu-popover`}>
        <Menu aria-label="More" onAction={key => {
          if (key === 'defer' && it.row) void prsApi.defer(rowParam(it.row), 1).then(changed);
          if (key === 'github' && it.url) window.open(it.url, '_blank', 'noopener');
        }} disabledKeys={deferable ? [] : ['defer']}>
          <MenuItem id="defer" textValue="Defer a day">
            <Icon name="clock" size="medium" aria-hidden="true" />
            <Text slot="label">Defer a day</Text>
            <Text slot="description">It leaves the list and the count until tomorrow</Text>
          </MenuItem>
          <MenuItem id="github" textValue="Open on GitHub">
            <Icon name="link-external" size="medium" aria-hidden="true" />
            <Text slot="label">Open on GitHub</Text>
          </MenuItem>
          <MenuItem id="desktop" textValue="Open in termag desktop" href={desktopPrHref(it.repo, it.number)}>
            <Icon name="device-desktop" size="medium" aria-hidden="true" />
            <Text slot="label">Open in termag desktop</Text>
            <Text slot="description">Its thread there, or a checkout of it to review</Text>
          </MenuItem>
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

/** Check the fixes from the queue: the session reads the new head, and opens. */
function CheckFixes({ it }: { it: QueueItem }) {
  const navigate = useNavigate();
  return (
    <Button size="small" variant="primary" onPress={() => { void checkTheFixes(it); startTransition(() => navigate(reviewHref(it), { state: reviewLinkState(it) })); }}>
      Check the fixes
    </Button>
  );
}

function Row({ it, now }: { it: QueueItem; now: number }) {
  useFixesAsks();
  const age = it.at ? fmtAge(Math.max(0, now - Date.parse(it.at))) : null;
  return (
    <li className="rv-row-li">
      <Link to={reviewHref(it)} state={reviewLinkState(it)} className="rv-row" data-section={it.section}>
        <StatusMark kind={markOf(it)} />
        <span className="rv-row-top">
          <span className="rv-row-num">{prShort(it.repo, it.number)}</span>
          <span className="rv-row-title">{it.title}</span>
        </span>
        <span className="rv-row-line">
          {it.why.map((part, n) => <React.Fragment key={`${n}-${part}`}>{n > 0 && <span className="rv-dot" aria-hidden="true">·</span>}<span>{part}</span></React.Fragment>)}
          {age && <><span className="rv-dot" aria-hidden="true">·</span><span>{age}</span></>}
        </span>
      </Link>
      <span className="rv-row-end">
        {(it.section === 'to-review' || it.section === 'team') && <ReviewMenu repo={it.repo} number={it.number} row={it.row} size="small" />}
        {it.section === 'pushed' && it.session && it.round?.now?.headSha && !fixesAsked(it) && <CheckFixes it={it} />}
        <RowMore it={it} />
      </span>
    </li>
  );
}

function GroupCard({ g, viewer, now }: { g: QueueGroup; viewer: string | null; now: number }) {
  const navigate = useNavigate();
  const next = leftToReview(g.group, viewer)[0] ?? null;
  const none = g.group.members.filter(m => m.state === 'open' && memberReview(m, viewer)?.kind === 'none').length;
  return (
    <li className="rv-group">
      <div className="rv-group-head">
        <span className="rv-group-name">{g.group.name}</span>
        <span className="rv-group-meta">
          {g.group.members.length} PRs · {g.left} of {g.group.members.length} to review{none ? ` · no review yet on ${none}` : ''}
        </span>
      </div>
      <ol className="rv-group-list">
        {g.group.members.map((m, n) => {
          const review = memberReview(m, viewer);
          const bot = memberBotReview(m);
          const state = m.checked ? 'done' : next && next.repo === m.repo && next.number === m.number ? 'next' : 'todo';
          return (
            <li key={`${m.repo}#${m.number}`} data-state={state}>
              <span className="rv-group-mark" aria-hidden="true">
                {state === 'done' ? <Icon name="check-circle" size="small" /> : state === 'next' ? <Icon name="chevron-right" size="small" /> : null}
              </span>
              <span className="rv-group-n">{n + 1}</span>
              <Link to={prPath(m.repo, m.number)} className="rv-row-num rv-group-link">{prShort(m.repo, m.number)}</Link>
              <span className="rv-group-title" title={m.note ?? undefined}>{m.title}</span>
              <span className="rv-group-pills">
                {review && <span className="rv-pill" data-tone={review.kind === 'approved' ? 'ok' : review.kind === 'changes' ? 'warn' : 'neutral'} title={review.title}>{review.label}</span>}
                {bot && <span className="rv-pill" data-dashed="" title={bot.title}>{bot.label}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <ButtonGroup className="rv-group-actions">
        <Button size="small" variant="default" isDisabled={!next} onPress={() => next && startTransition(() => navigate(prPath(next.repo, next.number)))}>Review next</Button>
        <ReviewMenu group={g.group} size="small" label="Review all together" />
      </ButtonGroup>
      <span className="chat-sr">{fmtAge(Math.max(0, now - Date.parse(g.group.createdAt)))} old</span>
    </li>
  );
}

export function ReviewsPage() {
  const { queue, loading, failed, prs, refresh } = useReviewsData();
  const now = Date.now();
  const [showTeam, setShowTeam] = useState(true);
  const disconnected = prs !== null && !prs.connected;
  return (
    <div className="chat-view">
      <section className="chat-conv rv-page">
        <header className="chat-header">
          <ChatHistoryButton />
          <div className="chat-title"><Icon name="preview" size="medium" aria-hidden="true" className="rv-title-icon" /><span className="chat-title-name">Reviews</span></div>
          <div className="chat-header-actions">
            <ReviewMenu defaults size="small" />
          </div>
        </header>
        <div className="chat-transcript">
          <div className="rv-queue">
            {loading && <p className="rv-note">Reading your review requests from GitHub…</p>}
            {disconnected && <p className="rv-note">Connect GitHub in Settings to see the PRs that ask for your review.</p>}
            {failed && !loading && (
              <p className="rv-note">
                Couldn't read your review requests from GitHub.{' '}
                <Button size="small" variant="minimal" onPress={refresh}>Try again</Button>
              </p>
            )}
            {!loading && !failed && !disconnected && queue.items.length === 0 && queue.groups.length === 0 && (
              <p className="rv-note">Nothing asks for your review right now.</p>
            )}
            {SECTION_ORDER.map(s => {
              const items = queue.items.filter(i => i.section === s);
              const groups = s === 'to-review' ? queue.groups : [];
              if (items.length === 0 && groups.length === 0) return null;
              const gh = githubListUrl(s);
              const folded = s === 'team' && !showTeam;
              return (
                <section key={s} className="rv-section" aria-label={SECTION_NAME[s]}>
                  <h2 className="rv-section-head">
                    {s === 'team'
                      ? <button type="button" className="rv-fold" aria-expanded={!folded} onClick={() => setShowTeam(v => !v)}>
                          <Icon name={folded ? 'chevron-right' : 'chevron-down'} size="small" aria-hidden="true" />{SECTION_NAME[s]}
                        </button>
                      : SECTION_NAME[s]}
                    <span className="rv-count">{items.length + groups.length}</span>
                    {HINT[s] && <span className="rv-section-hint">{HINT[s]}</span>}
                    {gh && <a className="rv-section-gh" href={gh} target="_blank" rel="noopener noreferrer" title="The same list on GitHub">GitHub<Icon name="link-external" size="small" aria-hidden="true" /></a>}
                  </h2>
                  {!folded && (
                    <ul className="rv-rows">
                      {groups.map(g => <GroupCard key={g.group.id} g={g} viewer={queue.viewer} now={now} />)}
                      {items.map(it => <Row key={it.key} it={it} now={now} />)}
                    </ul>
                  )}
                </section>
              );
            })}
            {queue.deferred.length > 0 && (
              <Disclosure className="rv-deferred">
                {({ isExpanded }) => (
                  <>
                    <Heading level={3} className="rv-deferred-head">
                      <Button slot="trigger" variant="minimal" size="small">
                        <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size="small" aria-hidden="true" />
                        Deferred <span className="rv-count">{queue.deferred.length}</span>
                      </Button>
                    </Heading>
                    <DisclosurePanel>
                      <ul className="rv-rows">
                        {queue.deferred.map(it => (
                          <li key={it.key} className="rv-row-li rv-row-deferred">
                            <Link to={prPath(it.repo, it.number)} className="rv-row">
                              <StatusMark kind="done" />
                              <span className="rv-row-top"><span className="rv-row-num">{prShort(it.repo, it.number)}</span><span className="rv-row-title">{it.title}</span></span>
                              <span className="rv-row-line"><span>back in {fmtAge(Math.max(0, (it.deferredUntil ?? now) - now))}</span></span>
                            </Link>
                            <span className="rv-row-end">
                              <Button size="small" variant="minimal" onPress={() => it.row && void prsApi.undefer(rowParam(it.row)).then(changed)}>Bring back</Button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </DisclosurePanel>
                  </>
                )}
              </Disclosure>
            )}
            {queue.reviewed.length > 0 && (
              <Disclosure className="rv-deferred">
                {({ isExpanded }) => (
                  <>
                    <Heading level={3} className="rv-deferred-head">
                      <Button slot="trigger" variant="minimal" size="small">
                        <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size="small" aria-hidden="true" />
                        Reviewed <span className="rv-count">{queue.reviewed.length}</span>
                      </Button>
                    </Heading>
                    <DisclosurePanel>
                      <ul className="rv-rows">{queue.reviewed.map(it => <Row key={it.key} it={it} now={now} />)}</ul>
                    </DisclosurePanel>
                  </>
                )}
              </Disclosure>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
