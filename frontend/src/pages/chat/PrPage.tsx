// A pull request's page in the simple UI, at
// /chat/pr/<owner>/<name>/<n>, and at /chat/gh/<owner>/<name>/pull/<n>, the
// path GitHub uses, so swapping the host in the address bar opens it here.
// It's where "pull up a PR" lands, from ⌘K, the Reviews page or a pasted
// link: what the PR is, in GitHub's tabs (PrTabs.tsx: Conversation, Files
// changed with every review thread on its line, Checks), with Review, Open
// on GitHub and Open in termag desktop in its header.
import React, { useEffect, useMemo } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '@launchpad-ui/icons';
import type { PrPipelineResponse, PrRow } from '../../services/api';
import { lanesOf } from '../../utils/prPipeline';
import { memberRows } from '../../utils/prReviewGroups';
import { prPath, prShort } from '../../chat/reviews';
import { desktopPrHref } from '../../chat/desktopLinks';
import { PrTabs } from './PrTabs';
import { ChatHistoryButton } from './chatChrome';
import { ReviewMenu } from './ReviewMenu';
import { useReviewsData } from './reviewsData';

/** The PR's pipeline row where a lane or a review group has it, else a bare one PrDetail can read the PR from. */
export function rowFor(prs: PrPipelineResponse | null, repo: string, number: number): PrRow {
  const all = [...lanesOf(prs).flatMap(l => l.rows), ...memberRows(prs)];
  // Without case: a group's card links its member as stored (lowercase), a lane keeps GitHub's own case.
  const found = all.find(r => r.kind === 'pr' && r.repo?.toLowerCase() === repo.toLowerCase() && r.number === number);
  if (found) return found;
  return {
    kind: 'pr', lane: 'team_review', repo, number, title: prShort(repo, number), url: `https://github.com/${repo}/pull/${number}`,
    author: null, headRefName: '', baseRefName: '', at: null, badges: [], failingChecks: [], pendingChecks: [], waitingOn: [],
    blockedBy: null, mergedAt: null, mergeCommit: null, deploy: null, workstream: null, requestedAt: null, reviewTarget: null,
  };
}

export function PrPage() {
  const { owner = '', name = '', number: raw = '' } = useParams();
  const repo = `${owner}/${name}`;
  const number = Number(raw);
  const { prs, refresh } = useReviewsData();
  const row = useMemo(() => rowFor(prs, repo, number), [prs, repo, number]);
  // GitHub's own path (/chat/gh/…/pull/n, any tab after it) is a way in, not a second page: it becomes the PR's
  // page, so the sidebar's current row and the Review button know it.
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const onGithubPath = pathname.startsWith('/chat/gh/');
  useEffect(() => {
    if (onGithubPath && owner && name && Number.isInteger(number) && number > 0) navigate(prPath(repo, number), { replace: true });
  }, [onGithubPath, owner, name, number, repo, navigate]);
  if (!owner || !name || !Number.isInteger(number) || number <= 0) {
    return <div className="chat-home"><h1>Not a pull request</h1><p><Link to="/chat/reviews">Reviews</Link></p></div>;
  }
  return (
    <div className="chat-view">
      <section className="chat-conv rv-pr-page">
        <header className="chat-header">
          <ChatHistoryButton />
          <div className="chat-title">
            <Link to="/chat/reviews" className="rv-crumb">Reviews</Link>
            <span className="chat-crumb-sep rv-sep" aria-hidden="true">/</span>
            <span className="chat-title-name">{prShort(repo, number)}<span className="rv-crumb-title">{row.title !== prShort(repo, number) ? row.title : ''}</span></span>
          </div>
          <div className="chat-header-actions">
            <a className="rv-link-button rv-gh" href={row.url ?? `https://github.com/${repo}/pull/${number}`} target="_blank" rel="noopener noreferrer">
              GitHub<Icon name="link-external" size="small" aria-hidden="true" />
            </a>
            <a className="rv-link-button rv-gh" href={desktopPrHref(repo, number)} aria-label="Open in termag desktop" title="Its thread in termag desktop, or a checkout of it to review">
              Desktop<Icon name="device-desktop" size="small" aria-hidden="true" />
            </a>
            <ReviewMenu repo={repo} number={number} row={row} />
          </div>
        </header>
        <div className="chat-transcript">
          <div className="rv-pr-body pr-panel">
            <PrTabs row={row as PrRow & { repo: string; number: number }} prs={prs} onChanged={refresh} />
          </div>
        </div>
      </section>
    </div>
  );
}
