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
}

export interface UsageSourceHint {
  cwdHint: string | null;
  dir?: string | null; // Claude's encoded log-dir name
}

export const encodeClaudeDir = (p: string): string => p.replace(/[/.]/g, '-');

export function resolveUsageSource(
  hint: UsageSourceHint,
  username: string,
  projects: readonly ProjectCandidate[],
): { projectId: string; workstream: string } | null {
  if (hint.cwdHint) {
    let best: { projectId: string; workstream: string; path: string } | null = null;
    for (const p of projects) {
      const wsNames = ['main', ...p.workstreams.filter(w => w !== 'main')];
      for (const ws of wsNames) {
        const path = projectDir(username, p.name, ws);
        if (hint.cwdHint === path || hint.cwdHint.startsWith(path + '/')) {
          if (!best || path.length > best.path.length) best = { projectId: p.id, workstream: ws, path };
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
      const main = encodeClaudeDir(projectDir(username, p.name, 'main'));
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
  return null;
}
