// The repositories step of New session's project menu: + New project's
// "add repositories first" (⌥↵) and Add a repository to <project>…. It takes the whole popover, with no
// form crammed around it and one scroll: Back and what it's for in the header, one search (which also takes a
// pasted URL or owner/name), the picked repositories as chips, one-line rows with LaunchPad's check boxes, and
// the step's action pinned at the foot, always in view. ↵ on a highlighted repository picks it; ↵ on an empty
// search is the action; Esc is Back. LaunchPad's Autocomplete, SearchField, ListBox, TagGroup and Button.
import React, { useState } from 'react';
import {
  Autocomplete, Button, Group, Input, ListBox, ListBoxItem, SearchField, Tag, TagGroup, TagList,
} from '@launchpad-ui/components';
import { Icon } from '@launchpad-ui/icons';
import { LP_THEME } from '../../launchpad/theme';
import { listedRepo, pastedRepo, type PickedRepo } from '../../chat/projectPick';
import type { RepoCatalogState } from '../../chat/useRepoCatalog';

/** A pasted repository's row id. */
const PASTED = 'pasted';

export function RepoStep({ title, catalog, onRetryCatalog, picked, onPicked, max, action, onAction, busy = false, error = null, note, onBack, exclude = [], extra = null }: {
  /** The header beside Back: New project “Release notes”, Add a repository to termag. */
  title: string;
  catalog: RepoCatalogState;
  onRetryCatalog: () => void;
  picked: readonly PickedRepo[];
  onPicked: (picked: PickedRepo[]) => void;
  /** How many may be picked: 8 with multi-repo projects (a project's cap), 1 to add a repository or without them. */
  max: number;
  /** The pinned action's label: Create “Release notes”, Add to termag. */
  action: string;
  onAction: () => void;
  busy?: boolean;
  /** A one-line error over the action, after a create or an add was refused or failed (↵ retries). */
  error?: string | null;
  /** Beside the action: "2 repositories". */
  note?: string;
  onBack: () => void;
  /** Repositories not to offer (owner/name, any case): the ones the project already has. */
  exclude?: readonly string[];
  /** Under the list, above the action: New project's icon (ProjectIconPicker.tsx). Its keys are its own: ↵ there isn't the action. */
  extra?: React.ReactNode;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const pickedKeys = new Set(picked.map(r => r.fullName.toLowerCase()));
  const excluded = new Set(exclude.map(k => k.toLowerCase()));
  const listed = catalog.kind === 'ready' ? catalog.repos.filter(r => !excluded.has(r.fullName.toLowerCase())) : [];
  // The picked first, in the order picked, then the rest; the search narrows both.
  const rows = [
    ...picked.filter(r => !q || r.fullName.toLowerCase().includes(q)),
    ...listed.filter(r => !pickedKeys.has(r.fullName.toLowerCase()) && (!q || r.fullName.toLowerCase().includes(q))).map(listedRepo),
  ];
  // A URL or owner/name that isn't listed: its own row on top, so pasting has a home in plain sight.
  const pasted = pastedRepo(query);
  const pastedRow = pasted && !rows.some(r => r.fullName.toLowerCase() === pasted.fullName.toLowerCase())
    && !excluded.has(pasted.fullName.toLowerCase()) ? pasted : null;
  const byKey = new Map<string, PickedRepo>(rows.map(r => [r.fullName, r]));
  if (pastedRow) byKey.set(PASTED, pastedRow);

  function toggle(key: string) {
    const repo = byKey.get(key);
    if (!repo) return;
    const on = pickedKeys.has(repo.fullName.toLowerCase());
    if (on) onPicked(picked.filter(r => r.fullName.toLowerCase() !== repo.fullName.toLowerCase()));
    else if (max === 1) onPicked([repo]);
    else if (picked.length < max) onPicked([...picked, repo]);
    // Picked by name: the search has done its job, so it clears for the next one.
    setQuery('');
  }

  function onKeyDownCapture(e: React.KeyboardEvent) {
    // Esc is Back here (the menu keeps the draft), not the popover's close nor the search's clear.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onBack(); return; }
    // ↵ on an empty search is the step's action; with text, it picks the highlighted repository.
    if (e.key === 'Enter' && !q && (e.target as HTMLElement).closest?.('.chat-repo-step-actions, .chat-repo-step-extra') == null) {
      e.preventDefault(); e.stopPropagation();
      if (!busy) onAction();
    }
  }

  return (
    <div className={`${LP_THEME} chat-repo-step`} onKeyDownCapture={onKeyDownCapture}>
      <div className="chat-repo-step-head">
        <Button size="small" className="chat-repo-step-back" onPress={onBack} isDisabled={busy}>← Back</Button>
        <span className="chat-repo-step-title" title={title}>{title}</span>
      </div>
      <Autocomplete inputValue={query} onInputChange={setQuery}>
        <SearchField aria-label="Search repositories" autoFocus className={`${LP_THEME} chat-env-search chat-repo-step-search`}>
          <Group className="chat-env-search-group">
            <Icon name="search" size="medium" className="chat-env-search-icon" aria-hidden="true" />
            <Input placeholder="Search, or paste a repository URL" />
          </Group>
        </SearchField>
        {picked.length > 0 && (
          <TagGroup
            aria-label="Picked repositories"
            className="chat-repo-step-chips"
            onRemove={keys => onPicked(picked.filter(r => !keys.has(r.fullName)))}
          >
            <TagList>
              {picked.map(r => <Tag key={r.fullName} id={r.fullName} textValue={r.fullName}>{r.fullName.slice(r.fullName.indexOf('/') + 1)}</Tag>)}
            </TagList>
          </TagGroup>
        )}
        <ListBox
          aria-label="Repositories"
          autoFocus="first"
          className="chat-repo-step-list"
          selectionMode={max === 1 ? 'single' : 'multiple'}
          selectedKeys={[...picked.map(r => r.fullName)]}
          // One key changes per press: whichever was added or dropped.
          onSelectionChange={keys => {
            if (keys === 'all') return;
            const next = new Set([...keys].map(String));
            const added = [...next].find(k => k === PASTED || !picked.some(r => r.fullName === k));
            const dropped = picked.find(r => !next.has(r.fullName));
            toggle(added ?? dropped?.fullName ?? '');
          }}
          renderEmptyState={() => (
            <div className="chat-repo-step-empty">
              {catalog.kind === 'loading' ? 'Loading your repositories…'
                : catalog.kind === 'failed' ? <>Couldn't load your repositories. <Button size="small" variant="minimal" onPress={onRetryCatalog}>Try again</Button></>
                : q ? 'No repository matches. Paste its URL to add it.' : 'No repositories on this account. Paste a URL to add one.'}
            </div>
          )}
        >
          {[
            ...(pastedRow ? [(
              <ListBoxItem key={PASTED} id={PASTED} textValue={`Add ${pastedRow.fullName}`} className="chat-repo-step-option">
                Add {pastedRow.fullName}
              </ListBoxItem>
            )] : []),
            ...rows.map(r => (
              <ListBoxItem key={r.fullName} id={r.fullName} textValue={r.fullName} className="chat-repo-step-option">{r.fullName}</ListBoxItem>
            )),
          ]}
        </ListBox>
      </Autocomplete>
      {extra && <div className="chat-repo-step-extra">{extra}</div>}
      {error && <div className="chat-repo-step-error" role="alert">{error}</div>}
      <div className="chat-repo-step-actions">
        <Button variant="primary" size="small" onPress={onAction} isDisabled={busy}>{busy ? 'Working…' : <>{action} <span className="chat-project-key" aria-hidden="true">↵</span></>}</Button>
        <span className="chat-repo-step-note">{note}{note ? ' · ' : ''}Esc back</span>
      </div>
    </div>
  );
}
