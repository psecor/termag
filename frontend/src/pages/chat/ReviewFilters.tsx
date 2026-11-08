// The Reviews page's filter bar (chat/reviews.ts, "Filters"), at the top of
// the page as on GitHub's PR list: a search over title and number, then
// Repository (several at once), Review, Author, Draft, and the Hide bots and
// CI failing toggles, all LaunchPad. The filters live in the page's URL
// (useReviewFilters), so a reload or a shared link keeps them, and the last
// choice is remembered per user in this browser and comes back when the page
// is opened with no filters in its URL.
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button, Group, Input, ListBox, ListBoxItem, Menu, MenuItem, MenuTrigger, Popover, SearchField, Select, SelectValue, ToggleButton, IconButton,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { useAuth } from '../../contexts/AuthContext';
import {
  filtersFromSearch, filtersOnOpen, filtersToSearch, hasFilters, NO_FILTERS, readRememberedFilters, writeRememberedFilters,
  type DraftFilter, type QueueFilters, type ReviewStateFilter,
} from '../../chat/reviews';

const storage = () => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

/** The page's filters, read from and written to its URL, and remembered per user. */
export function useReviewFilters(): { filters: QueueFilters; setFilters: (patch: Partial<QueueFilters>) => void; clear: () => void } {
  const [params, setParams] = useSearchParams();
  const { user } = useAuth();
  const who = user?.email ?? null;
  const filters = useMemo(() => filtersFromSearch(params), [params]);
  // Once the user is known: a URL with filters (a shared link) becomes their last choice, and one with none
  // (the sidebar's link) brings the last choice back.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !who) return;
    restored.current = true;
    const { apply, remember } = filtersOnOpen(params, readRememberedFilters(storage(), who));
    if (remember) writeRememberedFilters(storage(), who, remember);
    if (apply) setParams(p => filtersToSearch(apply, p), { replace: true });
  }, [who, params, setParams]);
  const write = useCallback((next: QueueFilters) => {
    writeRememberedFilters(storage(), who, next);
    setParams(p => filtersToSearch(next, p), { replace: true });
  }, [who, setParams]);
  const setFilters = useCallback((patch: Partial<QueueFilters>) => write({ ...filters, ...patch }), [filters, write]);
  const clear = useCallback(() => write(NO_FILTERS), [write]);
  return { filters, setFilters, clear };
}

const REVIEW_OPTIONS: Array<{ id: ReviewStateFilter | 'all'; name: string }> = [
  { id: 'all', name: 'Any review state' },
  { id: 'not-approved', name: 'Not approved yet' },
  { id: 'approved', name: 'Approved' },
  { id: 'changes', name: 'Changes requested' },
];
const DRAFT_OPTIONS: Array<{ id: DraftFilter | 'all'; name: string }> = [
  { id: 'all', name: 'Drafts and ready' },
  { id: 'ready', name: 'Ready for review' },
  { id: 'draft', name: 'Drafts' },
];
const ANY = '__any';

/** A single choice as a compact Select: its button reads the choice, or the field's name when it is "all". */
function ChoiceSelect<K extends string>({ label, value, options, onChange, icon }: {
  label: string;
  value: K | null;
  options: ReadonlyArray<{ id: K | typeof ANY | 'all'; name: string }>;
  onChange: (value: K | null) => void;
  icon: React.ComponentProps<typeof Icon>['name'];
}) {
  const none = options[0].id;
  return (
    <Select
      aria-label={label}
      className={`${LP_THEME} rv-filter-select`}
      selectedKey={value ?? none}
      onSelectionChange={key => onChange(key == null || key === none ? null : String(key) as K)}
    >
      <Button variant="minimal" size="small" className="rv-filter-button" data-active={value ? '' : undefined}>
        <Icon name={icon} size="small" aria-hidden="true" />
        <SelectValue>{({ selectedText }) => (value ? selectedText : label)}</SelectValue>
        <Icon name="chevron-down" size="small" aria-hidden="true" />
      </Button>
      <Popover className={LP_THEME} placement="bottom start">
        <ListBox items={options} className="rv-filter-list">
          {o => <ListBoxItem id={o.id} textValue={o.name}>{o.name}</ListBoxItem>}
        </ListBox>
      </Popover>
    </Select>
  );
}

