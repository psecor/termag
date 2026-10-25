// A space's explorer in the simple UI (simple-ui-side-panel-enabled): one
// tree with the space's agents beside its files. An agent another agent
// started is under it, the way a file is under its folder; folders load as
// they open. The search matches agent names and file names at every depth.
// Only agents whose box reaches the space are listed; the explorer never
// gives a box access to a space.
//
// It is the side panel's Files tab (SidePanel.tsx), with the file or agent
// shown highlighted and its folders or starting agents open, and a new tab
// (/chat/files/<space>, a space's + → New tab) lists the space's recent files
// and agents in the main pane, with Files beside it. Picking an agent or a
// file shows it in the current tab; "Open in new tab" (its ⋮, a right click,
// the context menu key or Shift+F10) opens another. Listings, open folders
// and the search index are kept per space for the page's life, so moving
// between files doesn't reload the tree.
import React, { useEffect, useMemo, useReducer, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useProjects } from '../../contexts/ProjectContext';
import { spacesApi, type SpaceTree } from '../../services/api';
import { formatBytes } from '../../utils/spaces';
import { itemHref, newTabId, type OpenItemRef } from '../../chat/openItems';
import { ancestorDirs, fileName, matchParts, SEARCH_MAX_FILES_PER_SPACE, searchFiles, type SearchFile } from '../../chat/fileExplorer';
import { agentLabel, explorerAgents, searchAgents, type AgentNode } from '../../chat/explorerAgents';
import { chatLiveKey } from '../../chat/chatLiveStatus';
import { sidebarLine } from '../../chat/simpleChat';
import type { InboxRow } from '../../mobile/inbox';
import { spaceRecents } from '../../chat/recents';
import { ChatHistoryButton, ChatMoreButton, SidePanelButton, useChatChrome } from './chatChrome';
import { AgentIcon, FileIcon, FolderIcon, openInBrowserTab, plainClick } from './OpenItems';
import { isMenuKey, MenuButton, useContextMenu, type MenuAction, type MenuTrigger } from './ContextMenu';
import { useSimpleData, WithSimpleData } from './simpleData';

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
}

type Listing = { tree: SpaceTree | null; error: string | null; more?: boolean };
interface SpaceCache {
  listings: Map<string, Listing>;
  /** Open folders, by prefix ('' is the root). */
  expanded: Set<string>;
  /** Agents showing the agents they started, by session key. */
  open: Set<string>;
  index: { files: SearchFile[]; capped: boolean } | { error: string } | 'loading' | null;
  /** Bumped by Refresh; a reply from an older generation is dropped. */
  gen: number;
}

const caches = new Map<string, SpaceCache>();
function cacheOf(space: string): SpaceCache {
  let c = caches.get(space);
  if (!c) { c = { listings: new Map(), expanded: new Set(['']), open: new Set(), index: null, gen: 0 }; caches.set(space, c); }
  return c;
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

function Caret({ open }: { open: boolean }) {
  return (
    <svg className={`fx-caret${open ? ' open' : ''}`} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" d="M6 4l4 4-4 4" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="fx-search-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" d="M10.5 10.5L14 14" />
    </svg>
  );
}

const sessionKey = (r: { projectId: string; workstream: string }) => `${r.projectId}|${r.workstream}`;

function Highlight({ text, query }: { text: string; query: string }) {
  return <>{matchParts(text, query).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <React.Fragment key={i}>{p.text}</React.Fragment>))}</>;
}

type AgentKey = { projectId: string; workstream: string };

type PanelProps = {
  space: string; activePath?: string; activeAgent?: AgentKey;
  /** Something was picked. */
  onPicked?: () => void;
};

/** The explorer for `space`, with `activePath` or `activeAgent` (if any) highlighted and revealed. */
export function ExplorerPanel(props: PanelProps) {
  return <WithSimpleData><Panel {...props} /></WithSimpleData>;
}

