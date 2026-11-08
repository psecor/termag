/**
 * Map a token-usage source bucket back to (project, workstream).
 *
 * Agents don't know about projects; they return the best path hint they have —
 * for Claude the inline `cwd` of the session (already un-remapped to the
 * backend's /home/<user>/... layout) plus the encoded log-dir name. We rebuild
 * every legal directory from the user's projects with projectDir() and match,
 * longest path first, with a '/' guard so `.../termag-dev` never lands in
 * `termag`. Encoded dirs are matched only exactly or via the `--worktrees-`
 * suffix — no generic dash-prefixing, which would be ambiguous.
 * Same reconstruct-don't-parse stance as sessionResolver / worktimeProjects.
 */
import { projectDir } from './tmux';

export interface ProjectCandidate {
  id: string;
  name: string;
  workstreams: string[]; // names; 'main' is implied
  /** Project.dir: the static layout's checkout (~/code/<repo>, or ~/code), which a process there reports. */
  dir?: string | null;
  /** The project's box: two boxes made from one environment both have ~/code/<repo>. */
  instanceId?: string | null;
}

/** A project's main directory in each spelling a source can report: its project directory, and its static checkout. */
function mainDirs(username: string, p: ProjectCandidate): string[] {
  const own = projectDir(username, p.name, 'main');
  return p.dir && p.dir !== own ? [own, p.dir] : [own];
}

/** A workstream's directory under a main directory, as projectDirUnder lays it out. */
const underMain = (main: string, ws: string): string => (ws === 'main' ? main : `${main}/.worktrees/${ws}`);

export interface UsageSourceHint {
  cwdHint: string | null;
  dir?: string | null; // Claude's encoded log-dir name
  /** The box the source was scanned on: of two projects at the same path, that box's wins. */
  instanceId?: string | null;
}

export const encodeClaudeDir = (p: string): string => p.replace(/[/.]/g, '-');

/**
 * The scanned box's own projects decide first, whatever path matches longest on
 * another box: two boxes made from environments can hold the same path for
 * different projects (a single-repo project's ~/code/web on one, a multi-repo
 * root ~/code on the other). Other boxes' projects are tried only when the
 * source isn't under any of this box's projects, for a project that moved
 * boxes; a source under one of them that none matches (an encoded log dir is
 * matched exactly, never by prefix) stays unattributed. With no box in the
 * hint, every project is one pool, first match on equal paths.
 */
export function resolveUsageSource(
  hint: UsageSourceHint,
  username: string,
  projects: readonly ProjectCandidate[],
): { projectId: string; workstream: string } | null {
  if (hint.instanceId === undefined) return resolveAmong(hint, username, projects);
  const onHost = (p: ProjectCandidate) => p.instanceId !== undefined && p.instanceId === hint.instanceId;
  const mine = projects.filter(onHost);
  const hit = resolveAmong(hint, username, mine);
  if (hit || underAny(hint, username, mine)) return hit;
  return resolveAmong(hint, username, projects.filter(p => !onHost(p)));
}

/**
 * Whether the source is inside one of these projects' directories, whether or not it resolves to one. By its cwd
 * when it has one, which is exact. Only without one by its encoded log dir, which can't tell `web/api` from a
 * sibling `web-api`: any continuation of a project's encoding counts as inside, so such a source stays unattributed
 * rather than going to another box.
 */
function underAny(hint: UsageSourceHint, username: string, projects: readonly ProjectCandidate[]): boolean {
  const cwd = hint.cwdHint;
  if (cwd) return projects.some(p => mainDirs(username, p).some(d => cwd === d || cwd.startsWith(d + '/')));
  const dir = hint.dir;
  if (!dir) return false;
  return projects.some(p => mainDirs(username, p).some(d => dir === encodeClaudeDir(d) || dir.startsWith(encodeClaudeDir(d) + '-')));
}

function resolveAmong(
  hint: UsageSourceHint,
  username: string,
  projects: readonly ProjectCandidate[],
): { projectId: string; workstream: string } | null {
  if (hint.cwdHint) {
    let best: { projectId: string; workstream: string; path: string } | null = null;
    for (const p of projects) {      const wsNames = ['main', ...p.workstreams.filter(w => w !== 'main')];
      for (const main of mainDirs(username, p)) {
        for (const ws of wsNames) {
          const path = underMain(main, ws);
          if (hint.cwdHint === path || hint.cwdHint.startsWith(path + '/')) {
            if (!best || path.length > best.path.length) best = { projectId: p.id, workstream: ws, path };
          }
        }
      }
    }
    if (best) {
      // Known project, unknown worktree (workstream row deleted, or created by hand):
      // keep the project, preserve the worktree name.
      if (best.workstream === 'main') {
        const rest = hint.cwdHint.slice(best.path.length);
        const m = rest.match(/^\/\.worktrees\/([^/]+)/);
        if (m) return { projectId: best.projectId, workstream: m[1] };
      }
      return { projectId: best.projectId, workstream: best.workstream };
    }
  }
  if (hint.dir) {
    for (const p of projects) {
      for (const dir of mainDirs(username, p)) {
        const main = encodeClaudeDir(dir);
        if (hint.dir === main) return { projectId: p.id, workstream: 'main' };
        const prefix = main + '--worktrees-';
        if (hint.dir.startsWith(prefix)) {
          const tail = hint.dir.slice(prefix.length);
          // Encoded names lose '/' vs '.', so prefer a known workstream whose
          // encoding matches; otherwise keep the raw tail.
          const ws = p.workstreams.find(w => encodeClaudeDir(w) === tail) ?? tail;
          return { projectId: p.id, workstream: ws };
        }
      }
    }
  }
  return null;
}
