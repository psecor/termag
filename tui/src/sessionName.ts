import type { Role } from './types.js';

// Mirror of backend `tmux.sessionName` and frontend/src/utils/sessionName.ts —
// the `main` workstream collapses to the historical 3-segment name, and `.`
// and `:` become `_`, as tmux itself does to session names (a `first.last`
// user or a `foo.bar` project would otherwise name a session that never exists).
export function sessionName(username: string, project: string, role: Role, workstream = 'main'): string {
  const name = workstream === 'main'
    ? `${username}-${project}-${role}`
    : `${username}-${project}-${workstream}-${role}`;
  return name.replace(/[.:]/g, '_');
}
