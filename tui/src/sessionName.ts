import type { Role } from './types.js';

// Mirror of backend `tmux.sessionName` and frontend/src/utils/sessionName.ts —
// the `main` workstream collapses to the historical 3-segment name.
export function sessionName(username: string, project: string, role: Role, workstream = 'main'): string {
  return workstream === 'main'
    ? `${username}-${project}-${role}`
    : `${username}-${project}-${workstream}-${role}`;
}
