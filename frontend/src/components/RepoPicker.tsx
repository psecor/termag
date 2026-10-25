import React, { useEffect, useMemo, useRef, useState } from 'react';
import { githubReposApi, projectsApi, ProjectTemplateInfo } from '../services/api';
import {
  catalogFromWire,
  degradedCatalog,
  githubRepoUrl,
  repoKey,
  repoOptions,
  type CatalogGroup,
  type CatalogRepo,
  type RepoCatalog,
  type RepoPick,
} from '../utils/repoPick';

export function RepoPicker({
  value,
  onChange,
  autoFocus,
  showPaste = true,
  dropdown = false,
}: {
  value: RepoPick;
  onChange: (next: RepoPick) => void;
  autoFocus?: boolean;
  /** The simplified form moves the paste field under Advanced settings. */
  showPaste?: boolean;
  /** The repositories open under the search field as a list, only while it has focus (the simple UI). */
  dropdown?: boolean;
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
        empty: a fresh directory with AGENTS.md and CLAUDE.md
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
      {dropdown ? (
        <RepoDropdown catalog={catalog} value={value} onChange={onChange} autoFocus={autoFocus} onRefresh={() => load(true)} />
      ) : (
      <>
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
      </>
      )}
      {showPaste && (
        <>
          <label htmlFor="npf-paste">Paste a URL</label>
          <input
            id="npf-paste"
            value={value.kind === 'pasted' ? value.url : ''}
            onChange={e => onChange({ kind: 'pasted', url: e.target.value })}
            placeholder="https://github.com/owner/repo"
          />
        </>
      )}
      {catalog && !catalog.ok && catalog.notice && <div className="npf-note">{catalog.notice}</div>}
    </div>
  );
}

/**
 * The repositories as a combobox: the list opens when the search field is
 * focused or clicked, sorted by name, one per row, narrowed as you type.
 * Closed, the field shows the chosen repository.
 */
function RepoDropdown({ catalog, value, onChange, autoFocus, onRefresh }: {
  catalog: RepoCatalog | null;
  value: RepoPick;
  onChange: (next: RepoPick) => void;
  autoFocus?: boolean;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const chosen = value.kind === 'listed' ? value.fullName : null;
  // Opened on the chosen repository, the field holds its name: list everything until it is edited.
  const filter = query === chosen ? '' : query;
  const groups = useMemo(() => (catalog ? repoOptions(catalog.groups, filter) : []), [catalog, filter]);
  const flat = useMemo(() => groups.flatMap(g => g.repos), [groups]);
  const listId = 'npf-repo-options';
  const optionId = (i: number) => `npf-repo-option-${i}`;

  const chosenIndex = flat.findIndex(r => r.fullName === chosen);
  // Typing highlights the best match; an empty field goes back to the current choice.
  useEffect(() => { setActive(filter ? 0 : chosenIndex); }, [filter]); // eslint-disable-line react-hooks/exhaustive-deps

  function openList() {
    if (open) return;
    setQuery(chosen ?? '');
    // Nothing highlighted but the current choice, so Enter can't swap it for the first row.
    setActive(chosenIndex);
    setOpen(true);
    // After the click that focused it, or its mouseup would clear the selection.
    setTimeout(() => input.current?.select(), 0);
  }

  function pick(repo: CatalogRepo) {
    onChange({ kind: 'listed', fullName: repo.fullName, defaultBranch: repo.defaultBranch });
    setOpen(false);
    setQuery('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) openList();
      else setActive(i => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openList();
      else setActive(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && open) {
      const target = flat[active];
      if (!filter && (!target || target.fullName === chosen)) {
        // Untouched list: Enter keeps the choice and submits the form.
        setOpen(false);
        setQuery('');
        return;
      }
      // Picks the highlighted repository rather than submitting the form.
      e.preventDefault();
      if (target) pick(target);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
      setQuery('');
    }
  }

  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  let n = -1;
  return (
    <div className="npf-field npf-inline">
      <div className="npf-combo">
        <input
          ref={input}
          id="npf-repo-search"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && flat[active] ? optionId(active) : undefined}
          autoComplete="off"
          value={open ? query : chosen ?? ''}
          autoFocus={autoFocus}
          onFocus={openList}
          onClick={openList}
          onBlur={() => { setOpen(false); setQuery(''); }}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onKeyDown={onKeyDown}
          placeholder="Search repositories"
        />
        {open && (
          <div className="npf-combo-list" id={listId} role="listbox" aria-label="Repositories"
            // Keeps focus in the field, so its blur does not close the list before a click lands.
            onMouseDown={e => e.preventDefault()}>
            {catalog === null && <div className="npf-note npf-combo-note">Loading repositories…</div>}
            {catalog !== null && flat.length === 0 && groups.every(g => g.status === 'ok') && (
              <div className="npf-note npf-combo-note">{filter ? `No repositories match “${filter.trim()}”` : 'No repositories'}</div>
            )}
            {groups.map(group => (
              <div key={`${group.kind}:${group.owner}`} role="group" aria-label={group.owner}>
                <div className="npf-repo-owner npf-combo-owner">{group.owner}</div>
                {group.status !== 'ok' && (
                  <div className="npf-note npf-combo-note">
                    {group.href ? <a href={group.href}>{group.text}</a> : group.text}
                  </div>
                )}
                {group.repos.map(repo => {
                  const i = ++n;
                  return (
                    <div
                      key={repo.fullName}
                      id={optionId(i)}
                      role="option"
                      aria-selected={repo.fullName === chosen}
                      className={`npf-combo-option${i === active ? ' is-active' : ''}${repo.fullName === chosen ? ' is-selected' : ''}`}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(repo)}
                    >
                      {repo.fullName}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="btn-ghost" onClick={onRefresh}>Refresh</button>
    </div>
  );
}
