// A session's in-flight changes for the context card,
// behind simple-ui-inflight-changes-enabled: the files its
// checkout (or, given its PR's branch, the worktree on that branch) has changed and
// not pushed or not committed, from the box (GET …/workstreams/:ws/changes). Read at
// once, again a moment after each of the session's tool calls ends and when a PR
// changes (PRS_CHANGED_EVENT), and every 30 s while the page is visible, for a change
// made outside the chat. The last list the box gave is kept across a failed read,
// or one it couldn't answer (offline, unreadable).
import { useEffect, useRef } from 'react';
import { workstreamsApi, type InflightChanges } from '../../services/api';
import { FLAGS, useFlag } from '../../flags';
import { chatEvents } from '../../chat/chatEvents';
import { endsToolCall } from '../../chat/inflightChanges';
import { PRS_CHANGED_EVENT } from '../../utils/prPipeline';
import { usePolled } from '../dashboard/useDashboardData';

/** How long after a tool call ends the box is asked: a burst of edits is one read. */
export const CHANGES_SETTLE_MS = 1_500;
const POLL_MS = 30_000;

/**
 * `branch`: the session's PR's head, null with no PR, undefined while the PR list
 * hasn't answered: nothing is read until it has, so the card doesn't read the
 * workstream's checkout first and the PR's worktree a moment later.
 */
export function useSessionChanges(projectId: string, workstream: string, branch: string | null | undefined): InflightChanges | null {
  const on = useFlag(FLAGS.inflightChanges, false);
  const ready = on && branch !== undefined;
  // Each answer carries the session and branch it was read for: usePolled keeps its last
  // answer across a change of inputs, and an old branch's list must never pass for the new one's.
  const key = `${projectId}\0${workstream}\0${branch ?? ''}`;
  const changes = usePolled<{ key: string; changes: InflightChanges } | null>(
    () => (ready ? workstreamsApi.changes(projectId, workstream, branch).then(c => ({ key, changes: c })) : Promise.resolve(null)),
    POLL_MS,
    { deps: [ready, projectId, workstream, branch ?? null] },
  );
  const refresh = useRef(changes.refresh);
  refresh.current = changes.refresh;

  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; refresh.current(); }, CHANGES_SETTLE_MS);
    };
    const off = chatEvents.subscribe(frame => {
      if (frame.projectId === projectId && frame.workstream === workstream && endsToolCall(frame.event)) soon();
    });
    window.addEventListener(PRS_CHANGED_EVENT, soon);
    return () => {
      off();
      window.removeEventListener(PRS_CHANGED_EVENT, soon);
      if (timer) clearTimeout(timer);
    };
  }, [ready, projectId, workstream]);

  // A box that is down, an unreadable answer: still HTTP 200, so usePolled takes it as a
  // read. Keep the last list the box did give for this session and branch instead.
  const lastGood = useRef<{ key: string; changes: InflightChanges } | null>(null);
  if (!ready) return null;
  const data = changes.data?.key === key ? changes.data.changes : null;
  if (data?.available) lastGood.current = { key, changes: data };
  if (data && !data.available && lastGood.current?.key === key) return lastGood.current.changes;
  return data;
}
