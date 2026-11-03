// A PR's Conversation tab in the simple UI, laid
// out as GitHub lays out its own: the title and state, then the description
// as the author's first comment, the files it changes and what you can do
// (review, or merge your own), with who reviews it, its checks and its merge
// state in a sidebar beside them. A container narrower than the sidebar wants
// (the side panel beside a review session) stacks the sidebar above the rest.
// The description and comments are GitHub's markdown through the chat's own
// renderer (chat/Markdown.tsx): no HTML is interpreted and no image loaded.
import React from 'react';
import { Button } from '@launchpad-ui/components';
import { Icon, type IconName } from '@launchpad-ui/icons';
import type { PrOverview, PrRow } from '../../services/api';
import { Markdown } from '../../chat/Markdown';
import { prDescription } from '../../utils/prDescription';
import { checksSummary, reviewStateLabel, reviewerRoster, type RosterEntry } from '../../utils/prPipeline';
import { CHANGE_GLYPH, PrActions, ago } from '../dashboard/PrOverviewDialog';
import { initials } from './reviewText';

/** The files listed under the description; Files changed has them all. */
const FILES_SHOWN = 8;

type PrState = 'open' | 'draft' | 'merged' | 'closed';
const STATE: Record<PrState, { label: string; icon: IconName }> = {
  open: { label: 'Open', icon: 'circle-outline' },
  draft: { label: 'Draft', icon: 'circle-dashed' },
  merged: { label: 'Merged', icon: 'arrow-merge' },
  closed: { label: 'Closed', icon: 'cancel-circle-outline' },
};

export function prState(pr: Pick<PrOverview, 'state' | 'isDraft'>): PrState {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  return pr.isDraft ? 'draft' : 'open';
}

/** A reviewer's mark in the sidebar: what they answered, or that they're still asked. */
const REVIEWER_MARK: Record<string, { icon: IconName; tone: string }> = {
  APPROVED: { icon: 'check-circle', tone: 'ok' },
  CHANGES_REQUESTED: { icon: 'cancel-circle', tone: 'bad' },
  COMMENTED: { icon: 'chat-bubble-outline', tone: 'quiet' },
  DISMISSED: { icon: 'minus-circle-outline', tone: 'quiet' },
  REQUESTED: { icon: 'clock', tone: 'wait' },
};

function Reviewer({ e }: { e: RosterEntry }) {
  const mark = REVIEWER_MARK[e.state] ?? REVIEWER_MARK.COMMENTED;
  return (
    <li className="prc-person">
      <span className="rv-comment-av" aria-hidden="true">{e.kind === 'team' ? <Icon name="person" size="small" /> : initials(e.name)}</span>
      <span className="prc-person-name">{e.kind === 'team' ? `team ${e.name}` : e.name}</span>
      <span className="prc-mark" data-tone={mark.tone} title={e.pending ? 'asked, not answered yet' : reviewStateLabel(e.state)}>
        <Icon name={mark.icon} size="small" aria-hidden="true" />
        <span className="prc-sr">{e.pending ? 'asked, not answered yet' : reviewStateLabel(e.state)}</span>
      </span>
    </li>
  );
}

/**
 * Where an open PR stands for merging, as GitHub reads it for anyone (mergeable, mergeStateStatus), not only
 * for its author: the merge panel's own readiness needs the merge settings GitHub gives a viewer who can merge.
 */
export function mergeLine(pr: Pick<PrOverview, 'state' | 'isDraft' | 'mergeable' | 'mergeStateStatus' | 'autoMerge'>): { tone: string; icon: IconName; text: string } | null {
  if (pr.state !== 'OPEN') return null;
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return { tone: 'bad', icon: 'cancel-circle', text: 'Merge conflict with the base branch' };
  if (pr.isDraft || pr.mergeStateStatus === 'DRAFT') return { tone: 'quiet', icon: 'circle-dashed', text: 'Draft: not ready for review' };
  const auto = pr.autoMerge ? ' Auto-merge is on.' : '';
  switch (pr.mergeStateStatus) {
    case 'CLEAN': case 'HAS_HOOKS': return { tone: 'ok', icon: 'check-circle', text: `Ready to merge.${auto}` };
    case 'UNSTABLE': return { tone: 'wait', icon: 'clock-alert', text: `Mergeable, with failing checks that aren't required.${auto}` };
    case 'BEHIND': return { tone: 'wait', icon: 'clock-alert', text: `Behind its base branch.${auto}` };
    case 'BLOCKED': return { tone: 'wait', icon: 'clock', text: `Blocked until its required reviews and checks pass.${auto}` };
    default: return pr.autoMerge ? { tone: 'ok', icon: 'check-circle', text: 'Auto-merge is on.' } : null;
  }
}

