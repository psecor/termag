// The repository control in the simple UI's New session composer, and the
// one the simple-mode automation form will reuse: a pill naming the pick, and
// a menu of the viewer's GitHub repositories by owner, with a search and a
// pasted URL. It loads the catalog itself; the parent holds the pick and
// whether the menu is open (closing it on an outside click or Escape, as it
// does for its other menus). With onToggle (multi-repo-projects-enabled)
// the repositories are LaunchPad's multi-select
// ListBox: a row toggles its repository and the menu stays open, so one or
// several can be chosen, and the chosen ones are pinned in a Selected section
// at the top.
import React, { useEffect, useRef, useState } from 'react';
import '@launchpad-ui/tokens/index.css';
import { Header, ListBox, ListBoxItem, ListBoxSection, type ListBoxProps } from '@launchpad-ui/components';
import { githubReposApi } from '../../services/api';
import { catalogFromWire, degradedCatalog, type CatalogGroup, type RepoCatalog, type RepoPick } from '../../utils/repoPick';
import { selectionLabel, type ListedPick } from '../../utils/multiRepo';
import { REPO_EMPTY, repoListView, repoTriggerLabel } from '../../chat/composer';

type Selection = Parameters<NonNullable<ListBoxProps<object>['onSelectionChange']>>[0];

