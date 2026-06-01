// Mirror of backend `tmux.sessionName` — the `main` workstream collapses to
// the historical 3-segment name so single-workstream projects keep their
// existing tmux/session identifiers.
export function sessionName(
  username: string,
  project: string,
  role: 'agent' | 'ctrl' | 'data' | 'data-ctrl',
  workstream: string = 'main',
): string {
  return workstream === 'main'
    ? `${username}-${project}-${role}`
    : `${username}-${project}-${workstream}-${role}`;
}
