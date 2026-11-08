// The side panel's Share tab (chat/sidePanel.ts): what the full UI's "Share…"
// on the browser dock opens (components/ShareDialog.tsx), in the panel beside
// the conversation. Its links open at the page the Browser tab shows. The
// simple UI has no PR overlay, so the workstream's own open PRs are listed
// here too, each with the overlay's "Share preview", above the project's PR
// preview settings. A share a PR row makes or ends shows in the list (it reads
// the shares again), and a PR's share the list ends is offered again in its row.
import React, { useEffect, useMemo, useState } from 'react';
import { SharePreview } from '../../components/ShareDialog';
import { SharePrPreview, offersPrShare } from '../../components/SharePrPreview';
import { sharePagePath, useRememberedBrowserUrl } from '../../components/BrowserDock';
import { usePolled } from '../dashboard/useDashboardData';
import { prsApi, type PrPipelineResponse, type PrRow } from '../../services/api';
import { PRS_CHANGED_EVENT, lanesOf, rowKey, rowLabel } from '../../utils/prPipeline';
import { FLAGS, useFlag } from '../../flags';

export function ShareTab({ projectId, workstream }: { projectId: string; workstream: string }) {
  const ttl = useFlag(FLAGS.previewShareTtlHours, 24);
  const [url] = useRememberedBrowserUrl(projectId, workstream);
  const [sharesKey, setSharesKey] = useState(0);
  const [ended, setEnded] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <div className="chat-side-share">
      <div className="chat-side-share-title">Share the preview of {workstream}</div>
      <SharePreview
        projectId={projectId}
        workstream={workstream}
        defaultTtlHours={ttl}
        atPath={sharePagePath(url)}
        byHand="from this workstream's PRs above"
        reloadKey={sharesKey}
        onEnded={id => setEnded(prev => new Set(prev).add(id))}
      >
        <WorkstreamPrs projectId={projectId} workstream={workstream} ended={ended} onChanged={() => setSharesKey(k => k + 1)} />
      </SharePreview>
    </div>
  );
}

/** The open PRs of the viewer's own from this workstream: those "Share preview" is offered on. */
export function workstreamPrs(res: PrPipelineResponse | null | undefined, projectId: string, workstream: string): PrRow[] {
  const rows = new Map<string, PrRow>();
  for (const r of lanesOf(res).flatMap(l => l.rows)) {
    if (offersPrShare(r) && r.workstream.projectId === projectId && r.workstream.workstream === workstream) rows.set(rowKey(r), r);
  }
  return [...rows.values()];
}

/** The same /api/prs read as the PR pills (backend memoized per user), re-read when the PR overlay changes a PR. */
function WorkstreamPrs({ projectId, workstream, ended, onChanged }: { projectId: string; workstream: string; ended: ReadonlySet<string>; onChanged: () => void }) {
  const prs = usePolled(() => prsApi.list(), 60_000);
  const { refresh } = prs;
  useEffect(() => {
    window.addEventListener(PRS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PRS_CHANGED_EVENT, refresh);
  }, [refresh]);
  const rows = useMemo(() => workstreamPrs(prs.data, projectId, workstream), [prs.data, projectId, workstream]);
  return (
    <div className="chat-side-share-prs" aria-label="This workstream's PRs">
      <div className="pr-preview-settings-title">This workstream's PRs</div>
      {prs.data === null && prs.loading && <div className="usage-dim">Loading…</div>}
      {(prs.data !== null || !prs.loading) && rows.length === 0 && <div className="usage-dim">No open PR of yours from this workstream.</div>}
      {rows.map(r => (
        <div key={rowKey(r)} className="chat-side-share-pr">
          <div className="chat-side-share-pr-name">
            {r.url ? <a href={r.url} target="_blank" rel="noreferrer">{rowLabel(r)}</a> : rowLabel(r)}
            <span className="usage-dim" title={r.title}> {r.title}</span>
          </div>
          <SharePrPreview row={r} ended={ended} onChanged={onChanged} />
        </div>
      ))}
    </div>
  );
}
