import React, { useEffect, useRef, useState } from 'react';
import type { SoftwareUpdateRun } from '../../services/adminApi';
import { followedRunLine, runInFlight } from '../../utils/toolUpdate';

/** How often a host panel re-reads its tool's runs while the run it asked for is going. */
export const FOLLOW_POLL_MS = 4000;
/**
 * How long it does so at most: a requested run expires after 15 minutes (the backend's RUN_EXPIRE_MS);
 * past it, the tab's own minute poll picks up the end.
 */
export const FOLLOW_MAX_MS = 15 * 60_000;

/** `atStart`: a run queued for the box's next start (Docker), which reports only after it. */
export type RunRequest = { runId: string; acknowledged: boolean; atStart?: boolean };

/**
 * Follows the run a host panel asked for, in the tool's runs list (`runs`): re-reads the list every
 * FOLLOW_POLL_MS while the run is requested or running (`poll`), for at most FOLLOW_MAX_MS, and calls
 * `onEnded` once when it ends, so the panel's preview ("current → target", the session counts) moves.
 */
export function useFollowedRun(runs: SoftwareUpdateRun[] | null, poll: () => void, onEnded: () => void) {
  const [req, setReq] = useState<(RunRequest & { at: number }) | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  // The last time the list had the run: a run pushed out of the list later (newer runs of the tool)
  // keeps its last state, so an ended run never reads "updating…" again (Bugbot on #1211).
  const seen = useRef<SoftwareUpdateRun | undefined>(undefined);
  const listed = req ? runs?.find(r => r.id === req.runId) : undefined;
  if (listed) seen.current = listed;
  const run = req && seen.current?.id === req.runId ? seen.current : undefined;
  const going = !!req && (!run || runInFlight(run)) && !gaveUp;
  const pollRef = useRef(poll); pollRef.current = poll;
  const endedRef = useRef(onEnded); endedRef.current = onEnded;
  useEffect(() => {
    if (!going || !req) return;
    const t = setInterval(() => {
      if (Date.now() - req.at >= FOLLOW_MAX_MS) { setGaveUp(true); return; }
      pollRef.current();
    }, FOLLOW_POLL_MS);
    return () => clearInterval(t);
  }, [going, req]);
  const endedId = run && !runInFlight(run) ? run.id : null;
  useEffect(() => { if (endedId) endedRef.current(); }, [endedId]);
  const follow = (r: RunRequest) => { setGaveUp(false); setReq({ ...r, at: Date.now() }); };
  // `going`: the panel's button stays off while it does, before the preview's runInFlight catches up,
  // so a second click can't replace the run it follows with a 409 (Bugbot on #1211).
  return { req, run, follow, going };
}

/** The line under a host panel's update button for the run it asked for: "updating… (run …)", then its end. */
export function FollowedRunText({ req, run }: { req: RunRequest; run: SoftwareUpdateRun | undefined }) {
  const l = followedRunLine(req, run);
  return (
    <div className={l.className || 'usage-dim'} title={l.title} data-testid="followed-run">
      {l.state}
      {l.reason ? <>: {l.reason.text}{l.reason.version ? <> (<span className="admin-mono">{l.reason.version}</span>)</> : null}</> : null}
      {l.versions ? <> · <span className="admin-mono">{l.versions}</span></> : null}
      {' '}(run <span className="admin-mono">{l.runId}</span>)
    </div>
  );
}
