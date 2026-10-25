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
 * Whether a session name is a workstream's agent pane: the `-agent` role
 * suffix, as sessionName() puts it last. Not a substring match, so a project
 * or workstream whose own name contains `agent` (`u-agentops-ctrl`) is
 * still its ctrl pane.
 */
export function isAgentPaneSession(name: string): boolean {
  return /-agent$/.test(name);
}