/** Repositories, several at once: a menu of checkable items, as GitHub's own repository filter. */
function RepoMenu({ repos, value, onChange }: { repos: readonly string[]; value: readonly string[]; onChange: (repos: string[]) => void }) {
  const selected = new Set(value.map(r => r.toLowerCase()));
  const label = value.length === 0 ? 'Repository' : value.length === 1 ? value[0].split('/')[1] ?? value[0] : `${value.length} repositories`;
  return (
    <MenuTrigger>
      <Button variant="minimal" size="small" className="rv-filter-button" data-active={value.length ? '' : undefined} aria-label={`Repository: ${value.length ? value.join(', ') : 'all'}`}>
        <Icon name="code" size="small" aria-hidden="true" />
        <span>{label}</span>
        <Icon name="chevron-down" size="small" aria-hidden="true" />
      </Button>
      <Popover placement="bottom start" className={`${LP_THEME} chat-menu-popover`}>
        <Menu
          aria-label="Repository"
          selectionMode="multiple"
          selectedKeys={selected}
          onSelectionChange={keys => onChange(keys === 'all' ? [...repos] : repos.filter(r => keys.has(r)))}
          renderEmptyState={() => <span className="rv-filter-empty">No repositories</span>}
        >
          {repos.map(r => <MenuItem key={r} id={r} textValue={r}>{r}</MenuItem>)}
        </Menu>
      </Popover>
    </MenuTrigger>
  );
}

export function ReviewFilterBar({ filters, setFilters, clear, repos, authors }: {
  filters: QueueFilters;
  setFilters: (patch: Partial<QueueFilters>) => void;
  clear: () => void;
  repos: readonly string[];
  authors: readonly string[];
}) {
  // A filter from a link may name a repo or author the queue no longer holds: it stays listed, so it can be unset.
  const repoList = useMemo(() => [...new Set([...repos, ...filters.repos.map(r => r.toLowerCase())])], [repos, filters.repos]);
  const authorOptions = useMemo(() => {
    const list = filters.author && !authors.some(a => a.toLowerCase() === filters.author!.toLowerCase()) ? [...authors, filters.author] : authors;
    return [{ id: ANY, name: 'Anyone' }, ...list.map(a => ({ id: a, name: a }))];
  }, [authors, filters.author]);
  const authorValue = filters.author ? authorOptions.find(o => o.id.toLowerCase() === filters.author!.toLowerCase())?.id ?? null : null;
  return (
    <div className={`${LP_THEME} rv-filters`} role="search" aria-label="Filter reviews">
      <SearchField
        aria-label="Search title or number"
        className="rv-filter-search"
        value={filters.q}
        onChange={q => setFilters({ q })}
        onClear={() => setFilters({ q: '' })}
      >
        <Group className="rv-filter-search-group">
          <Icon name="search" size="small" aria-hidden="true" className="rv-filter-search-icon" />
          <Input placeholder="Search title or number" />
          {filters.q && <IconButton icon="cancel" size="small" variant="minimal" aria-label="Clear the search" />}
        </Group>
      </SearchField>
      <div className="rv-filter-row">
        <RepoMenu repos={repoList} value={filters.repos} onChange={repos => setFilters({ repos })} />
        <ChoiceSelect label="Review" icon="check-circle" value={filters.review} options={REVIEW_OPTIONS} onChange={review => setFilters({ review })} />
        <ChoiceSelect label="Author" icon="person" value={authorValue} options={authorOptions} onChange={author => setFilters({ author })} />
        <ChoiceSelect label="Draft" icon="edit" value={filters.draft} options={DRAFT_OPTIONS} onChange={draft => setFilters({ draft })} />
        <ToggleButton size="small" className="rv-filter-toggle" isSelected={filters.hideBots} onChange={hideBots => setFilters({ hideBots })}>Hide bots</ToggleButton>
        <ToggleButton size="small" className="rv-filter-toggle" isSelected={filters.ciFailing} onChange={ciFailing => setFilters({ ciFailing })}>CI failing</ToggleButton>
        {hasFilters(filters) && <Button size="small" variant="minimal" className="rv-filter-clear" onPress={clear}>Clear filters</Button>}
      </div>
    </div>
  );
}
