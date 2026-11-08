// A pane chat's subagents ("Subagents in a pane
// chat"), and the sessions running alongside its Claude, read from GET
// …/chat/pane-subagents: when the chat opens and whenever its agent starts or
// stops working, then every few seconds while it works (it may start one at
// any moment), one is running, or a session runs alongside. A box away, an
// agent without the RPC, or a failed read leaves the chat as it was: no
// subagents, nothing said.
import { useEffect, useMemo, useRef, useState } from 'react';
import { chatApi } from '../services/api';
import { paneAlongsideViews, paneKeptSubagents, paneSubagentViews, type PaneSubagentsAnswer } from './paneSubagents';
import type { SubagentView } from './subagents';

/** How often the list is read while the agent works or a subagent runs. */
export const PANE_SUBAGENT_POLL_MS = 5000;
/** How often the list is read while only a session alongside keeps it reading. */
export const PANE_ALONGSIDE_POLL_MS = 15_000;
/** How often the list is read while nothing else keeps it reading: a box away, an agent to restart, or an idle pane a session may start beside. */
export const PANE_SUBAGENT_RETRY_MS = 60_000;

const NONE: readonly SubagentView[] = [];

/**
 * The chat's subagent views, and whether the box has answered for this chat
 * (`projectId|workstream`) yet: until then `views` is null, so the agent tab
 * says it is loading. Another chat's answer is never shown. While `enabled`
 * is off: none, answered.
 */
export function usePaneSubagents(projectId: string, workstream: string, working: boolean, enabled: boolean): { views: readonly SubagentView[] | null; alongside: readonly SubagentView[]; available: boolean } {
  const key = `${projectId}|${workstream}`;
  const [got, setGot] = useState<{ key: string; answer: PaneSubagentsAnswer } | null>(null);
  const last = useRef('');
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      let wait: number | null = working ? PANE_SUBAGENT_POLL_MS : null;
      chatApi.paneSubagents(projectId, workstream)
        .then(answer => {
          if (!alive) return;
          const sig = `${key}\n${JSON.stringify(answer)}`;
          if (sig !== last.current) { last.current = sig; setGot({ key, answer }); }
          if (answer.available && answer.subagents.some(s => !s.finished)) wait = PANE_SUBAGENT_POLL_MS;
          // A session alongside, and nothing quicker: often enough to see it end, or a new one start.
          else if (answer.available && answer.alongside.length > 0 && wait == null) wait = PANE_ALONGSIDE_POLL_MS;
          // Idle with none: a Claude started in another pane shows within a minute.
          else if (answer.available && wait == null) wait = PANE_SUBAGENT_RETRY_MS;
          // An agent to restart or a box away: look again now and then, in case it comes back.
          if (!answer.available && wait == null) wait = PANE_SUBAGENT_RETRY_MS;
        })
        // The route off (404) or a failed read: again while the agent works, else now and then.
        .catch(() => { if (wait == null) wait = PANE_SUBAGENT_RETRY_MS; })
        .finally(() => { if (alive && wait != null) timer = setTimeout(read, wait); });
    };
    read();
    return () => { alive = false; clearTimeout(timer); };
  }, [enabled, key, projectId, workstream, working]);
  const answer = enabled && got?.key === key ? got.answer : null;
  const views = useMemo(() => {
    if (!enabled) return NONE;
    if (!answer) return null;
    return answer.available ? paneSubagentViews(answer.subagents, answer.session != null) : NONE;
  }, [enabled, answer]);
  const alongside = useMemo(() => (answer?.available ? paneAlongsideViews(answer.alongside) : NONE), [answer]);
  return { views, alongside, available: Boolean(answer?.available) };
}

/** The subagents a pane chat keeps in view, re-weighed each minute so one that ended leaves in time. */
export function usePaneKeptSubagents(views: readonly SubagentView[] | null): SubagentView[] {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!views?.length) return undefined;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [views]);
  return useMemo(() => (views ? paneKeptSubagents(views, now) : []), [views, now]);
}
