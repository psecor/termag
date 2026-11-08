// The repo pill over a started session's composer, on its owner's multi-repo
// project while multi-repo-projects-enabled is on:
// the project's repositories as New session names
// them (`shop-web + shop-api`), and the same multi-select menu. The project's
// repositories are ticked and locked; ticking another adds it (cloned, then a
// worktree of it in every workstream), and its row and the pill show the
// clone until it is in, or failed with a Retry. A single-repository project
// has no pill: it cannot become a folder of repositories.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@launchpad-ui/components';
import type { Project } from '../../types';
import { FLAGS, useFlag } from '../../flags';
import { useProjects } from '../../contexts/ProjectContext';
import { useProjectRepos } from '../../hooks/useProjectRepos';
import { LP_THEME } from '../../launchpad/theme';
import type { ListedPick } from '../../utils/multiRepo';
import { inProject, LOCKED_HINT, repoFullName, repoPicks, reposState, repoStatusText } from '../../utils/projectRepos';
import { RepoPicker } from './RepoPicker';

export function SessionRepoPill({ project }: { project: Project }) {
  const on = useFlag(FLAGS.multiRepo, false);
  const shown = on && project.layout === 'workspace' && project.role !== 'collaborator';
  const { reloadProjects } = useProjects();
  const { repos, error, adding, add, retry } = useProjectRepos(shown ? project.id : null, () => { void reloadProjects(); });
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  if (!shown || !repos || repos.length === 0) return null;
  const picks = repoPicks(repos);
  const pending: ListedPick[] = [...adding].filter(f => !inProject(repos, f)).map(fullName => ({ kind: 'listed', fullName, defaultBranch: '' }));
  const [first, ...rest] = picks;
  const failed = repos.some(r => r.setupStatus === 'failed');
  return (
    <div ref={root} className={`chat-session-repos ${LP_THEME}`}>
      <RepoPicker
        pick={first}
        onPick={() => {}}
        open={open}
        onOpenChange={setOpen}
        more={[...rest, ...pending]}
        onToggle={repo => { if (!inProject(repos, repo.fullName)) void add(repo.fullName); }}
        session={{
          locked: new Set([...picks, ...pending].map(p => p.fullName)),
          rowNote: fullName => {
            if (adding.has(fullName)) return 'Adding…';
            const repo = repos.find(r => repoFullName(r.url) === fullName);
            return repo ? repoStatusText(repo) : null;
          },
          note: <>Tick a repository to add it to every workstream. {LOCKED_HINT}</>,
          state: pending.length > 0 ? 'cloning' : reposState(repos),
          footer: (error || failed) && (
            <div className="chat-session-repos-foot" role={error ? 'alert' : undefined}>
              {error && <span className="chat-session-repos-error">{error}</span>}
              {failed && <Button size="small" onPress={() => { void retry(); }}>Retry</Button>}
            </div>
          ),
        }}
      />
    </div>
  );
}
