import { PROVIDERS, SELECTABLE_PROVIDER_IDS } from '../providers/registry';

export interface AgentChoice { id: string; label: string; current: boolean }

/**
 * What the Switch agent dialog offers: every agent a new project could pick,
 * with the one running now marked. A workstream on an agent that is no longer
 * offered (legacy Codex) still sees it, as the current one, so the dialog
 * never claims it runs something else.
 */
export function agentChoices(current: string | null): AgentChoice[] {
  const ids = [...SELECTABLE_PROVIDER_IDS];
  if (current && !ids.includes(current)) ids.unshift(current);
  return ids.map(id => ({ id, label: PROVIDERS[id]?.displayName ?? id, current: id === current }));
}

/** The choice preselected when the dialog opens: the first one that would change something. */
export function defaultAgentChoice(current: string | null): string | null {
  return agentChoices(current).find(c => !c.current)?.id ?? null;
}
