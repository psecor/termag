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
