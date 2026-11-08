// Reads the agents another session runs (chat/sessionAgents.ts) while a row
// that nests them is on screen: once, again whenever `working` changes, and
// every few seconds while the session works or any of its agents is going.
// A read that fails (asks or pane subagents off, a box away, an agent to
// restart) keeps that part as it last read, empty before any, and is tried
// again; it says nothing: the row is still a row.
import { useEffect, useRef, useState } from 'react';
import { chatApi } from '../services/api';
import type { SubagentView } from './subagents';
import type { AskView } from './asks';
import {
  historySubagents, keptSessionAgents, nestedSubagents, paneAnswerSubagents, sentAsks, sessionAgentsGoing, sessionAgentsSource,
  type SessionAgents,
} from './sessionAgents';

/** How often a session's agents are read again while it works or one of them is going. */
export const SESSION_AGENTS_POLL_MS = 5000;
/** How many failed reads in a row are tried again with nothing going (a minute). */
export const SESSION_AGENTS_MISSES = 12;

const NO_SUBAGENTS: SubagentView[] = [];
const NO_ASKS: AskView[] = [];

/** How deep a change to a subagent under a subagent still redraws (deeper than the rows nest). */
const SIG_DEPTH = 4;

/** A subagent's clock-free fields and those of the subagents under it, as deep as the rows nest. */
function subagentSig(v: SubagentView, depth = 0): unknown[] {
  return [v.id, v.status, v.step, v.description, v.nested.items.length, depth < SIG_DEPTH ? nestedSubagents(v).map(c => subagentSig(c, depth + 1)) : []];
}

/**
 * The session's subagents and asks (null until the first read, and while
 * `enabled` is off), for `projectId|workstream`, run by `provider`.
 */
export function useSessionAgents(projectId: string, workstream: string, provider: string | null | undefined, working: boolean, enabled: boolean): SessionAgents | null {
  const key = `${projectId}|${workstream}`;
  const source = sessionAgentsSource(provider);
  const [got, setGot] = useState<{ key: string; agents: SessionAgents } | null>(null);
  const last = useRef('');
  // The last good read of each part, for this key: a failed read keeps it, rather than wiping rows that loaded,
  // and so does the read a change of `working` starts. Its subagents are its provider's: another provider's go,
  // even one read the same way (two chat runners).
  const runner = provider ?? null;
  const keptRef = useRef<{ key: string; runner: string | null; subagents: SubagentView[]; asks: AskView[] } | null>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const prior = keptRef.current?.key === key ? keptRef.current : null;
    let kept = prior && prior.runner !== runner ? { ...prior, runner, subagents: NO_SUBAGENTS } : prior;
    let misses = 0;
    const read = () => {
      const failed = Symbol('failed');
      const subagents: Promise<SubagentView[] | typeof failed> = source === 'chat'
        ? chatApi.history(projectId, workstream).then(h => historySubagents(h)).catch(() => failed)
        : source === 'pane'
          // A box that can't say (`available: false`) is a miss too, not a list of none.
          ? chatApi.paneSubagents(projectId, workstream).then(r => (r.available ? paneAnswerSubagents(r) : failed)).catch(() => failed)
          : Promise.resolve(NO_SUBAGENTS);
      const asks: Promise<AskView[] | typeof failed> = chatApi.asks(projectId, workstream, []).then(r => sentAsks(r.threads)).catch(() => failed);
      Promise.all([subagents, asks]).then(([s, a]) => {
        if (!alive) return;
        const missed = s === failed || a === failed;
        misses = missed ? misses + 1 : 0;
        const wasGoing = kept ? sessionAgentsGoing(keptSessionAgents(kept.subagents, kept.asks)) : false;
        kept = { key, runner, subagents: s === failed ? kept?.subagents ?? NO_SUBAGENTS : s, asks: a === failed ? kept?.asks ?? NO_ASKS : a };
        keptRef.current = kept;
        const agents = keptSessionAgents(kept.subagents, kept.asks);
        // Only a change redraws; the clock-free fields say whether one did.
        const sig = `${key}\n${JSON.stringify([agents.subagents.map(subagentSig), agents.asks.map(v => [v.thread, v.state, v.title, v.completedAt])])}`;
        if (sig !== last.current) { last.current = sig; setGot({ key, agents }); }
        // A failed read is tried again while what it last showed was going, or for up to a minute.
        const retry = missed && (wasGoing || misses < SESSION_AGENTS_MISSES);
        if (working || sessionAgentsGoing(agents) || retry) timer = setTimeout(read, SESSION_AGENTS_POLL_MS);
      });
    };
    read();
    return () => { alive = false; clearTimeout(timer); };
  }, [enabled, key, projectId, workstream, source, runner, working]);
  return enabled && got?.key === key ? got.agents : null;
}
