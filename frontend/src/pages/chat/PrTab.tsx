// The side panel's Pull request tab under the chrome refresh:
// the session's PR from the full UI's PR
// pipeline (GET /api/prs, chat/prGates.ts sessionPr), the gates in front of its
// merge, and the full UI's own PR view (pages/dashboard/PrOverviewDialog.tsx
// PrDetail: description, files, checks to re-run, review and merge), all on
// real data. PrDetail reads the PR again each time the list answers, and the
// gates follow it (onLoaded). With no PR, it says so.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ProgressBar } from '@launchpad-ui/components';
import { Icon, type IconName } from '@launchpad-ui/icons';
import { prsApi, type PrOverview, type PrRow } from '../../services/api';
import { PRS_CHANGED_EVENT, rowLabel } from '../../utils/prPipeline';
import { prGates, sessionPr, type GateStatus } from '../../chat/prGates';
import { usePolled } from '../dashboard/useDashboardData';
import { PrDetail } from '../dashboard/PrOverviewDialog';
import { ReviewMenu } from './ReviewMenu';
import { useReviewOf, useReviewsData } from './reviewsData';
import { rowFor } from './PrPage';
import { PrTabs, type PrTabKey } from './PrTabs';
import { inlineOf } from '../../chat/reviewCard';
import { isTicked, updateCard, useLatestCard } from '../../chat/reviewDrafts';
import { postedAt, type PostedRound } from '../../chat/reviews';
import type { PrPipelineResponse } from '../../services/api';
import type { Project } from '../../types';

const GATE_ICON: Record<Exclude<GateStatus, 'running'>, IconName> = { pass: 'check-circle', fail: 'cancel-circle', waiting: 'clock' };
const GATE_WORD: Record<GateStatus, string> = { pass: 'passed', fail: 'failed', running: 'running', waiting: 'waiting' };

/** A gate's state: a check when it passed, a cross when it failed, a clock while it waits, a calm spinner while it runs. */
export function GateMark({ status }: { status: GateStatus }) {
  return (
    <span className="ctx-mark" data-status={status} aria-hidden="true">
      {status === 'running'
        ? <ProgressBar variant="spinner" size="small" isIndeterminate aria-label="Running" />
        : <Icon name={GATE_ICON[status]} size="medium" />}
    </span>
  );
}

export function GateList({ pr }: { pr: Pick<PrOverview, 'checks' | 'reviewDecision' | 'reviews' | 'mergeable' | 'mergeStateStatus' | 'requestedReviewers'> }) {
  const gates = prGates(pr);
  return (
    <ul className="ctx-gates" aria-label="Merge gates">
      {gates.map(g => (
        <li key={g.key}>
          <GateMark status={g.status} />
          <span className="ctx-gate-name">{g.name}<span className="chat-sr">: {GATE_WORD[g.status]}</span></span>
          <span className="ctx-gate-detail" title={g.detail}>{g.detail}</span>
        </li>
      ))}
    </ul>
  );
}

