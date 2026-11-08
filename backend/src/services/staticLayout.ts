/**
 * The static layout: on a
 * box made from an environment, each of its repositories is checked out at
 * `~/code/<repo>`, or at `~/code/<path>` when the definition gives the
 * repository a `path`, and not under the project. Not `~/src`: every box
 * image already has `~/src/termag` (the box's own termag), `~/src/webapp`
 * and `~/src/dev` (decided 2026-11-06).
 *
 * - A repo project: its directory, `~/termag/projects/<name>`, becomes a link
 *   to `~/code/<repo>`.
 * - A multi-repo project: its root is `~/code` itself, with the project's
 *   directory a link to it, so each repository is at `~/code/<repo>` and the
 *   steps run with `~/code` as their root, a folder that exists before any
 *   project does (an environment pool prepares a box before its claim).
 *
 * Everything that derives a project's directory from its name still reaches
 * the checkout through the link, and `Project.dir` records where it really
 * is. The box decides whether it can (agent/project-clone.js staticChoice,
 * agent/workspace.js staticRootChoice): a path already taken is never taken
 * over, and the project keeps the per-project layout.
 *
 * Every box made from an environment gets it, whatever its image; boxes not
 * made from one are unchanged. setup run at `~/code/<repo>` before a claim
 * stays valid after it.
 */
import { repoKey } from './projectTemplates';
import { isManagedBox } from './instanceLifecycle';

/** The box agent can clone to a static path and link the project to it (agent/project-clone.js). */
export const STATIC_LAYOUT_CAPABILITY = 'project-clone-static-v1';
/** The box agent can make a multi-repo project's root a link to ~/code (agent/workspace.js). */
export const WORKSPACE_STATIC_ROOT_CAPABILITY = 'workspace-static-root-v1';

/**
 * The static layout's root under the box user's home: `~/code` (the box image already has ~/src/termag, its own
 * install, and the baked ~/src/webapp and ~/src/dev). One constant here and one in agent/static-layout.js.
 */
export const STATIC_LAYOUT_ROOT = 'code';

// One directory under the root, as the agent checks it: no `.`, `..`, hidden name or slash.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** The static layout's root on a box: `<home>/code`. */
export function staticCheckoutRoot(home: string): string {
  return `${home.replace(/\/+$/, '')}/${STATIC_LAYOUT_ROOT}`;
}

/** `<home>/code/<name>`, or null for a name that isn't one directory. */
export function staticCheckoutDir(home: string, name: string): string | null {
  if (!NAME_RE.test(name)) return null;
  return `${staticCheckoutRoot(home)}/${name}`;
}

/**
 * A repo project's checkout name under ~/code: the `path` its environment's
 * definition gives the repository, else the repository's own name. Null when
 * the definition can't be read (a pointer that couldn't be pinned when the
 * project was made, text that isn't JSON): its path for the repository is
 * unknown, so the project keeps its own directory.
 */
export function staticRepoName(project: { repoUrl: string | null; environmentFile: unknown }): string | null {
  const key = project.repoUrl ? repoKey(project.repoUrl) : null;
  if (!key) return null;
  const file = project.environmentFile && typeof project.environmentFile === 'object' ? project.environmentFile as { text?: unknown } : null;
  if (typeof file?.text !== 'string') return null;
  let data: { repos?: unknown };
  try { data = JSON.parse(file.text) as { repos?: unknown }; } catch { return null; }
  for (const r of Array.isArray(data?.repos) ? data.repos : []) {
    if (!r || typeof r !== 'object') continue;
    const entry = r as { repo?: unknown; path?: unknown };
    if (typeof entry.repo === 'string' && entry.repo.toLowerCase() === key && typeof entry.path === 'string' && NAME_RE.test(entry.path)) return entry.path;
  }
  return key.split('/')[1];
}

export type StaticLayoutDecision = { use: true } | { use: false; why: 'no-environment' | 'automation' | 'not-first' | 'not-managed' | 'old-agent' };

/**
 * Whether a project's clone asks the box for the static layout: the box was
 * made from an environment for this project, i.e. the project came from an
 * environment and is the box's first (as `environment-up` decides it,
 * services/projectEnvironment.ts), on a termag-managed box whose agent can.
 * A project already recorded there keeps it.
 */
export function staticLayoutDecision(
  project: { environmentId: string | null; kind: string; dir: string | null },
  instance: { userId: string | null; kind: string },
  capabilities: readonly string[],
  otherProjectsOnBox: number,
  capability: string = STATIC_LAYOUT_CAPABILITY,
): StaticLayoutDecision {
  if (project.dir) return { use: true };
  if (!project.environmentId) return { use: false, why: 'no-environment' };
  if (project.kind === 'automation') return { use: false, why: 'automation' };
  if (!isManagedBox(instance)) return { use: false, why: 'not-managed' };
  if (otherProjectsOnBox > 0) return { use: false, why: 'not-first' };
  if (!capabilities.includes(capability)) return { use: false, why: 'old-agent' };
  return { use: true };
}
