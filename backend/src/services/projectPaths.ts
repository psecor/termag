// Project directory layout, as pure functions.
//
// No imports on purpose: the layout is consulted from route handlers, the
// agent runtime and unit tests, and none of those should have to drag in
// tmux/Prisma to ask where a project lives.

export type ProjectRoot = string;

export interface ProjectRootInput {
  ownerUnixUser: string;
  /** `Instance.hostHome` as reported by the box agent's `hello`, if any. */
  hostHome?: string | null;
}

// A root is the HOME DIRECTORY of the unix user that owns the project's files
// on its host — NOT the project directory, despite what the name suggests.
// Project directories are derived from it by projectDirUnder().
//
// `hostHome` wins when it is a usable absolute path; anything else (empty,
// whitespace-only, relative) falls back to the historical /home/<user> guess,
// which is what every pre-`hello` box and the orchestrator itself used.
export function resolveProjectRoot(input: ProjectRootInput): ProjectRoot {
  const reported = (input.hostHome ?? '').trim();
  if (reported.startsWith('/')) return stripTrailingSlashes(reported);
  return `/home/${input.ownerUnixUser}`;
}

// Working directory for a project's workstream.
//   main:  <root>/termag/projects/<project>/
//   other: <root>/termag/projects/<project>/.worktrees/<workstream>/
//
// The main workstream lives at the project root (it's the canonical git repo);
// other workstreams are `git worktree add`-ed siblings under `.worktrees/`.
// Path stays unchanged for the `main` default so existing single-workstream
// callsites need no migration.
export function projectDirUnder(
  root: ProjectRoot,
  projectName: string,
  workstream: string = 'main',
): string {
  const base = stripTrailingSlashes(root);
  const prefix = base === '/' ? '' : base;
  const dir = `${prefix}/termag/projects/${projectName}`;
  return workstream === 'main' ? dir : `${dir}/.worktrees/${workstream}`;
}

function stripTrailingSlashes(p: string): string {
  const stripped = p.replace(/\/+$/, '');
  return stripped === '' ? '/' : stripped;
}
