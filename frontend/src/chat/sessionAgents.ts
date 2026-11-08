// The agents another session runs ("Nested
// agents", behind chat-nested-agents-enabled): its Claude's Agent-tool
// subagents and the asks it sent, for the rows that nest them under it (an
// ask's row in a chat's drawer and context card, an agent's row in Files).
// An SDK chat's subagents come from its history, folded as the chat itself
// folds it; a pane chat's from beside its Claude's session (chat/
// paneSubagents.ts); any session's asks by their parent alone, as a pane
// chat reads its own. Pure, for the tests; chat/useSessionAgents.ts reads.
import { fromHistory } from './sdkChat';
import { subagentsOf, type SubagentView } from './subagents';
import { paneSubagentViews, type PaneSubagentsAnswer } from './paneSubagents';
import { isAskActive, paneAskViews, type AskView, type ChatAskThread } from './asks';
import { isChatRunnerProvider } from '../providers/registry';

/** How a session's subagents are read: its SDK chat's history, its pane Claude's folder, or not at all (Codex, a terminal). */
export type SessionAgentsSource = 'chat' | 'pane' | 'none';

export function sessionAgentsSource(provider: string | null | undefined): SessionAgentsSource {
  if (isChatRunnerProvider(provider)) return 'chat';
  if (provider === 'claude') return 'pane';
  return 'none';
}

/** How many ended subagents or asks a nested list keeps, newest, beside every one still going. */
export const NESTED_ENDED_KEPT = 8;

/** `list` (oldest first) with every one still going and the newest NESTED_ENDED_KEPT of the rest, in order. */
export function keptNested<T>(list: readonly T[], going: (t: T) => boolean, kept = NESTED_ENDED_KEPT): T[] {
  const ended = list.filter(t => !going(t));
  const keep = new Set(ended.slice(Math.max(0, ended.length - kept)));
  return list.filter(t => going(t) || keep.has(t));
}

/** An SDK chat's subagents from its history (GET …/chat). */
export function historySubagents(history: { entries: unknown[]; sessionId: string | null; turn?: Parameters<typeof fromHistory>[2]; running?: boolean }): SubagentView[] {
  const state = fromHistory(history.entries, history.sessionId, history.turn ?? null, [], { running: history.running });
  return subagentsOf(state);
}

/** A pane chat's subagents from its box's answer (GET …/chat/pane-subagents); none when it can't say. */
export function paneAnswerSubagents(answer: PaneSubagentsAnswer): SubagentView[] {
  return answer.available ? paneSubagentViews(answer.subagents, answer.session != null) : [];
}

/** The asks a session sent (GET …/chat/asks by parent alone), oldest first. */
export function sentAsks(threads: readonly ChatAskThread[]): AskView[] {
  return [...paneAskViews(new Map(threads.map(t => [t.id, t]))).values()];
}

/** What a nested list shows of a session: its subagents and its asks, each trimmed to those going and the newest ended. */
export interface SessionAgents { subagents: SubagentView[]; asks: AskView[] }

export function keptSessionAgents(subagents: readonly SubagentView[], asks: readonly AskView[]): SessionAgents {
  return {
    subagents: keptNested(subagents, v => v.status === 'running'),
    asks: keptNested(asks, v => isAskActive(v.state)),
  };
}

/** Whether anything in it is still going: its list is read again soon. */
export function sessionAgentsGoing(a: SessionAgents): boolean {
  return a.subagents.some(v => v.status === 'running') || a.asks.some(v => isAskActive(v.state));
}

/** Its subagents' own subagents (an SDK chat's, which folds them into the one that called each). */
export function nestedSubagents(v: SubagentView): SubagentView[] {
  return v.nested.items.length ? subagentsOf(v.nested) : [];
}

/** A subagent by id in `list` or under any of them (nestedSubagents), for the agent tab of a nested one. */
export function findSubagent(list: readonly SubagentView[], id: string, depth = 0): SubagentView | null {
  for (const v of list) {
    if (v.id === id) return v;
    if (depth < 4) {
      const hit = findSubagent(nestedSubagents(v), id, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
