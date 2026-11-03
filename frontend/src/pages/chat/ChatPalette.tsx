// ⌘K under the simple UI's chrome refresh:
// the palette's own model (components/SearchPalette.tsx
// usePaletteModel), drawn with LaunchPad. A SearchField over a ListBox in an
// Autocomplete, so the field keeps the focus while ↑/↓ walk the results and
// Enter opens one, in a Modal. Sessions read as the sidebar's rows do: the
// state's mark, Claude's title for the session, where it is and its state, its
// box and how long it has been so.
import React, { useMemo, useRef, useSyncExternalStore } from 'react';
import {
  Autocomplete, Dialog, Group, Header, IconButton, Input, ListBox, ListBoxItem, ListBoxSection, Modal, ModalOverlay, SearchField,
} from '@launchpad-ui/components';
import { Icon, type IconName } from '@launchpad-ui/icons';
import { BoxPill } from '../../components/BoxPill';
import { Highlight, usePaletteModel, type PaletteViewProps } from '../../components/SearchPalette';
import { LP_THEME } from '../../launchpad/theme';
import { CHAT_NARROW_QUERY } from '../../chat/chatLayout';
import { chatLiveKey, type ChatLiveStatus } from '../../chat/chatLiveStatus';
import { agentLabel } from '../../chat/explorerAgents';
import { chatRowState, type RowStateKind } from '../../chat/rowState';
import { chatRowName } from '../../chat/simpleChat';
import { stateSince, type InboxRow } from '../../mobile/inbox';
import { focusLine, paneHitKey, paneSearchScope } from '../../mobile/paneSearch';
import { fmtAge } from '../../utils/format';
import { LANE_SHORT, rowLabel, rowParam } from '../../utils/prPipeline';
import { hitStatus, type PaletteItem as Item } from '../../utils/searchPalette';
import { currentSearchShortcut } from '../../utils/workspaceTarget';
import { useSimpleDataIfAny } from './simpleData';
import { StatusMark } from './StatusMark';

const SHORTCUT = currentSearchShortcut();
const NO_LIVE: ReadonlyMap<string, ChatLiveStatus> = new Map();
const NO_SETUP: ReadonlyMap<string, string | null | undefined> = new Map();
const NO_UNSEEN: ReadonlySet<string> = new Set();
const PLACEHOLDER = 'Search sessions, pull requests and pane text';
/** A phone's field shows about 30 characters at 16px. */
const PLACEHOLDER_NARROW = 'Search sessions, PRs, pane text';

const onNarrowChange = (cb: () => void) => {
  const mq = window.matchMedia?.(CHAT_NARROW_QUERY);
  mq?.addEventListener?.('change', cb);
  return () => mq?.removeEventListener?.('change', cb);
};
const narrowNow = () => window.matchMedia?.(CHAT_NARROW_QUERY).matches ?? false;

/** A pane hit's state, as a session row's mark: the pane search only knows the hook status. */
const HIT_MARK: Record<ReturnType<typeof hitStatus>, RowStateKind> = { working: 'working', waiting: 'unread', idle: 'done', not_running: 'off' };

/** Each item's ListBox key, unique across the list. */
function keyOf(it: Item): string {
  switch (it.kind) {
    case 'action': return `a:${it.action.id}`;
    case 'row': return `r:${it.row.key}`;
    case 'pr': return `p:${rowParam(it.row)}`;
    case 'cta': return 'cta';
    case 'hit': return `h:${paneHitKey(it.hit)}`;
    case 'recent-query': return `q:${it.q}`;
  }
}

/** Forgets the recent search under the highlight: Shift+Delete, or ⌘⌫ (Ctrl+Backspace off a Mac). */
const isForgetKey = (e: React.KeyboardEvent) => (e.key === 'Delete' && e.shiftKey) || (e.key === 'Backspace' && (e.metaKey || e.ctrlKey));

