import React from 'react';
import { MULTI_REPO_MAX, suggestRepoName, type ExtraRepo } from '../utils/multiRepo';

/**
 * Multi-repo projects, behind
 * multi-repo-projects-enabled: callers render this only while it is on.
 */

/** New project: repositories checked out beside the one picked above, each under its own directory. */
export function ExtraReposField({ value, onChange, primaryCount }: {
  value: ExtraRepo[];
  onChange: (next: ExtraRepo[]) => void;
  /** How many repositories the picker holds, 0 for an empty project. */
  primaryCount: number;
}) {
  const full = value.length + primaryCount >= MULTI_REPO_MAX;
  function set(i: number, patch: Partial<ExtraRepo>) {
    onChange(value.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  }
  return (
    <div className="npf-field mr-extra">
      {value.length > 0 && <label>More repositories</label>}
      {value.map((row, i) => (
        <div key={i} className="npf-field npf-inline mr-extra-row">
          <input
            aria-label={`Repository ${i + 2} URL`}
            value={row.url}
            onChange={e => set(i, { url: e.target.value })}
            placeholder="https://github.com/owner/repo"
          />
          <input
            aria-label={`Repository ${i + 2} directory`}
            className="mr-extra-name"
            value={row.name}
            onChange={e => set(i, { name: e.target.value })}
            placeholder={row.url.trim() ? suggestRepoName(row.url) : 'directory'}
          />
          <button type="button" className="btn-tiny" aria-label="Remove repository" onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button
        type="button"
        className="btn-ghost mr-add"
        disabled={full}
        title={full ? `A project holds at most ${MULTI_REPO_MAX} repositories` : undefined}
        onClick={() => onChange([...value, { url: '', name: '' }])}
      >
        + Add another repository
      </button>
      {value.some(r => r.url.trim()) && (
        <div className="usage-dim npf-note">
          Each repository is cloned into its own directory under the project; the agent starts in the project directory once every clone is done.
        </div>
      )}
    </div>
  );
}