export function RepoPicker({ pick, onPick, empty = pick.kind === 'empty', open, onOpenChange, more = [], onToggle }: {
  pick: RepoPick;
  /** A listed repository (the menu then closes), or a pasted URL as it is typed ('empty' once cleared). */
  onPick: (pick: RepoPick) => void;
  /** No repository to start in yet (none picked, or a URL that does not read as one): the pill shows as a placeholder. */
  empty?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The listed repositories ticked after the pick. */
  more?: readonly ListedPick[];
  /** A repository's row was clicked; the menu stays open. Without it a row picks that one repository and closes the menu. */
  onToggle?: (repo: ListedPick) => void;
}) {
  const [paste, setPaste] = useState(pick.kind === 'pasted' ? pick.url : '');
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<RepoCatalog | null>(null);
  const request = useRef(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  function loadRepos(refresh: boolean) {
    const id = ++request.current;
    if (refresh) setCatalog(null);
    githubReposApi.list(refresh)
      .then(body => { if (request.current === id) setCatalog(catalogFromWire(body)); })
      .catch(() => { if (request.current === id) setCatalog(degradedCatalog()); });
  }

  useEffect(() => { loadRepos(false); }, []);

  const list = repoListView(catalog);
  const q = query.trim().toLowerCase();

  // With onToggle, the chosen repositories sit in their own section at the
  // top, in the order they were chosen, whatever the search says.
  const selected: ListedPick[] = onToggle ? [...(pick.kind === 'listed' ? [pick] : []), ...more] : [];
  const pinned = new Set(selected.map(r => r.fullName));

  function visibleRepos(group: CatalogGroup) {
    const repos = group.repos.filter(repo => !pinned.has(repo.fullName));
    if (!q) return repos;
    return repos.filter(repo => repo.fullName.toLowerCase().includes(q));
  }

  function chooseListed(fullName: string, defaultBranch: string) {
    setPaste('');
    onPick({ kind: 'listed', fullName, defaultBranch });
    onOpenChange(false);
  }

  function onPaste(url: string) {
    setPaste(url);
    onPick(url.trim() ? { kind: 'pasted', url } : { kind: 'empty' });
  }

  function closeToTrigger() {
    onOpenChange(false);
    triggerRef.current?.focus();
  }

  // The ListBox moves between its rows and toggles them (Space or Enter).
  // Around it: ArrowDown from the search enters it, ArrowUp from its first row
  // goes back, and Escape closes the menu rather than clearing the choice.
  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') { e.preventDefault(); closeToTrigger(); return; }
    const first = listRef.current?.querySelector<HTMLElement>('[role="option"]');
    if (e.key === 'ArrowDown' && e.target === searchRef.current && first) {
      e.preventDefault();
      first.focus();
    } else if (e.key === 'ArrowUp' && e.target === first) {
      e.preventDefault();
      searchRef.current?.focus();
    }
  }

  function multiList(toggle: (repo: ListedPick) => void) {
    const groups = catalog?.ok ? catalog.groups : [];
    const sections = groups.map(group => ({ group, repos: visibleRepos(group) })).filter(s => s.repos.length > 0);
    const known = new Map<string, ListedPick>(selected.map(r => [r.fullName, r]));
    for (const group of groups) for (const repo of group.repos) {
      if (!known.has(repo.fullName)) known.set(repo.fullName, { kind: 'listed', fullName: repo.fullName, defaultBranch: repo.defaultBranch });
    }
    // One click changes one key; a select-all (Ctrl+A) is not a choice anyone made here.
    const onSelectionChange = (keys: Selection) => {
      if (keys === 'all') return;
      const changed = [...keys].map(String).find(k => !pinned.has(k)) ?? [...pinned].find(k => !keys.has(k));
      const repo = changed ? known.get(changed) : undefined;
      if (repo) toggle(repo);
    };
    const item = (fullName: string) => (
      <ListBoxItem key={fullName} id={fullName} textValue={fullName} className="chat-repo-option" data-repo={fullName}>{fullName}</ListBoxItem>
    );
    return (
      <>
        {(selected.length > 0 || sections.length > 0) && (
          <ListBox
            ref={listRef}
            aria-label="Repositories"
            className="chat-repo-list"
            selectionMode="multiple"
            escapeKeyBehavior="none"
            selectedKeys={pinned}
            onSelectionChange={onSelectionChange}
          >
            {selected.length > 0 && (
              <ListBoxSection id="selected">
                <Header>Selected</Header>
                {selected.map(r => item(r.fullName))}
              </ListBoxSection>
            )}
            {sections.map(({ group, repos }) => (
              <ListBoxSection key={`${group.kind}:${group.owner}`} id={`${group.kind}:${group.owner}`}>
                <Header>{group.owner}</Header>
                {repos.map(repo => item(repo.fullName))}
              </ListBoxSection>
            ))}
          </ListBox>
        )}
        {/* An owner whose repositories could not be listed: its note may be a link, which has no place inside a listbox. */}
        {groups.filter(g => g.status !== 'ok').map(group => (
          <div key={`${group.kind}:${group.owner}`}>
            <div className="chat-compose-owner">{group.owner}</div>
            <div className="chat-compose-note">{group.href ? <a href={group.href}>{group.text}</a> : group.text}</div>
          </div>
        ))}
      </>
    );
  }

  return (
    <div className="chat-compose-repo">
      <button
        ref={triggerRef}
        type="button"
        className="chat-compose-repo-btn"
        data-empty={empty ? '' : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => onOpenChange(!open)}
      >
        <span className="chat-compose-repo-name">{selectionLabel(repoTriggerLabel(pick), more)}</span>
      </button>
      {open && (
        <div
          className="chat-compose-menu"
          role={onToggle ? undefined : 'listbox'}
          aria-label={onToggle ? undefined : 'Repositories'}
          onKeyDown={onToggle ? onMenuKeyDown : undefined}
        >
          <input
            ref={searchRef}
            className="chat-compose-search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search repositories"
            aria-label="Search repositories"
            autoFocus
            onKeyDown={e => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (onToggle) closeToTrigger();
            }}
          />
          {onToggle && list.kind === 'ready' && <div className="chat-compose-note">Pick one, or several to work across them.</div>}
          {list.kind === 'loading' && <div className="chat-compose-note">Loading repositories…</div>}
          {list.kind === 'error' && (
            <div className="chat-compose-note" role="alert">
              {list.text}{' '}
              <button type="button" className="chat-compose-retry" onClick={() => loadRepos(true)}>Try again</button>
            </div>
          )}
          {list.kind === 'empty' && <div className="chat-compose-note">{REPO_EMPTY}</div>}
          {onToggle ? multiList(onToggle) : catalog?.ok && catalog.groups.map(group => {
            const repos = visibleRepos(group);
            if (repos.length === 0 && group.status === 'ok') return null;
            return (
              <div key={`${group.kind}:${group.owner}`}>
                <div className="chat-compose-owner">{group.owner}</div>
                {group.status !== 'ok' && (
                  <div className="chat-compose-note">
                    {group.href ? <a href={group.href}>{group.text}</a> : group.text}
                  </div>
                )}
                {repos.map(repo => (
                  <button
                    key={repo.fullName}
                    type="button"
                    role="option"
                    aria-selected={pick.kind === 'listed' && pick.fullName === repo.fullName}
                    className="chat-compose-option"
                    onClick={() => chooseListed(repo.fullName, repo.defaultBranch)}
                  >
                    {repo.fullName}
                  </button>
                ))}
              </div>
            );
          })}
          <label className="chat-compose-paste">
            <span>Repository URL</span>
            <input
              value={paste}
              onChange={e => onPaste(e.target.value)}
              placeholder="https://github.com/owner/repo"
              aria-label="Repository URL"
              onKeyDown={e => { if (e.key === 'Enter') e.preventDefault(); }}
            />
          </label>
        </div>
      )}
    </div>
  );
}
