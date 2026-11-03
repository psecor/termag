// A session's pull request for the chrome refresh's context card
// (SessionContextCard.tsx): its row in the full UI's PR pipeline (GET /api/prs,
// chat/prGates.ts sessionPr) and, once there is one, its overview from GitHub
// (GET /api/prs/:repo/:number). The list is read as often as the PR pills read
// it, and the overview again each time the list answers, since its checks,
// reviews and files change on GitHub with nothing to tell termag. Both are
// re-read at once when a PR changes (PRS_CHANGED_EVENT).
import { useEffect, useMemo, useState } from 'react';
import { prsApi, type PrOverview, type PrRow } from '../../services/api';
import { PRS_CHANGED_EVENT } from '../../utils/prPipeline';
import { sessionPr } from '../../chat/prGates';
import { usePolled } from '../dashboard/useDashboardData';

export interface SessionPr {
  row: PrRow | null;
  overview: PrOverview | null;
  /** The list has not answered yet. */
  loading: boolean;
  /** GitHub could not be read for the PR's overview; the card shows the row alone. */
  overviewFailed: boolean;
}

/** The last overview read, and which PR it was for (`repo#number`). */
interface OverviewRead { pr: string; overview: PrOverview | null; failed: boolean }

export function useSessionPr(projectId: string, workstream: string): SessionPr {
  const prs = usePolled(() => prsApi.list(), 60_000);
  const { refresh } = prs;
  const [changed, setChanged] = useState(0);
  useEffect(() => {
    const onChanged = () => { refresh(); setChanged(n => n + 1); };
    window.addEventListener(PRS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PRS_CHANGED_EVENT, onChanged);
  }, [refresh]);
  const row = useMemo(() => sessionPr(prs.data, projectId, workstream), [prs.data, projectId, workstream]);
  const [read, setRead] = useState<OverviewRead | null>(null);
  const repo = row?.repo ?? null;
  const number = row?.number ?? null;
  // `prs.data` is a new object each time the list answers: each one reads the overview again.
  useEffect(() => {
    if (!repo || number == null) return;
    const pr = `${repo}#${number}`;
    let live = true;
    prsApi.overview(repo, number)
      .then(o => { if (live) setRead({ pr, overview: o, failed: false }); })
      // A re-read that fails keeps the last overview of this PR: the next one may answer.
      .catch(() => { if (live) setRead(r => (r?.pr === pr && r.overview ? r : { pr, overview: null, failed: true })); });
    return () => { live = false; };
  }, [repo, number, prs.data, changed]);
  // A read of a PR the session has moved on from shows nothing: its own read is coming.
  const shown = read && repo && number != null && read.pr === `${repo}#${number}` ? read : null;
  return { row, overview: shown?.overview ?? null, loading: prs.data === null && prs.loading, overviewFailed: shown?.failed ?? false };
}
