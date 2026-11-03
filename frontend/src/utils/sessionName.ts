// Mirror of backend `tmux.sessionName` — the `main` workstream collapses to
// the historical 3-segment name so single-workstream projects keep their
// existing tmux/session identifiers. `.` and `:` become `_`, as tmux itself
// does to session names.
export function sessionName(
  username: string,
  project: string,
  role: 'agent' | 'ctrl' | 'data' | 'data-ctrl' | 'review',
  workstream: string = 'main',
): string {
  const name = workstream === 'main'
    ? `${username}-${project}-${role}`
    : `${username}-${project}-${workstream}-${role}`;
  return name.replace(/[.:]/g, '_');
}

/**
 * Review panes per workstream, mirror of backend
 * `tmux.reviewSessionName`: slot 1 is the `review` role's own name, slots
 * 2..MAX are `<that>-<n>`.
 */
export const MAX_REVIEW_SLOTS = 8;

export function reviewSessionName(username: string, project: string, workstream: string = 'main', slot: number = 1): string {
  const base = sessionName(username, project, 'review', workstream);
  return slot === 1 ? base : `${base}-${slot}`;
}

/**
 * Whether a session name is a workstream's agent pane: the `-agent` role
 * suffix, as sessionName() puts it last. Not a substring match, so a project
 * or workstream whose own name contains `agent` (`u-agentops-ctrl`) is
 * still its ctrl pane.
 */
export function isAgentPaneSession(name: string): boolean {
  return /-agent$/.test(name);
}
