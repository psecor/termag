/**
 * The pure half of a project rename (routes/projects.ts renameOwnedProject):
 * which tmux sessions change name, and why a box-hosted rename can't go ahead.
 *
 * A box project's sessions and directory live on the box, so its rename runs
 * there through the agent's `project-rename` RPC. Without a reachable agent
 * that knows it, nothing is renamed: renaming only the database row would
 * orphan the box's sessions under the old name.
 */
import { powerStateError } from '../services/boxPowerPolicy';
import { reviewSessionNames, sessionName, terminalSessionNames } from '../services/tmux';
import type { RouteResult } from './routeResult';

export interface RenameWorkflow {
  type: 'agent' | 'data';
  workstream: string;
}

export function renameSessionPairs(
  unixUsername: string,
  oldName: string,
  newName: string,
  workflows: RenameWorkflow[],
): Array<{ from: string; to: string }> {
  const pairs: Array<{ from: string; to: string }> = [];
  for (const wf of workflows) {
    // `review` (the review panes, routes/review.ts: every slot)
    // rides along with the agent pair; they usually do not exist, and the rename tolerates that.
    const roles = wf.type === 'agent' ? (['agent', 'ctrl'] as const) : (['data', 'data-ctrl'] as const);
    for (const role of roles) {
      pairs.push({
        from: sessionName(unixUsername, oldName, role, wf.workstream),
        to: sessionName(unixUsername, newName, role, wf.workstream),
      });
    }
    if (wf.type === 'agent') {
      const to = reviewSessionNames(unixUsername, newName, wf.workstream);
      reviewSessionNames(unixUsername, oldName, wf.workstream).forEach((from, i) => pairs.push({ from, to: to[i] }));
      // The user's terminal slots ride along too —
      // slots 2..MAX; slot 1 IS the ctrl pane, renamed by the role loop above.
      // They usually do not exist, and the rename tolerates that.
      const toTerm = terminalSessionNames(unixUsername, newName, wf.workstream);
      terminalSessionNames(unixUsername, oldName, wf.workstream).slice(1).forEach((from, i) => pairs.push({ from, to: toTerm[i + 1] }));
    }
  }
  return pairs;
}

/** Why a box project can't be renamed right now, or null when its agent can do it. */
export function boxRenameError(boxStatus: string, agentConnected: boolean): RouteResult | null {
  if (agentConnected) return null;
  const parked = powerStateError(boxStatus);
  if (parked) return { status: 409, body: { error: parked } };
  return { status: 503, body: { error: 'Box agent is not connected' } };
}

/** The agent refused or failed the `project-rename` RPC. */
export function boxRenameRpcError(message: string): RouteResult {
  if (/^Unknown command/.test(message)) {
    return {
      status: 409,
      body: { error: "This box's termag agent predates project rename; update the box and try again", code: 'agent_outdated' },
    };
  }
  return { status: 502, body: { error: `The box could not rename the project: ${message}` } };
}
