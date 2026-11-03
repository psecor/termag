// Where an automation shows in the simple UI's explorers (behind
// simple-ui-automations-enabled and automations-enabled): in its own space,
// beside that space's agents and files, the way an agent is in its space.
// Its space is the one it lives in (`spaceName`, which its runs' chats are
// fixed to as well) while the user has that space; else it is under No space,
// with the agents in none (pages/chat/AgentsExplorer.tsx). It is listed
// there from the moment it exists, before its first run.
import type { AutomationView } from '../services/api';
import { matchesAutomation } from './automationsView';

/** The space an automation is in for this user, or null for No space. */
export function automationSpace(a: Pick<AutomationView, 'spaceName'>, spaces: ReadonlyArray<{ name: string }>): string | null {
  return a.spaceName && spaces.some(s => s.name === a.spaceName) ? a.spaceName : null;
}

/** The automations in `space` (null: No space), archived ones left out, by name. */
export function automationsIn<A extends Pick<AutomationView, 'spaceName' | 'archived' | 'projectName'>>(
  list: readonly A[] | null, space: string | null, spaces: ReadonlyArray<{ name: string }>,
): A[] {
  return (list ?? [])
    .filter(a => !a.archived && automationSpace(a, spaces) === space)
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}

/** The automations among `list` whose name has every word of `query` (as the explorers' agent search). */
export function searchAutomations<A extends Pick<AutomationView, 'projectName'>>(list: readonly A[], query: string): A[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return list.filter(a => words.every(w => a.projectName.toLowerCase().includes(w)));
}

/** Whether the page at `id` (/chat/automations/:id, the automation's or its project's id) is this automation's. */
export function isAutomationShown(a: Pick<AutomationView, 'id' | 'projectId'>, shownId: string | null | undefined): boolean {
  return shownId != null && matchesAutomation(a, shownId);
}
