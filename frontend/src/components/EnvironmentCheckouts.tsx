import type { EnvironmentRepoView } from '../services/api';

/**
 * What a create from an environment clones, on screen
 * before Create or Send: each repository, at its branch and in its directory
 * when the definition names them. Anyone can edit a shared environment, and an
 * ask of the project runs these without asking, so they are shown, not only
 * echoed back as the create's environmentRepos.
 */
export function EnvironmentCheckouts({ repos, className }: { repos: readonly EnvironmentRepoView[]; className: string }) {
  return (
    <div className={className}>
      Clones {repos.map((r, i) => (
        <span key={r.repo}>
          {i ? ', ' : ''}<code>{r.repo}</code>
          {r.branch ? <> at <code>{r.branch}</code></> : null}
          {r.path ? <> in <code>{r.path}</code></> : null}
        </span>
      ))}
    </div>
  );
}