function Sidebar({ pr, url }: { pr: PrOverview; url: string | null }) {
  const roster = reviewerRoster(pr);
  const checks = checksSummary(pr.checks);
  const merge = mergeLine(pr);
  return (
    <aside className="prc-side" aria-label="About this pull request">
      <section className="prc-side-sec">
        <h3 className="prc-side-head">Reviewers</h3>
        {roster.length
          ? <ul className="prc-people">{roster.map(e => <Reviewer key={`${e.kind}:${e.name}`} e={e} />)}</ul>
          : <p className="prc-quiet">No reviews yet</p>}
      </section>
      <section className="prc-side-sec">
        <h3 className="prc-side-head">Checks</h3>
        <p className="prc-line" data-tone={checks.tone === 'good' ? 'ok' : checks.tone === 'bad' ? 'bad' : 'wait'}>
          <Icon name={checks.tone === 'good' ? 'check-circle' : checks.tone === 'bad' ? 'cancel-circle' : 'clock'} size="small" aria-hidden="true" />
          <span>{checks.text[0].toUpperCase() + checks.text.slice(1)}</span>
        </p>
      </section>
      {merge && (
        <section className="prc-side-sec">
          <h3 className="prc-side-head">Merge</h3>
          <p className="prc-line" data-tone={merge.tone}><Icon name={merge.icon} size="small" aria-hidden="true" /><span>{merge.text}</span></p>
        </section>
      )}
      {url && (
        <section className="prc-side-sec">
          <h3 className="prc-side-head">On GitHub</h3>
          <p className="prc-links">
            <a href={url} target="_blank" rel="noopener noreferrer">Conversation<Icon name="link-external" size="small" aria-hidden="true" /></a>
            <a href={`${url}/files`} target="_blank" rel="noopener noreferrer">Files<Icon name="link-external" size="small" aria-hidden="true" /></a>
          </p>
        </section>
      )}
    </aside>
  );
}

export function PrConversation({ row, pr, error, now, onChanged, onShowFiles }: {
  row: PrRow & { repo: string; number: number };
  /** The PR as read from GitHub (PrTabs reads it once for every tab); null until it answers. */
  pr: PrOverview | null;
  error: string | null;
  now: number;
  onChanged: () => void;
  /** Files changed, from the file list's "all files" link. */
  onShowFiles?: () => void;
}) {
  const url = pr?.url ?? row.url ?? null;
  const title = pr?.title ?? row.title;
  if (!pr) {
    return (
      <div className="prc">
        <h2 className="prc-title">{title} <span className="prc-num">#{row.number}</span></h2>
        {error ? <p className="error-text" role="alert">{error}</p> : <p className="prc-quiet">Reading from GitHub…</p>}
      </div>
    );
  }
  const state = prState(pr);
  const description = prDescription(pr.body);
  const author = pr.author ?? 'someone';
  const files = pr.files.slice(0, FILES_SHOWN);
  const moreFiles = pr.changedFiles - files.length;
  // PrActions draws nothing for a PR the viewer can neither review nor merge, unless it can re-run failed checks.
  const acts = pr.viewerCanReview || pr.viewerCanMerge
    || (pr.state === 'OPEN' && (pr.failedSuites.runs.length > 0 || pr.failedSuites.other.length > 0));
  return (
    <div className="prc">
      <header className="prc-head">
        <h2 className="prc-title">{title} <span className="prc-num">#{pr.number}</span></h2>
        <div className="prc-sub">
          <span className="prc-state" data-state={state}><Icon name={STATE[state].icon} size="small" aria-hidden="true" />{STATE[state].label}</span>
          <span className="prc-merge-line">
            <strong>{author}</strong> {state === 'merged' ? 'merged' : state === 'closed' ? 'wanted to merge' : 'wants to merge'} into{' '}
            <code className="prc-ref">{pr.baseRefName}</code> from <code className="prc-ref">{pr.headRefName}</code>
          </span>
        </div>
      </header>
      <div className="prc-grid">
        <Sidebar pr={pr} url={url} />
        <div className="prc-main">
          <article className="prc-card">
            <header className="prc-card-head">
              <span className="rv-comment-av" aria-hidden="true">{initials(author)}</span>
              <strong>{author}</strong>
              <span className="prc-quiet">opened {ago(pr.createdAt, now) || 'this'}</span>
              {state === 'open' || state === 'draft' ? null : <span className="prc-quiet">· {STATE[state].label.toLowerCase()}</span>}
            </header>
            <div className="prc-card-body">
              {description ? <Markdown text={description} /> : <p className="prc-quiet">No description provided.</p>}
            </div>
          </article>

          <section className="prc-card prc-files" aria-label="Files changed">
            <header className="prc-card-head">
              <Icon name="file" size="small" aria-hidden="true" />
              <strong>{pr.changedFiles} {pr.changedFiles === 1 ? 'file' : 'files'} changed</strong>
              <span className="prc-counts"><span className="pro-add">+{pr.additions}</span> <span className="pro-del">−{pr.deletions}</span></span>
            </header>
            <ul className="prc-file-list">
              {files.map(f => (
                <li key={f.path}>
                  <span className="prc-file-kind" data-kind={f.changeType}>{CHANGE_GLYPH[f.changeType] ?? 'M'}</span>
                  <span className="prc-file-path">{f.path}</span>
                  <span className="prc-counts"><span className="pro-add">+{f.additions}</span> <span className="pro-del">−{f.deletions}</span></span>
                </li>
              ))}
            </ul>
            {(moreFiles > 0 || pr.filesTruncated) && onShowFiles && (
              <Button variant="minimal" size="small" className="prc-more" onPress={onShowFiles}>
                {moreFiles > 0 ? `${moreFiles} more in Files changed` : 'All of them in Files changed'}
              </Button>
            )}
          </section>

          {acts && (
            <section className="prc-card" aria-labelledby="prc-act-head">
              <header className="prc-card-head">
                <Icon name={pr.viewerCanMerge ? 'arrow-merge' : 'preview'} size="small" aria-hidden="true" />
                <strong id="prc-act-head">{pr.viewerCanMerge ? 'Merge' : pr.viewerCanReview ? 'Your review' : 'Checks'}</strong>
                {pr.viewerCanReview && <span className="prc-quiet">posts on GitHub as you</span>}
              </header>
              <div className="prc-act">
                <PrActions key={`${pr.repo}#${pr.number}`} pr={pr} url={url} now={now} onChanged={onChanged} />
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
