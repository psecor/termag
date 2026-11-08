// A space's explorer in the simple UI: one
// tree with the space's agents beside its files. An agent another agent
// started (or an ask it sent) is under it, the way a file is under its
// folder, shown until its starter is folded; folders load as
// they open. The search matches agent names and file names at every depth.
// Only agents whose box reaches the space are listed; the explorer never
// gives a box access to a space.
//
// It is the side panel's Files tab (SidePanel.tsx), with the file or agent
// shown highlighted and its folders or starting agents open (or, for a link
// to a folder, that folder open, scrolled to and highlighted), and a new tab
// (/chat/files/<space>, a space's + → New tab) lists the space's recent files
// and agents in the main pane, with Files beside it. Picking an agent or a
// file goes to its tab, else opens one (openItems.pickItem); "Open in new
// tab" (its ⋮, a right click, the context menu key or Shift+F10) opens
// another even when it has one. Listings, open folders
// and the search index are kept per space for the page's life, so moving
// between files doesn't reload the tree. With simple-ui-automations-enabled
// the space's automations are listed with its agents, each a row that opens
// its page with its runs under it (ExplorerTree.tsx, chat/automationPlaces.ts).
import React, { startTransition, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { spacesApi, type SpaceTree } from '../../services/api';
import { formatBytes } from '../../utils/spaces';
import { itemHref, type OpenItemRef } from '../../chat/openItems';
import { ancestorDirs, fileName, SEARCH_MAX_FILES_PER_SPACE, searchFiles, type SearchFile } from '../../chat/fileExplorer';
import { chatHomeSpace } from '../../chat/chatSpaces';
import { agentLabel, explorerAgents, searchAgents } from '../../chat/explorerAgents';
import { chatLiveKey } from '../../chat/chatLiveStatus';
import { sidebarLine } from '../../chat/simpleChat';
import type { InboxRow } from '../../mobile/inbox';
import { spaceRecents } from '../../chat/recents';
import { FILE_SHARE_EVENT, type FileShareChange } from '../../chat/fileShare';
import { ChatHistoryButton, ChatMoreButton, SidePanelButton, useChatChrome } from './chatChrome';
import { CloseAndBackButton } from './TabClose';
import { AgentIcon, FileIcon, FolderIcon, plainClick } from './OpenItems';
import { useSpaceListingLive } from './SpaceFileLive';
import { useSimpleData, WithSimpleData } from './simpleData';
import { useSpaceReach, type SpaceReach } from '../../chat/useSpaceReach';
import { Caret, Highlight, SearchIcon, sessionKey, useAgentTree, type AgentKey } from './ExplorerTree';
import { useAutomations } from '../../chat/useAutomations';
import { automationsIn, searchAutomations } from '../../chat/automationPlaces';

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

type Listing = { tree: SpaceTree | null; error: string | null; more?: boolean };
interface SpaceCache {
  listings: Map<string, Listing>;
  /** Open folders, by prefix ('' is the root). */
  expanded: Set<string>;
  /** Agents whose started agents are folded away, by session key; every other one shows them. */
  shut: Set<string>;
  index: { files: SearchFile[]; capped: boolean } | { error: string } | 'loading' | null;
  /** Bumped by Refresh; a reply from an older generation is dropped. */
  gen: number;
  /** The space's reach (chat/useSpaceReach.ts) when this panel last showed it; undefined before. */
  lastReach?: SpaceReach;
}

const caches = new Map<string, SpaceCache>();
function cacheOf(space: string): SpaceCache {
  let c = caches.get(space);
  if (!c) { c = { listings: new Map(), expanded: new Set(['']), shut: new Set(), index: null, gen: 0 }; caches.set(space, c); }
  return c;
}

// The file view shared or unshared a file: mark it in the listings kept for its space. Listened
// to for the page's life, like the caches, so a share made while no explorer is mounted (Tools
// closed) shows when one opens; a mounted explorer only redraws (Panel).
if (typeof window !== 'undefined') {
  window.addEventListener(FILE_SHARE_EVENT, e => {
    const { space, path, shared } = (e as CustomEvent<FileShareChange>).detail;
    for (const l of caches.get(space)?.listings.values() ?? []) {
      const f = l.tree?.files.find(x => x.path === path);
      if (f) f.shared = shared;
    }
  });
}

/** Every file path in a space, up to SEARCH_MAX_FILES_PER_SPACE. */
async function allFiles(space: string): Promise<{ files: SearchFile[]; capped: boolean }> {
  const files: SearchFile[] = [];
  let cursor: string | null = null;
  do {
    const page: SpaceTree = await spacesApi.tree(space, '', cursor, true);
    for (const f of page.files) files.push({ space, path: f.path, size: f.size, modifiedAt: f.modifiedAt });
    cursor = page.nextCursor;
  } while (cursor && files.length < SEARCH_MAX_FILES_PER_SPACE);
  return { files: files.slice(0, SEARCH_MAX_FILES_PER_SPACE), capped: cursor != null };
}

/** A file shared with everyone on termag (the file view's Share button). */
function SharedMark() {
  return (
    <svg className="fx-shared" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <circle cx="6" cy="5.5" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1.8 13.5c.4-2.4 2.1-3.8 4.2-3.8s3.8 1.4 4.2 3.8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M10.6 3.4a2.3 2.3 0 0 1 0 4.3M12.2 9.9c1.1.5 1.8 1.7 2 3.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

type PanelProps = {
  space: string; activePath?: string; activeAgent?: AgentKey;
  /** A folder shown ('' for the space; a link to a folder, ChatApp): open, scrolled to and highlighted like the file shown. */
  activeDir?: string;
  /** Something was picked. */
  onPicked?: () => void;
  /** A folder to open, scroll to and focus ('' for the space); `n` changes on each ask. */
  reveal?: { dir: string; n: number };
};

/** The explorer for `space`, with `activePath`, `activeDir` or `activeAgent` (if any) highlighted and revealed. */
export function ExplorerPanel(props: PanelProps) {
  return <WithSimpleData><Panel {...props} /></WithSimpleData>;
}

function Panel({ space, activePath, activeAgent, activeDir, onPicked, reveal }: PanelProps) {
  const { items, rows, live, setupOf, spaces, links, activeTab } = useSimpleData();
  const navigate = useNavigate();
  const [tick, rerender] = useReducer((n: number) => n + 1, 0);
  const [query, setQuery] = useState('');
  const cache = cacheOf(space);
  const agents = useMemo(() => explorerAgents(rows, space, spaces.index, links), [rows, space, spaces.index, links]);
  const { enabled: automationsOn, list: automationList } = useAutomations();
  const placed = useMemo(() => (automationsOn ? automationsIn(automationList, space, spaces.spaces) : []), [automationsOn, automationList, space, spaces.spaces]);
  const reach = useSpaceReach(spaces, space);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  // The folder still to scroll to (and focus, for a breadcrumb's), once its row (its parent's listing) is drawn.
  const pendingReveal = useRef<{ dir: string; focus: boolean } | null>(null);

  useEffect(() => { setQuery(''); setRevealed(null); }, [space]);

  // The file view shared or unshared a file of this space: redraw its mark (the listings were marked above).
  useEffect(() => {
    const onShare = (e: Event) => {
      if ((e as CustomEvent<FileShareChange>).detail.space === space) rerender();
    };
    window.addEventListener(FILE_SHARE_EVENT, onShare);
    return () => window.removeEventListener(FILE_SHARE_EVENT, onShare);
  }, [space]);

  useEffect(() => {
    if (!reveal) return;
    setQuery('');
    const c = cacheOf(space);
    for (const d of ancestorDirs(reveal.dir)) c.expanded.add(d);
    pendingReveal.current = { dir: reveal.dir, focus: true };
    setRevealed(reveal.dir);
    rerender();
  }, [space, reveal?.dir, reveal?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // A folder linked to: it and the folders above it open, then scrolled to, leaving focus where it is.
  useEffect(() => {
    if (activeDir == null) return;
    setQuery('');
    const c = cacheOf(space);
    for (const d of ancestorDirs(activeDir)) c.expanded.add(d);
    pendingReveal.current = { dir: activeDir, focus: false };
    rerender();
  }, [space, activeDir]);

  useEffect(() => {
    const pending = pendingReveal.current;
    const body = bodyRef.current;
    if (pending == null || !body) return;
    if (pending.dir === '') {
      pendingReveal.current = null;
      body.scrollTop = 0;
      if (pending.focus) body.querySelector<HTMLElement>('.fx-row')?.focus({ preventScroll: true });
      return;
    }
    const row = [...body.querySelectorAll<HTMLElement>('[data-dir]')].find(el => el.dataset.dir === pending.dir);
    if (!row) return;
    pendingReveal.current = null;
    row.scrollIntoView({ block: 'nearest' });
    if (pending.focus) row.focus({ preventScroll: true });
  });

  useEffect(() => {
    if (!activePath) return;
    const c = cacheOf(space);
    let opened = false;
    for (const d of ancestorDirs(activePath)) if (!c.expanded.has(d)) { c.expanded.add(d); opened = true; }
    if (opened) rerender();
  }, [space, activePath]);

  const activeKey = activeAgent ? sessionKey(activeAgent) : null;

  // Load every open folder that has no listing yet.
  // JSON, not a join: the root's prefix is ''.
  // Access (back) for a space whose listings failed before (a link opened before the
  // owner added them, or after a removal): drop those failures so they load again.
  // Kept per space, so a visit to another space in between doesn't hide the change.
  if (reach === 'yes' && cache.lastReach !== undefined && cache.lastReach !== 'yes') {
    for (const [prefix, l] of cache.listings) if (l.error) cache.listings.delete(prefix);
    if (cache.index && typeof cache.index === 'object' && 'error' in cache.index) cache.index = null;
  }
  cache.lastReach = reach;
  // Nothing is listed until the server says the space is the user's (chat/useSpaceReach.ts).
  const missing = reach !== 'yes' ? '[]' : JSON.stringify([...cache.expanded].filter(p => !cache.listings.has(p)));
  useEffect(() => {
    const prefixes = JSON.parse(missing) as string[];
    if (!prefixes.length) return;
    const c = cacheOf(space);
    const gen = c.gen;
    for (const prefix of prefixes) {
      c.listings.set(prefix, { tree: null, error: null });
      spacesApi.tree(space, prefix)
        .then(tree => { if (c.gen === gen) c.listings.set(prefix, { tree, error: null }); })
        .catch(err => { if (c.gen === gen) c.listings.set(prefix, { tree: null, error: apiError(err, 'Could not list this folder') }); })
        .finally(rerender);
    }
  }, [space, missing]);

  const searching = query.trim() !== '';
  useEffect(() => {
    const c = cacheOf(space);
    // Like the tree, nothing is searched until the space is the user's (chat/useSpaceReach.ts).
    if (!searching || c.index || reach !== 'yes') return;
    c.index = 'loading';
    rerender();
    const gen = c.gen;
    allFiles(space)
      .then(index => { if (c.gen === gen) c.index = index; })
      .catch(err => { if (c.gen === gen) c.index = { error: apiError(err, `Could not search ${space}`) }; })
      .finally(rerender);
  }, [space, searching, tick, reach]);

  const toggleDir = (prefix: string) => {
    if (cache.expanded.has(prefix)) cache.expanded.delete(prefix);
    else cache.expanded.add(prefix);
    rerender();
  };
  const refresh = () => {
    cache.gen++;
    cache.listings.clear();
    cache.index = null;
    rerender();
  };
  // A file put, moved or removed in this space refetches the open folders (SpaceFileLive.tsx).
  useSpaceListingLive(space, cache, rerender);
  const loadMore = async (prefix: string) => {
    const l = cache.listings.get(prefix);
    if (!l?.tree?.nextCursor) return;
    cache.listings.set(prefix, { ...l, more: true });
    rerender();
    const gen = cache.gen;
    try {
      const next = await spacesApi.tree(space, prefix, l.tree.nextCursor);
      if (cache.gen !== gen) return;
      cache.listings.set(prefix, { tree: { ...next, dirs: [...l.tree.dirs, ...next.dirs], files: [...l.tree.files, ...next.files] }, error: null });
    } catch (err) {
      if (cache.gen !== gen) return;
      cache.listings.set(prefix, { tree: l.tree, error: apiError(err, 'Could not list more') });
    }
    rerender();
  };

  /**
   * `ref` in its tab or a new one, or always a new one. An agent opened here shows under its own space, which may be another,
   * or with none of its own under this one (OpenItem.openedIn).
   */
  const show = (ref: OpenItemRef, newTab: boolean, chatSpace?: string | null) => {
    // One transition for the tabs and the route, so the moved tab and its highlight paint together.
    startTransition(() => {
      const tab = newTab ? items.openNew(ref, space) : items.pick(ref, activeTab, chatSpace, space);
      navigate(itemHref(ref, tab));
    });
    onPicked?.();
  };
  const agentRef = (r: InboxRow): OpenItemRef => ({ kind: 'chat', projectId: r.projectId, workstream: r.workstream });
  const chatSpaceOf = (r: InboxRow) => chatHomeSpace(r, spaces.spaces, spaces.index);
  const openPage = (href: string) => { startTransition(() => navigate(href)); onPicked?.(); };
  const { ctx, itemRow, agentNodes, agentHit, automationHit } = useAgentTree({ shut: cache.shut, rerender, activeKey, show, agentRef, chatSpaceOf, agents, placed, openPage });

  const fileRow = (f: { path: string; size?: number; shared?: boolean }, children: React.ReactNode, cls = '') => {
    const ref: OpenItemRef = { kind: 'file', space, path: f.path };
    const tip = [f.path, f.size != null ? formatBytes(f.size) : null, f.shared ? 'shared with termag' : null].filter(Boolean).join(' · ');
    return (
      <li key={`f:${f.path}`} className="fx-item">
        {itemRow({
          href: itemHref(ref), open: newTab => show(ref, newTab), label: fileName(f.path),
          tip, cls: `fx-file${cls}`, active: f.path === activePath,
          icon: <FileIcon />,
          children: <>{children}{f.shared && <><SharedMark /><span className="chat-sr">, shared with termag</span></>}</>,
        })}
      </li>
    );
  };

  function folder(prefix: string): React.ReactNode {
    const l = cache.listings.get(prefix);
    if (!l || (!l.tree && !l.error)) return <li className="fx-note">Loading…</li>;
    return (
      <>
        {l.error && <li className="fx-note fx-error">{l.error}</li>}
        {prefix !== '' && l.tree && l.tree.dirs.length === 0 && l.tree.files.length === 0 && <li className="fx-note">Empty</li>}
        {l.tree?.dirs.map(d => {
          const open = cache.expanded.has(d.path);
          const shown = d.path === activeDir;
          return (
            <li key={`d:${d.path}`}>
              <button type="button" className={`fx-row fx-dir${shown ? ' active' : revealed === d.path ? ' revealed' : ''}`} aria-expanded={open}
                aria-current={shown ? 'true' : undefined}
                onClick={() => { setRevealed(null); toggleDir(d.path); }} data-tip={d.path} data-dir={d.path}>
                <Caret open={open} />
                <span className="fx-icon" aria-hidden="true"><FolderIcon /></span>
                <span className="fx-name">{d.name}</span>
              </button>
              {open && <ul className="fx-children">{folder(d.path)}</ul>}
            </li>
          );
        })}
        {l.tree?.files.map(f => fileRow(f, <span className="fx-name">{f.name}</span>))}
        {l.tree?.nextCursor && (
          <li className="fx-note">
            <button type="button" className="btn-tiny" disabled={l.more} onClick={() => { void loadMore(prefix); }}>{l.more ? 'Loading…' : 'More'}</button>
          </li>
        )}
      </>
    );
  }

  const index = cache.index;
  const ready = index && typeof index === 'object' && 'files' in index ? index : null;
  const fileHits = searching && ready ? searchFiles(ready.files, query) : [];
  const agentHits = searching ? searchAgents(agents, query) : [];
  const automationHits = searching ? searchAutomations(placed, query) : [];
  const rootListing = cache.listings.get('');
  const nothing = agents.length === 0 && placed.length === 0 && rootListing?.tree && rootListing.tree.dirs.length === 0 && rootListing.tree.files.length === 0;

  return (
    <aside className="fx-panel" aria-label={`Explorer for ${space}`}>
      <div className="fx-panel-head">
        <span className="fx-panel-title" data-tip={space}>{space}</span>
        <button type="button" className="fx-refresh" aria-label={`Refresh ${space}`} data-tip="Refresh" onClick={refresh}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" />
          </svg>
        </button>
      </div>
      <label className="fx-search">
        <SearchIcon />
        <input type="search" disabled={reach !== 'yes'} placeholder="Search agents and files" aria-label={`Search agents and files in ${space}`}
          value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery(''); }} />
      </label>
      <div className="fx-panel-body" ref={bodyRef}>
        {reach === 'no' ? (
          <p className="fx-note">You don't have access to {space}.</p>
        ) : reach === 'checking' ? (
          <p className="fx-note">Loading…</p>
        ) : searching ? (
          <ul className="fx-tree" aria-label="Search results">
            {automationHits.map(a => automationHit(a, query))}
            {agentHits.map(r => agentHit(r, query))}
            {index && typeof index === 'object' && 'error' in index && <li className="fx-note fx-error">{index.error}</li>}
            {index === 'loading' && <li className="fx-note">Searching files…</li>}
            {ready && fileHits.length === 0 && agentHits.length === 0 && automationHits.length === 0 && <li className="fx-note">Nothing matches.</li>}
            {fileHits.map(f => {
              const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
              return fileRow(f, (
                <span className="fx-hit-text">
                  <span className="fx-name"><Highlight text={fileName(f.path)} query={query} /></span>
                  {dir && <span className="fx-where">{dir}</span>}
                </span>
              ), ' fx-hit');
            })}
            {ready?.capped && <li className="fx-note">Searched the first {SEARCH_MAX_FILES_PER_SPACE} files of {space}.</li>}
          </ul>
        ) : (
          <ul className="fx-tree" aria-label={space}>
            {agentNodes(agents, true)}
            {folder('')}
            {nothing && <li className="fx-note">No agents or files yet.</li>}
          </ul>
        )}
      </div>
      {ctx.menu}
    </aside>
  );
}

/** A new tab (/chat/files/<space>): the space's recents, with Files beside them in the side panel. */
export function FileExplorer() {
  const space = useParams().space ?? '';
  return <WithSimpleData><NewTab space={space} /></WithSimpleData>;
}

/** A new tab's main pane: the space's recent files and agents (chat/recents.ts); a pick goes to its tab, else shows it in this one. */
function NewTab({ space }: { space: string }) {
  const { items, rows, live, setupOf, spaces, activeTab } = useSimpleData();
  const { projects } = useProjects();
  const { mode, sidePanel } = useChatChrome();
  const navigate = useNavigate();
  const recents = useMemo(() => {
    const lastActive = new Map(projects.map(p => [p.id, p.lastActiveAt ? Date.parse(p.lastActiveAt) : null]));
    const agents = rows.map(r => ({ projectId: r.projectId, workstream: r.workstream, instanceId: r.instanceId, spaceId: r.spaceId, spaceFixed: r.spaceFixed, lastActiveAt: lastActive.get(r.projectId) ?? null }));
    return spaceRecents(items.state.items, space, agents, spaces.spaces, spaces.index);
  }, [projects, rows, items.state.items, space, spaces.spaces, spaces.index]);
  const rowOf = useMemo(() => new Map(rows.map(r => [sessionKey(r), r])), [rows]);
  const reach = useSpaceReach(spaces, space);
  const show = (ref: OpenItemRef) => startTransition(() => navigate(itemHref(ref, items.pick(ref, activeTab, undefined, space))));

  return (
    <div className="chat-view">
      <section className="chat-conv">
        <header className="chat-header">
          <CloseAndBackButton />
          <ChatHistoryButton />
          <div className="chat-title"><span className="chat-title-name">New tab</span><span className="chat-title-repo">{space}</span></div>
          <div className="chat-header-actions">
            {mode === 'drawer'
              ? sidePanel && <ChatMoreButton label="New tab: actions" actions={[{ label: sidePanel.open ? 'Hide tools' : 'Show tools', onSelect: sidePanel.toggle }]} />
              : <SidePanelButton />}
          </div>
        </header>
        <div className="chat-transcript">
          <div className="chat-transcript-inner nt">
            {reach === 'checking' ? (
              <p className="nt-none">Loading…</p>
            ) : reach === 'no' ? (
              <div className="nt-no-access" role="status">
                <h2 className="nt-head">You don't have access to {space}</h2>
                <p className="nt-none">{space} hasn't been shared with you, or it no longer exists. Ask its owner to add you, then open the link again.</p>
              </div>
            ) : <>
              <h2 className="nt-head">Recent in {space}</h2>
              {recents.length === 0 ? (
                <p className="nt-none">Nothing in {space} yet.</p>
              ) : (
                <ul className="nt-list" aria-label={`Recent in ${space}`}>
                  {recents.map(r => {
                    const href = itemHref(r);
                    const open = (e: React.MouseEvent) => { if (!plainClick(e)) return; e.preventDefault(); show(r); };
                    if (r.kind === 'file') {
                      const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : space;
                      return (
                        <li key={href}>
                          <Link to={href} className="nt-row" onClick={open} data-tip={r.path}>
                            <span className="nt-icon" aria-hidden="true"><FileIcon /></span>
                            <span className="nt-text"><span className="nt-name">{fileName(r.path)}</span><span className="nt-where">{dir}</span></span>
                          </Link>
                        </li>
                      );
                    }
                    const row = rowOf.get(sessionKey(r));
                    if (!row) return null;
                    const line = sidebarLine(row, live.get(chatLiveKey(row.projectId, row.workstream)), setupOf.get(row.projectId));
                    return (
                      <li key={href}>
                        <Link to={href} className="nt-row" onClick={open} data-tip={agentLabel(row)}>
                          <span className="nt-icon" aria-hidden="true"><AgentIcon status={line.glyph} /></span>
                          <span className="nt-text"><span className="nt-name">{agentLabel(row)}</span><span className="nt-where">Agent</span><span className="chat-sr">, {line.state}</span></span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>}
          </div>
        </div>
      </section>
    </div>
  );
}