function Panel({ space, activePath, activeAgent, onPicked }: PanelProps) {
  const { items, rows, live, setupOf, spaces, links, activeTab } = useSimpleData();
  const navigate = useNavigate();
  const ctx = useContextMenu();
  const [tick, rerender] = useReducer((n: number) => n + 1, 0);
  const [query, setQuery] = useState('');
  const cache = cacheOf(space);
  const agents = useMemo(() => explorerAgents(rows, space, spaces.index, links), [rows, space, spaces.index, links]);

  useEffect(() => { setQuery(''); }, [space]);

  useEffect(() => {
    if (!activePath) return;
    const c = cacheOf(space);
    let opened = false;
    for (const d of ancestorDirs(activePath)) if (!c.expanded.has(d)) { c.expanded.add(d); opened = true; }
    if (opened) rerender();
  }, [space, activePath]);

  const activeKey = activeAgent ? sessionKey(activeAgent) : null;
  useEffect(() => {
    if (!activeKey) return;
    const parentOf = new Map(links.map(l => [sessionKey(l), `${l.parentProjectId}|${l.parentWorkstream}`]));
    const c = cacheOf(space);
    let opened = false;
    const seen = new Set([activeKey]);
    for (let p = parentOf.get(activeKey); p && !seen.has(p); p = parentOf.get(p)) {
      seen.add(p);
      if (!c.open.has(p)) { c.open.add(p); opened = true; }
    }
    if (opened) rerender();
  }, [space, activeKey, links]);

  // Load every open folder that has no listing yet.
  // JSON, not a join: the root's prefix is ''.
  const missing = JSON.stringify([...cache.expanded].filter(p => !cache.listings.has(p)));
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
    if (!searching || c.index) return;
    c.index = 'loading';
    rerender();
    const gen = c.gen;
    allFiles(space)
      .then(index => { if (c.gen === gen) c.index = index; })
      .catch(err => { if (c.gen === gen) c.index = { error: apiError(err, `Could not search ${space}`) }; })
      .finally(rerender);
  }, [space, searching, tick]);

  const toggleDir = (prefix: string) => {
    if (cache.expanded.has(prefix)) cache.expanded.delete(prefix);
    else cache.expanded.add(prefix);
    rerender();
  };
  const toggleOpen = (key: string) => {
    if (cache.open.has(key)) cache.open.delete(key);
    else cache.open.add(key);
    rerender();
  };
  const refresh = () => {
    cache.gen++;
    cache.listings.clear();
    cache.index = null;
    rerender();
  };
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

  /** `ref` in this tab, or in a new one. An agent opened here shows under this space. */
  const show = (ref: OpenItemRef, newTab: boolean) => {
    const tab = newTab ? newTabId() : activeTab;
    items.open(ref, tab);
    navigate(itemHref(ref, tab));
    onPicked?.();
  };
  const agentRef = (r: InboxRow): OpenItemRef => ({ kind: 'chat', projectId: r.projectId, workstream: r.workstream, space });

  const menuFor = (label: string, open: (newTab: boolean) => void, href: string) => (e: MenuTrigger) => {
    const actions: MenuAction[] = [
      { label: 'Open', onSelect: () => open(false) },
      { label: 'Open in new tab', onSelect: () => open(true) },
      { label: 'Open in new browser tab', onSelect: () => openInBrowserTab(href) },
    ];
    ctx.open(e, label, actions, href);
  };

  /** A row that opens something, and its ⋮: an app link whose href has no tab, so a modifier click is the browser's. */
  const itemRow = (o: {
    href: string; open: (newTab: boolean) => void; label: string; tip: string; cls: string; active?: boolean;
    icon: React.ReactNode; children: React.ReactNode;
  }) => {
    const menu = menuFor(o.label, o.open, o.href);
    return (
      <>
        <Link to={o.href} className={`fx-row ${o.cls}${o.active ? ' active' : ''}`} aria-current={o.active ? 'page' : undefined} data-tip={o.tip}
          onClick={e => { if (!plainClick(e)) return; e.preventDefault(); o.open(false); }}
          onContextMenu={menu} onKeyDown={e => { if (isMenuKey(e)) menu(e); }}>
          <span className="fx-icon" aria-hidden="true">{o.icon}</span>
          {o.children}
        </Link>
        <MenuButton label={o.label} open={menu} expanded={ctx.openKey === o.href} className="fx-menu" />
      </>
    );
  };

  const fileRow = (f: { path: string; size?: number }, children: React.ReactNode, cls = '') => {
    const ref: OpenItemRef = { kind: 'file', space, path: f.path };
    return (
      <li key={`f:${f.path}`} className="fx-item">
        {itemRow({
          href: itemHref(ref), open: newTab => show(ref, newTab), label: fileName(f.path),
          tip: f.size != null ? `${f.path} · ${formatBytes(f.size)}` : f.path, cls: `fx-file${cls}`, active: f.path === activePath,
          icon: <FileIcon />, children,
        })}
      </li>
    );
  };

  const agentStatus = (r: InboxRow) => sidebarLine(r, live.get(chatLiveKey(r.projectId, r.workstream)), setupOf.get(r.projectId));

  const agentRow = (r: InboxRow, children: React.ReactNode, cls = '') => {
    const ref = agentRef(r);
    const line = agentStatus(r);
    return itemRow({
      href: itemHref(ref), open: newTab => show(ref, newTab), label: agentLabel(r),
      tip: [agentLabel(r), line.state].filter(Boolean).join('\n'), cls: `fx-file fx-agent${cls}`, active: sessionKey(r) === activeKey,
      icon: <AgentIcon status={line.glyph} />,
      children: <>{children}<span className="chat-sr">, agent, {line.state}</span></>,
    });
  };

  function agentNode(n: AgentNode<InboxRow>): React.ReactNode {
    const k = sessionKey(n.row);
    const open = cache.open.has(k);
    return (
      <li key={`a:${k}`} className="fx-item fx-agent-li">
        {n.children.length > 0 && (
          <button type="button" className="fx-twisty" aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the agents ${agentLabel(n.row)} started`} data-tip={`${n.children.length} started by this agent`}
            onClick={() => toggleOpen(k)}><Caret open={open} /></button>
        )}
        {agentRow(n.row, <span className="fx-name">{agentLabel(n.row)}</span>)}
        {open && <ul className="fx-children">{n.children.map(agentNode)}</ul>}
      </li>
    );
  }

  function folder(prefix: string): React.ReactNode {
    const l = cache.listings.get(prefix);
    if (!l || (!l.tree && !l.error)) return <li className="fx-note">Loading…</li>;
    return (
      <>
        {l.error && <li className="fx-note fx-error">{l.error}</li>}
        {prefix !== '' && l.tree && l.tree.dirs.length === 0 && l.tree.files.length === 0 && <li className="fx-note">Empty</li>}
        {l.tree?.dirs.map(d => {
          const open = cache.expanded.has(d.path);
          return (
            <li key={`d:${d.path}`}>
              <button type="button" className="fx-row fx-dir" aria-expanded={open} onClick={() => toggleDir(d.path)} data-tip={d.path}>
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
  const parentOf = useMemo(() => {
    const m = new Map<string, string>();
    const walk = (list: ReadonlyArray<AgentNode<InboxRow>>, parent: string | null) => {
      for (const n of list) { if (parent) m.set(sessionKey(n.row), parent); walk(n.children, agentLabel(n.row)); }
    };
    walk(agents, null);
    return m;
  }, [agents]);
  const rootListing = cache.listings.get('');
  const nothing = agents.length === 0 && rootListing?.tree && rootListing.tree.dirs.length === 0 && rootListing.tree.files.length === 0;

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
        <input type="search" placeholder="Search agents and files" aria-label={`Search agents and files in ${space}`}
          value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setQuery(''); }} />
      </label>
      <div className="fx-panel-body">
        {searching ? (
          <ul className="fx-tree" aria-label="Search results">
            {agentHits.map(r => (
              <li key={`a:${r.key}`} className="fx-item">{agentRow(r, (
                <span className="fx-hit-text">
                  <span className="fx-name"><Highlight text={agentLabel(r)} query={query} /></span>
                  {parentOf.has(sessionKey(r)) && <span className="fx-where">under {parentOf.get(sessionKey(r))}</span>}
                </span>
              ), ' fx-hit')}</li>
            ))}
            {index && typeof index === 'object' && 'error' in index && <li className="fx-note fx-error">{index.error}</li>}
            {index === 'loading' && <li className="fx-note">Searching files…</li>}
            {ready && fileHits.length === 0 && agentHits.length === 0 && <li className="fx-note">Nothing matches.</li>}
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
            {agents.map(agentNode)}
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

/** A new tab's main pane: the space's recent files and agents (chat/recents.ts); a pick shows it in this tab. */
function NewTab({ space }: { space: string }) {
  const { items, rows, live, setupOf, spaces, activeTab } = useSimpleData();
  const { projects } = useProjects();
  const { mode, sidePanel } = useChatChrome();
  const navigate = useNavigate();
  const recents = useMemo(() => {
    const lastActive = new Map(projects.map(p => [p.id, p.lastActiveAt ? Date.parse(p.lastActiveAt) : null]));
    const agents = rows.map(r => ({ projectId: r.projectId, workstream: r.workstream, instanceId: r.instanceId, lastActiveAt: lastActive.get(r.projectId) ?? null }));
    return spaceRecents(items.state.items, space, agents, new Set(spaces.spaces.map(s => s.name)), spaces.index);
  }, [projects, rows, items.state.items, space, spaces.spaces, spaces.index]);
  const rowOf = useMemo(() => new Map(rows.map(r => [sessionKey(r), r])), [rows]);
  const show = (ref: OpenItemRef) => {
    items.open(ref, activeTab);
    navigate(itemHref(ref, activeTab));
  };

  return (
    <div className="chat-view">
      <section className="chat-conv">
        <header className="chat-header">
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
          </div>
        </div>
      </section>
    </div>
  );
}