export function PrTab({ project, workstream }: { project: Project; workstream: string }) {
  const prs = usePolled(() => prsApi.list(), 60_000);
  const reviewsOn = useReviewsData().on;
  // A review session's PR is the one under review, in GitHub's tabs.
  const review = useReviewOf(project.id, workstream);
  const { refresh } = prs;
  // Re-read when the PR overlay, or this tab's own review or merge, changes a PR.
  useEffect(() => {
    window.addEventListener(PRS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PRS_CHANGED_EVENT, refresh);
  }, [refresh]);
  const row = useMemo(() => sessionPr(prs.data, project.id, workstream), [prs.data, project.id, workstream]);
  const [overview, setOverview] = useState<PrOverview | null>(null);
  const shownPr = row?.repo && row.number != null ? `${row.repo}#${row.number}` : null;
  // Which PR the gates are for now, so a late read of one the session has moved on from is dropped.
  const current = useRef(shownPr);
  current.current = shownPr;
  useEffect(() => { setOverview(null); }, [shownPr]);
  // A review or merge in PrDetail changes the PR. Say so to the rest of the page (the PR
  // pills, the PRs tile, this tab's list, as the PR overlay does), and read it again so the
  // gates follow; PrDetail keeps its own copy and its "done" note.
  const changed = () => {
    window.dispatchEvent(new Event(PRS_CHANGED_EVENT));
    if (!row?.repo || row.number == null || !shownPr) return;
    const asked = shownPr;
    prsApi.overview(row.repo, row.number)
      .then(o => { if (current.current === asked) setOverview(o); })
      .catch(() => { /* the gates keep the last read */ });
  };

  if (review) {
    // A session just made isn't listed yet, and once you've reviewed it the PR leaves the review lanes: read it by
    // number then, under the queue's title.
    const reviewRow = review.row ?? { ...rowFor(prs.data, review.repo, review.number), title: review.title, author: review.author, url: review.url };
    return <ReviewSessionPr project={project} workstream={workstream} row={reviewRow as PrRow & { repo: string; number: number }} prs={prs.data} onChanged={changed} />;
  }
  if (!row) {
    return (
      <div className="pr-panel pr-panel-empty">
        <span className="chat-launcher-icon" data-kind="pr" aria-hidden="true"><Icon name="arrow-merge" size="medium" /></span>
        <span className="chat-launcher-title">{prs.data === null && prs.loading ? 'Looking for its pull request…' : 'No pull request yet'}</span>
        {!(prs.data === null && prs.loading) && (
          <span className="chat-launcher-sub">When {project.name} opens a PR from this session, it shows here with its checks and gates.</span>
        )}
      </div>
    );
  }
  return (
    <div className="pr-panel">
      <div className="pr-panel-label">
        {rowLabel(row)}
        {/* Self-review: a reviewer reads this session's PR in a pane beside it. */}
        {reviewsOn && row.repo && row.number != null && row.lane !== 'merged' && row.lane !== 'deployed' && row.lane !== 'merged_not_deployed' && (
          <ReviewMenu repo={row.repo} number={row.number} row={row} here={{ projectId: project.id, workstream }} size="small" />
        )}
      </div>
      {overview && overview.state === 'OPEN' && (
        <section className="pr-panel-gates">
          <h4 className="ctx-heading">Before it merges</h4>
          <GateList pr={overview} />
        </section>
      )}
      <PrDetail key={`${row.repo}#${row.number}`} row={row} now={Date.now()} onChanged={changed} onLoaded={setOverview} listed={prs.data} />
    </div>
  );
}

/**
 * A review session's Pull request tab: the PR
 * under review, with the review card's ticked findings as drafts on their
 * lines in Files changed, which opens on the finding clicked in the card.
 */
function ReviewSessionPr({ project, workstream, row, prs, onChanged }: {
  project: Project; workstream: string; row: PrRow & { repo: string; number: number }; prs: PrPipelineResponse | null; onChanged: () => void;
}) {
  const card = useLatestCard(project.id, workstream);
  const viewer = prs && prs.connected ? prs.viewer : 'you';
  const [tab, setTab] = useState<PrTabKey>('files');
  const focusId = card?.state.focus ?? null;
  const focusAt = card?.state.focusAt ?? 0;
  // Every ask opens Files changed, the same finding again included (focusAt). Switched while rendering, not in an
  // effect: the diff's scroll effect then runs with Files changed already shown, not on a hidden panel.
  const ask = focusId ? `${focusId}@${focusAt}` : null;
  const [asked, setAsked] = useState(ask);
  if (ask !== asked) {
    setAsked(ask);
    if (ask) setTab('files');
  }
  const findings = card?.state.findings?.findings ?? [];
  const rounds = (prs && prs.connected ? (prs as { reviewRounds?: PostedRound[] }).reviewRounds ?? [] : []);
  // Posted from this card's head, whatever round number the reviewer gave it.
  const postedOnServer = postedAt(rounds, row.repo, row.number, card?.state.findings?.head).length > 0;
  const drafts = card?.state.posted || postedOnServer ? [] : findings.filter(f => card && isTicked(card.state, f) && f.at).map(f => {
    const c = inlineOf(f)!;
    return { key: f.id, path: c.path, line: c.line, body: c.body, who: viewer, onRemove: () => card && updateCard(card.key, { ticks: { [f.id]: false } }) };
  });
  const at = findings.find(f => f.id === focusId)?.at ?? null;
  const focused = at ? { ...at, at: focusAt } : null;
  return (
    <div className="pr-panel rv-panel-tabs">
      <PrTabs row={row} prs={prs} onChanged={onChanged} drafts={drafts} focus={focused} tab={tab} onTab={setTab} />
    </div>
  );
}
