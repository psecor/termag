import React, { useEffect, useRef, useState } from 'react';
import { githubReposApi, projectsApi, ProjectTemplateInfo } from '../services/api';
import {
  catalogFromWire,
  degradedCatalog,
  githubRepoUrl,
  repoKey,
  type CatalogGroup,
  type CatalogRepo,
  type RepoCatalog,
  type RepoPick,
} from '../utils/repoPick';

export function RepoPicker({
  value,
  onChange,
  autoFocus,
}: {
  value: RepoPick;
  onChange: (next: RepoPick) => void;
  autoFocus?: boolean;
}) {
  const [templates, setTemplates] = useState<ProjectTemplateInfo[]>([]);
  const [catalog, setCatalog] = useState<RepoCatalog | null>(null);
  const [query, setQuery] = useState('');
  const request = useRef(0);

  useEffect(() => {
    let cancelled = false;
    projectsApi.templates().then(rows => { if (!cancelled) setTemplates(rows); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function load(refresh: boolean) {
    const id = ++request.current;
    githubReposApi.list(refresh)
      .then(body => { if (request.current === id) setCatalog(catalogFromWire(body)); })
      .catch(() => { if (request.current === id) setCatalog(degradedCatalog()); });
  }

  useEffect(() => { load(false); }, []);

  const q = query.trim().toLowerCase();

  function visibleRepos(group: CatalogGroup): CatalogRepo[] {
    if (!q) return group.repos;
    return group.repos.filter(repo => repo.fullName.toLowerCase().includes(q));
  }

  function chooseStarter(template: ProjectTemplateInfo) {
    const key = repoKey(template.repoUrl);
    const row = key && catalog
      ? catalog.groups.flatMap(group => group.repos).find(repo => repoKey(githubRepoUrl(repo.fullName)) === key)
      : undefined;
    onChange(row
      ? { kind: 'listed', fullName: row.fullName, defaultBranch: row.defaultBranch }
      : { kind: 'starter', templateId: template.id, url: template.repoUrl });
  }

  function starterSelected(template: ProjectTemplateInfo): boolean {
    if (value.kind === 'starter') return value.templateId === template.id;
    if (value.kind !== 'listed') return false;
    return repoKey(githubRepoUrl(value.fullName)) === repoKey(template.repoUrl);
  }

  return (
    <div className="npf-field">
      <label htmlFor="npf-repo-search">Repository</label>
      <button
        type="button"
        className={value.kind === 'empty' ? 'npf-repo is-selected' : 'npf-repo'}
        onClick={() => onChange({ kind: 'empty' })}
      >
        empty — a fresh directory with AGENTS.md and CLAUDE.md
      </button>
      {templates.map(template => (
        <button
          key={template.id}
          type="button"
          className={starterSelected(template) ? 'npf-repo is-selected' : 'npf-repo'}
          onClick={() => chooseStarter(template)}
        >
          {template.label} — {template.blurb}
        </button>
      ))}
      <div className="npf-field npf-inline">
        <input
          id="npf-repo-search"
          value={query}
          autoFocus={autoFocus}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search repositories"
        />
        <button type="button" className="btn-ghost" onClick={() => load(true)}>Refresh</button>
      </div>
      <div className="npf-repos">
        {catalog === null && <div className="npf-note">Loading repositories…</div>}
        {catalog?.groups.map(group => {
          const repos = visibleRepos(group);
          if (repos.length === 0 && group.status === 'ok') return null;
          return (
            <div key={`${group.kind}:${group.owner}`}>
              <div className="npf-repo-owner">{group.owner}</div>
              {group.status !== 'ok' && (
                <div className="npf-note">
                  {group.href ? <a href={group.href}>{group.text}</a> : group.text}
                </div>
              )}
              {repos.map(repo => (
                <button
                  key={repo.fullName}
                  type="button"
                  className={value.kind === 'listed' && value.fullName === repo.fullName ? 'npf-repo is-selected' : 'npf-repo'}
                  onClick={() => onChange({ kind: 'listed', fullName: repo.fullName, defaultBranch: repo.defaultBranch })}
                >
                  {repo.fullName}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <label htmlFor="npf-paste">Paste a URL</label>
      <input
        id="npf-paste"
        value={value.kind === 'pasted' ? value.url : ''}
        onChange={e => onChange({ kind: 'pasted', url: e.target.value })}
        placeholder="https://github.com/owner/repo"
      />
      {catalog && !catalog.ok && catalog.notice && <div className="npf-note">{catalog.notice}</div>}
    </div>
  );
}
