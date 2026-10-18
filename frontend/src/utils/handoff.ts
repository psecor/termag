import type { HandoffMode, SessionHandoff } from '../types';
import { PROVIDERS } from '../providers/registry';
import { agentChoices, type AgentChoice } from './switchAgent';

/** The modes a handoff can use for this agent (the registry's handoffModes); empty = it cannot be handed off. */
export function handoffModesFor(provider: string | null): HandoffMode[] {
  return (provider && PROVIDERS[provider]?.handoffModes) || [];
}

/** Whether the menus offer Hand off for a workstream running this agent. */
export function canHandOff(provider: string | null): boolean {
  return handoffModesFor(provider).length > 0;
}

/** The agents a handoff restart may start, with the running one marked (the Switch agent list, filtered). */
export function handoffTargets(current: string | null): AgentChoice[] {
  return agentChoices(current).filter(c => !!PROVIDERS[c.id]?.handoffTarget);
}

export interface HandoffModeChoice { mode: HandoffMode; label: string; detail: string; available: boolean }

/** What the Hand off dialog offers for the agent running now. */
export function handoffModeChoices(current: string | null): HandoffModeChoice[] {
  const modes = handoffModesFor(current);
  const name = current ? PROVIDERS[current]?.displayName ?? current : 'this agent';
  return [
    { mode: 'clear', label: 'Clear and read back in', detail: 'The smallest context: /clear in the running agent, then it reads the handoff.', available: modes.includes('clear') },
    { mode: 'compact', label: 'Compact and read back in', detail: 'Keeps a summary of the conversation as well as the handoff.', available: modes.includes('compact') },
    { mode: 'restart', label: 'Restart', detail: `Stops ${name} and starts an agent on the handoff. Picks up new MCP servers, tools and settings, and can switch agent.`, available: modes.includes('restart') },
  ];
}

/** The mode preselected: clear when the agent can do it, else restart. */
export function defaultHandoffMode(current: string | null): HandoffMode {
  return handoffModeChoices(current).find(c => c.available)?.mode ?? 'restart';
}

const OPEN = new Set<SessionHandoff['state']>(['requested', 'writing', 'written', 'resetting']);
const ABORTABLE = new Set<SessionHandoff['state']>(['requested', 'writing', 'written']);
/** How long a finished handoff's line stays over the pane. */
const DONE_SHOWN_MS = 15_000;
const FAILED_SHOWN_MS = 2 * 60_000;

export function isHandoffOpen(h: SessionHandoff | null | undefined): boolean {
  return !!h && OPEN.has(h.state);
}

export function isHandoffAbortable(h: SessionHandoff | null | undefined): boolean {
  return !!h && ABORTABLE.has(h.state);
}

/** Whether the strip over the agent pane shows this handoff now. */
export function showHandoffStrip(h: SessionHandoff | null | undefined, now: number): boolean {
  if (!h) return false;
  if (OPEN.has(h.state)) return true;
  const age = now - Date.parse(h.at);
  return h.state === 'done' ? age < DONE_SHOWN_MS : age < FAILED_SHOWN_MS;
}

/** One line for the strip; an open handoff's reason is why the asked-for mode fell back. */
export function handoffStateLabel(h: SessionHandoff): string {
  const line = stateLine(h);
  return OPEN.has(h.state) && h.reason ? `${line} (${h.reason})` : line;
}

function stateLine(h: SessionHandoff): string {
  const reset = h.mode === 'clear' ? 'clear' : h.mode === 'compact' ? 'compact' : `restart${h.toProvider ? ` on ${PROVIDERS[h.toProvider]?.displayName ?? h.toProvider}` : ''}`;
  switch (h.state) {
    case 'requested': return `Hand off (${reset}): waiting for the agent to finish its turn`;
    case 'writing': return 'Hand off: the agent is writing its handoff';
    case 'written': return `Hand off: handoff saved; will ${reset} when the agent is at its prompt`;
    case 'resetting': return h.mode === 'restart' ? `Hand off: restarting${h.toProvider ? ` on ${PROVIDERS[h.toProvider]?.displayName ?? h.toProvider}` : ''}` : `Hand off: ${h.mode === 'clear' ? 'clearing' : 'compacting'}, then reading the handoff back in`;
    case 'done': return 'Handed off: the next agent is starting on the handoff';
    case 'failed': return `Hand off failed${h.reason ? `: ${h.reason}` : ''}`;
    case 'aborted': return `Hand off aborted${h.reason ? `: ${h.reason}` : ''}`;
  }
}
