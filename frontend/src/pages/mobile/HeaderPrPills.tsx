// The conversation header's PR pills: the desktop sidebar's pills for this
// workstream (components/WorktreePrPills.tsx), cut to the live ones
// (phonePills). The most pressing one shows; "+N" lists them all. A pill opens
// the PR overview in place, as /m/prs does, or GitHub for a PR the pipeline
// has not listed yet (just opened, or worked on before the lanes' window),
// and GitHub's compare page for a pushed branch with no PR.
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import type { PrRow } from '../../services/api';
import type { SessionMilestone } from '../../types';
import { PrOverviewDialog } from '../dashboard/PrOverviewDialog';
import { useWorktreePrs } from '../../components/WorktreePrPills';
import { phonePillTarget, phonePills, type WorktreePill } from '../../utils/worktreePrs';
import { ActionSheet } from './Sheet';

function sheetRoot(): Element {
  return document.querySelector('.m-root') ?? document.body;
}

export function HeaderPrPills({ projectId, workstream, milestone }: {
  projectId: string;
  workstream: string;
  milestone: SessionMilestone | null | undefined;
}) {
  const { pillsFor, rowFor, refresh } = useWorktreePrs();
  const [overview, setOverview] = useState<PrRow | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const pills = phonePills(pillsFor(projectId, workstream, milestone));

  const open = (p: WorktreePill) => {
    setListOpen(false);
    const target = phonePillTarget(p, rowFor(p));
    if (target && 'overview' in target) setOverview(target.overview);
    else if (target) window.open(target.href, '_blank', 'noopener,noreferrer');
  };

  const [top, ...rest] = pills;
  return (
    <>
      {top && (
        <span className="m-pr-pills">
          <button type="button" className={`worktree-pr-pill m-pr-pill is-${top.tone}`} title={top.title} onClick={() => open(top)}>
            {top.label}
          </button>
          {rest.length > 0 && (
            <button type="button" className="m-pr-more" onClick={() => setListOpen(true)} aria-label={`All ${pills.length} ${pills.some(p => p.tone === 'branch') ? 'pull requests and branches' : 'pull requests'}`}>
              +{rest.length}
            </button>
          )}
        </span>
      )}
      {/* The header line is a span: the sheets go to the phone app's root, which keeps its type and colours. */}
      {listOpen && createPortal(
        <ActionSheet
          title="Pull requests"
          actions={pills.map(p => ({ label: p.title.split('\n')[0], onClick: () => open(p) }))}
          onClose={() => setListOpen(false)}
        />,
        sheetRoot(),
      )}
      {overview && createPortal(
        <PrOverviewDialog row={overview} now={Date.now()} layout="sheet" onClose={() => setOverview(null)} onChanged={refresh} />,
        sheetRoot(),
      )}
    </>
  );
}