export function ChatPalette(props: PaletteViewProps) {
  const { now, boxNameOf, onClose } = props;
  const m = usePaletteModel(props);
  // The sidebar's live states and titles; outside its data (a test), the hooks' alone.
  const data = useSimpleDataIfAny();
  const live = data?.live ?? NO_LIVE;
  const setupOf = data?.setupOf ?? NO_SETUP;
  const unseen = data?.unseen ?? NO_UNSEEN;
  const titlesShown = data?.titlesShown ?? false;
  const narrow = useSyncExternalStore(onNarrowChange, narrowNow, () => false);
  const byKey = useMemo(() => new Map(m.items.map(it => [keyOf(it), it])), [m.items]);
  const of = <K extends Item['kind']>(kind: K) => m.items.filter((it): it is Extract<Item, { kind: K }> => it.kind === kind);

  const session = (it: Extract<Item, { kind: 'row' }>) => {
    const r = it.row;
    // Its mark and words as the sidebar's row has them, a stop you haven't seen included.
    const state = chatRowState(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId), unseen.has(r.key));
    const named = chatRowName(r, titlesShown);
    const name = named.title ?? agentLabel(r);
    const since = stateSince(r);
    const age = since ? fmtAge(Math.max(0, now - Date.parse(since))) : null;
    const sub = [named.title ? named.where : null, state.text, r.shared ? 'shared' : null, r.kind === 'cloud' ? 'cloud' : null].filter(Boolean).join(' · ');
    const box = boxNameOf?.(r);
    return (
      <ListBoxItem key={keyOf(it)} id={keyOf(it)} textValue={name} className="chat-palette-item" data-status={state.kind}>
        <StatusMark kind={state.kind} />
        <span className="chat-palette-body">
          <span className="chat-palette-title">{name}</span>
          {sub && <span className="chat-palette-sub">{sub}</span>}
        </span>
        {box && <BoxPill instanceId={r.instanceId} label={box} className="chat-palette-box" />}
        {age && <span className="chat-palette-meta">{age}</span>}
      </ListBoxItem>
    );
  };

  const pr = (it: Extract<Item, { kind: 'pr' }>) => {
    const r = it.row;
    const at = r.requestedAt ?? r.mergedAt ?? r.at;
    const title = r.kind === 'pr' ? r.title : r.headRefName;
    const sub = [rowLabel(r), r.kind === 'pr' ? LANE_SHORT[r.lane] : 'no pull request yet'].join(' · ');
    return (
      <ListBoxItem key={keyOf(it)} id={keyOf(it)} textValue={`${title} ${rowLabel(r)}`} className="chat-palette-item">
        <Icon name="arrow-merge" size="medium" className="chat-palette-icon" aria-hidden="true" />
        <span className="chat-palette-body">
          <span className="chat-palette-title">{title}</span>
          <span className="chat-palette-sub">{sub}</span>
        </span>
        {at && <span className="chat-palette-meta">{fmtAge(Math.max(0, now - Date.parse(at)))}</span>}
      </ListBoxItem>
    );
  };

  const hit = (it: Extract<Item, { kind: 'hit' }>) => {
    const h = it.hit;
    const name = h.workstream === 'main' ? h.projectName : `${h.projectName} · ${h.workstream}`;
    const sub = [h.role, h.access !== 'owner' ? `shared by ${h.owner}` : null].filter(Boolean).join(' · ');
    return (
      <ListBoxItem key={keyOf(it)} id={keyOf(it)} textValue={name} className="chat-palette-item chat-palette-hit">
        <StatusMark kind={HIT_MARK[hitStatus(h.status)]} />
        <span className="chat-palette-body">
          <span className="chat-palette-title">{name}</span>
          <span className="chat-palette-sub">{sub}</span>
          {/* Pane text is untrusted output: plain text, and kept out of session replays. */}
          <span className="chat-palette-lines replay-block">
            {h.matches.map(line => (
              <span key={line.line} className="chat-palette-line"><span className="chat-palette-lineno">{line.line}</span><Highlight text={focusLine(line.text, it.q, 40)} needle={it.q} /></span>
            ))}
          </span>
        </span>
        <span className="chat-palette-meta">{h.matchCount} {h.matchCount === 1 ? 'match' : 'matches'}</span>
      </ListBoxItem>
    );
  };

  const recentQuery = (it: Extract<Item, { kind: 'recent-query' }>) => (
    <ListBoxItem key={keyOf(it)} id={keyOf(it)} textValue={it.q} className="chat-palette-item chat-palette-recent" aria-keyshortcuts="Shift+Delete Meta+Backspace">
      <Icon name="clock-history" size="medium" className="chat-palette-icon" aria-hidden="true" />
      <span className="chat-palette-body"><span className="chat-palette-title">{it.q}</span></span>
      {/* A press here would open the search, so this one is the pointer's; the keys are aria-keyshortcuts' (isForgetKey). */}
      <IconButton
        icon="cancel"
        size="small"
        variant="minimal"
        aria-label={`Forget the search ${it.q}`}
        aria-hidden="true"
        excludeFromTabOrder
        className="chat-palette-forget"
        onPress={() => m.forget(it.q)}
      />
    </ListBoxItem>
  );

  const command = (it: Extract<Item, { kind: 'action' }>) => {
    const a = it.action;
    return (
      <ListBoxItem key={keyOf(it)} id={keyOf(it)} textValue={a.label} className="chat-palette-item chat-palette-command">
        <Icon name={(a.icon ?? 'arrow-right-thin') as IconName} size="medium" className="chat-palette-icon" aria-hidden="true" />
        <span className="chat-palette-body">
          <span className="chat-palette-title">{a.label}</span>
          {a.detail && <span className="chat-palette-sub">{a.detail}</span>}
        </span>
        {a.keys && <kbd className="chat-palette-keys" aria-hidden="true">{a.keys}</kbd>}
      </ListBoxItem>
    );
  };

  const actions = of('action');
  const disabledKeys = actions.filter(it => it.action.disabled).map(keyOf);
  const rows = of('row');
  const prs = of('pr');
  const cta = of('cta');
  const hits = of('hit');
  const recents = of('recent-query');
  const paneState = m.pane?.q === m.q ? m.pane : null;
  const paneNote = paneState?.state === 'loading' ? 'Searching every live pane…'
    : paneState?.state === 'error' ? paneState.error
      : m.paneDone ? (m.paneDone.hits.length === 0 ? `No pane mentions “${m.q}” · ${paneSearchScope(m.paneDone)}` : paneSearchScope(m.paneDone))
        : null;

  // Enter with nothing highlighted. React Aria highlights the first item only as you type forward;
  // a paste or a deletion leaves none (for screen readers). Enter then opens the first item, as it
  // always has, or, with nothing to open, searches the pane text again.
  const inputRef = useRef<HTMLInputElement>(null);
  const onSubmit = () => {
    if (inputRef.current?.getAttribute('aria-activedescendant')) return;
    const first = m.items.find(it => !(it.kind === 'action' && it.action.disabled));
    if (first) m.choose(first);
    else m.searchPaneText();
  };

  // The highlighted item is the field's active descendant (Autocomplete's virtual focus).
  const onFieldKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isForgetKey(e)) return;
    const id = e.currentTarget.getAttribute('aria-activedescendant');
    const key = id ? document.getElementById(id)?.closest('[data-key]')?.getAttribute('data-key') : null;
    const it = key ? byKey.get(key) : undefined;
    if (it?.kind !== 'recent-query') return;
    e.preventDefault();
    m.forget(it.q);
  };

  return (
    <ModalOverlay isOpen isDismissable onOpenChange={open => { if (!open) onClose(); }} className={`${LP_THEME} chat-palette-layer`}>
      <Modal className="chat-palette">
        <Dialog aria-label="Search" className="chat-palette-dialog">
          <Autocomplete inputValue={m.query} onInputChange={m.setQuery}>
            <SearchField aria-label={PLACEHOLDER} autoFocus className="chat-palette-field" onSubmit={onSubmit}>
              <Group className="chat-palette-group">
                <Icon name="search" size="medium" className="chat-palette-field-icon" aria-hidden="true" />
                <Input ref={inputRef} placeholder={narrow ? PLACEHOLDER_NARROW : PLACEHOLDER} onKeyDown={onFieldKey} />
                <IconButton icon="cancel" size="small" variant="minimal" aria-label="Clear the search" className="chat-palette-clear" />
              </Group>
            </SearchField>
            {/* The first item is highlighted from the start, so ⌘K Enter reopens the most recent, as it always has. */}
            <ListBox
              aria-label="Results"
              autoFocus="first"
              disabledKeys={disabledKeys}
              className="chat-palette-list"
              onAction={key => { const it = byKey.get(String(key)); if (it) m.choose(it); }}
              renderEmptyState={() => (
                <div className="chat-palette-empty">{m.searching ? `Nothing matches “${m.q}”.` : 'Nothing opened recently. Search for a session, a pull request or text in a pane.'}</div>
              )}
            >
              {/* Each section is keyed by its id: React would otherwise reuse one across the two lists, and React Aria refuses an item whose id changes. */}
              {m.searching ? (
                <>
                  {actions.length > 0 && (
                    <ListBoxSection key="actions" id="actions" className="chat-palette-section">
                      <Header className="chat-palette-head">Commands</Header>
                      {actions.map(command)}
                    </ListBoxSection>
                  )}
                  {rows.length > 0 && (
                    <ListBoxSection key="sessions" id="sessions" className="chat-palette-section">
                      <Header className="chat-palette-head">Sessions <span className="chat-palette-count">{rows.length}</span></Header>
                      {rows.map(session)}
                    </ListBoxSection>
                  )}
                  {prs.length > 0 && (
                    <ListBoxSection key="prs" id="prs" className="chat-palette-section">
                      <Header className="chat-palette-head">Pull requests <span className="chat-palette-count">{prs.length}</span></Header>
                      {prs.map(pr)}
                    </ListBoxSection>
                  )}
                  {(cta.length > 0 || hits.length > 0 || paneNote) && (
                    <ListBoxSection key="panes" id="panes" className="chat-palette-section">
                      <Header className="chat-palette-head">
                        Pane text{paneNote && <span className="chat-palette-note" role={paneState?.state === 'error' ? 'alert' : undefined}> · {paneNote}</span>}
                      </Header>
                      {cta.map(it => (
                        <ListBoxItem key={keyOf(it)} id={keyOf(it)} textValue={`Search pane text for ${it.q}`} className="chat-palette-item chat-palette-cta">
                          <Icon name="text-box-search" size="medium" className="chat-palette-icon" aria-hidden="true" />
                          <span className="chat-palette-body"><span className="chat-palette-title">Search pane text for “{it.q}”</span></span>
                        </ListBoxItem>
                      ))}
                      {hits.map(hit)}
                    </ListBoxSection>
                  )}
                </>
              ) : (
                <>
                  {recents.length > 0 && (
                    <ListBoxSection key="recent-searches" id="recent-searches" className="chat-palette-section">
                      <Header className="chat-palette-head">Recent searches</Header>
                      {recents.map(recentQuery)}
                    </ListBoxSection>
                  )}
                  {rows.length > 0 && (
                    <ListBoxSection key="recent-sessions" id="recent-sessions" className="chat-palette-section">
                      <Header className="chat-palette-head">Recent sessions</Header>
                      {rows.map(session)}
                    </ListBoxSection>
                  )}
                  {actions.length > 0 && (
                    <ListBoxSection key="suggested" id="suggested" className="chat-palette-section">
                      <Header className="chat-palette-head">Commands</Header>
                      {actions.map(command)}
                    </ListBoxSection>
                  )}
                </>
              )}
            </ListBox>
          </Autocomplete>
          <footer className="chat-palette-foot" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
            <span><kbd>↵</kbd> to open</span>
            <span><kbd>esc</kbd> to close</span>
            <span className="chat-palette-foot-end"><kbd>{SHORTCUT}</kbd></span>
          </footer>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

/**
 * What ⌘K calls a session and finds it by under the refresh, as the sidebar
 * names it (chatRowName): an ask thread's title always, and Claude's title for
 * any other session while titles are shown.
 */
export function paletteNameOf(titlesShown: boolean): (row: InboxRow) => string | null {
  return row => chatRowName(row, titlesShown).title;
}
