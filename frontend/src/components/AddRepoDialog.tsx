import { useState } from 'react';
import { Dialog } from './Dialog';
import { RepoPicker } from './RepoPicker';
import { useProjectRepos } from '../hooks/useProjectRepos';
import { toggleRepo, type ListedPick } from '../utils/multiRepo';
import { LOCKED_HINT, repoStatusText } from '../utils/projectRepos';
import { repoKey } from '../utils/repoPick';

/**
 * The classic UI's Add repository… on a multi-repo project's ⋮ menu:
 * the New project
 * dialog's multi-select list, add-only. The project's repositories are
 * ticked and locked; Add sends the newly ticked ones, and the list under it
 * follows each clone until it is in every workstream, or failed (Retry).
 */
export function AddRepoDialog({ project, onClose, onChanged }: {
  project: { id: string; name: string };
  onClose: () => void;
  onChanged: () => void;
}) {
  const { repos, error, adding, add, retry } = useProjectRepos(project.id, onChanged);
  const [ticked, setTicked] = useState<ListedPick[]>([]);
  const busy = adding.size > 0;
  const locked = new Set((repos ?? []).map(r => repoKey(r.url)).filter((k): k is string => !!k));
  const failed = (repos ?? []).some(r => r.setupStatus === 'failed');

  function toggle(repo: ListedPick) {
    setTicked(list => {
      const { pick, more } = toggleRepo({ pick: list[0] ?? { kind: 'empty' }, more: list.slice(1) }, repo);
      return pick.kind === 'listed' ? [pick, ...more] : [];
    });
  }

  async function addTicked() {
    for (const repo of ticked) {
      if (!(await add(repo.fullName))) return;
      setTicked(list => list.filter(r => r.fullName !== repo.fullName));
    }
  }

  return (
    <Dialog title={`Add a repository to “${project.name}”`} className="np-dialog" onClose={onClose} closeDisabled={busy}>
      <div className="npf">
        <div className="npf-note usage-dim">
          Each one is cloned beside the running sessions, then checked out in every workstream on its branch. {LOCKED_HINT}
        </div>
        {repos === null && !error && <div className="npf-note">Loading the project&apos;s repositories…</div>}
        {repos && (
          <>
            <RepoPicker value={ticked[0] ?? { kind: 'empty' }} onChange={() => {}} more={ticked.slice(1)} onToggle={toggle} addOnly={{ locked, hint: LOCKED_HINT }} />
            <ul className="ard-repos" aria-label="In this project">
              {[...repos].sort((a, b) => a.position - b.position).map(r => (
                <li key={r.name} data-status={r.setupStatus}>
                  <span className="ard-repo-name">{r.name}</span>
                  <span className="ard-repo-status">{repoStatusText(r) ?? 'ready'}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && <div className="error-text" role="alert">{error}</div>}
        <div className="npf-actions">
          {failed && <button type="button" className="btn-ghost" onClick={() => { void retry(); }}>Retry</button>}
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>Close</button>
          <button type="button" className="btn-primary" onClick={() => { void addTicked(); }} disabled={busy || ticked.length === 0}>
            {busy ? 'Adding…' : ticked.length > 1 ? `Add ${ticked.length} repositories` : 'Add'}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
