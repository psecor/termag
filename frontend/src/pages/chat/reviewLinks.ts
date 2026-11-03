// Where a review queue item opens: its review
// session, the session whose review pane reads it (with the panel on its Review
// tab), else the PR's own page.
import { chatHref } from '../../chat/simpleChat';
import { prPath, type QueueItem } from '../../chat/reviews';

/** The location state that asks the side panel for a tool when a link lands (ChatApp). */
export interface PanelToolState { panelTool?: 'review' | 'pr' }

export function reviewHref(it: Pick<QueueItem, 'session' | 'agent' | 'repo' | 'number'>): string {
  if (it.session) return chatHref(it.session.projectId, it.session.workstream);
  if (it.agent) return chatHref(it.agent.projectId, it.agent.workstream);
  return prPath(it.repo, it.number);
}

/** The state a queue link carries: an agent review opens on the panel's Review tab. */
export function reviewLinkState(it: Pick<QueueItem, 'session' | 'agent'>): PanelToolState | undefined {
  if (it.agent && !it.session) return { panelTool: 'review' };
  if (it.session) return { panelTool: 'pr' };
  return undefined;
}
