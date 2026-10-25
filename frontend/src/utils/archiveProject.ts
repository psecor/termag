/**
 * The Archive confirmation. Archive sits one row above a worktree's Delete in
 * the sidebar, and a project with many worktrees has been archived by mistake,
 * so it names the project and says how many workstreams go with it, and what
 * coming back gets you.
 */
export function archiveMessage(projectName: string, workstreams: number): string {
  const others = Math.max(0, workstreams - 1);
  const scope = others === 0
    ? 'its agent and terminals'
    : `its agent and terminals, and those of all ${others} of its other workstream${others === 1 ? '' : 's'}`;
  return `Archive the whole ${projectName} project? This stops ${scope}. `
    + 'The folders and worktrees stay on disk; re-creating a project with this name on the same box brings it back.';
}
