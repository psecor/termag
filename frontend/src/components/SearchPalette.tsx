import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConnection } from '../contexts/ConnectionContext';
import { useRecents } from '../hooks/useRecents';
import { recentSessions, searchRows } from '../mobile/inbox';
import { asPaneSearchResult, focusLine, paneHitKey, paneSearchError, paneSearchScope } from '../mobile/paneSearch';
import { pushRecentSearch, readRecentSearches, removeRecentSearch, writeRecentSearches } from '../mobile/recentSearches';
import { useHome } from '../mobile/useHome';
import { sessionsApi, type PaneSearchResult } from '../services/api';
import { StatusDot } from './StatusDot';
import { clampIndex, hitStatus, paletteItems, type PaletteItem as Item } from '../utils/searchPalette';
import { hitTarget, isSearchShortcut, rowTarget, searchShortcutLabel } from '../utils/workspaceTarget';
import { Dialog } from './Dialog';
import { SessionItem, useOpenTarget } from './SessionList';

const store = () => (typeof localStorage !== 'undefined' ? localStorage : null);

type PaneState =
  | { q: string; state: 'loading' }
  | { q: string; state: 'done'; result: PaneSearchResult }
  | { q: string; state: 'error'; error: string };

/** The query's occurrences in one line of pane text, marked; text only, never markup. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  const n = needle.toLowerCase();
  const out: React.ReactNode[] = [];
  const lower = text.toLowerCase();
  let i = 0;
  for (let at = lower.indexOf(n); n && at >= 0; at = lower.indexOf(n, i)) {
    if (at > i) out.push(text.slice(i, at));
    out.push(<mark key={at}>{text.slice(at, at + n.length)}</mark>);
    i = at + n.length;
  }
  out.push(text.slice(i));
  return <>{out}</>;
}

/**
 * ⌘K search: the phone's Search tab as a palette.
 * Empty: recent searches, then recent sessions. Typing: an instant filter
 * over every session. The last item searches the pane text of every live
 * session, through the route MetaTerm's search_sessions uses.
 */
const SHORTCUT = searchShortcutLabel(
  typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform,
);

export function SearchPalette() {
  const [open, setOpen] = useState(false);
  // Offline, the takeover blocks the workspace (ConnectionOverlay); the
  // palette would sit above it and land you in a terminal under it.
  const offline = useConnection().state === 'offline';
  useEffect(() => { if (offline) setOpen(false); }, [offline]);

  // Capture phase, so the shortcut works with a terminal focused (xterm's
  // own keydown listener sits on its textarea, below the window).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.type !== 'keydown' || !isSearchShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (!offline) setOpen(o => !o);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [offline]);

  return (
    <>
      <button type="button" className="search-trigger" onClick={() => setOpen(true)} disabled={offline} title={`Search sessions and pane text (${SHORTCUT})`}>
        <span>⌕ Search…</span><kbd>{SHORTCUT}</kbd>
      </button>
      {open && createPortal(<Palette onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function Palette({ onClose }: { onClose: () => void }) {
  const { rows, now } = useHome();
  const openTarget = useOpenTarget();
  const { rows: recents } = useRecents(10);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [history, setHistory] = useState<string[]>(() => readRecentSearches(store()));
  const listRef = useRef<HTMLDivElement>(null);
  const remember = (q: string) => {
    const next = pushRecentSearch(history, q);
    setHistory(next);
    writeRecentSearches(store(), next);
  };
  const forget = (q: string) => {
    const next = removeRecentSearch(history, q);
    setHistory(next);
    writeRecentSearches(store(), next);
  };

  const [pane, setPane] = useState<PaneState | null>(null);
  const seq = useRef(0);
  const searchPanes = (raw: string) => {
    const q = raw.trim();
    if (q.length < 2) return;
    const my = ++seq.current;
    setPane({ q, state: 'loading' });
    sessionsApi.search(q).then(asPaneSearchResult).then(
      result => { if (my === seq.current) setPane({ q, state: 'done', result }); },
      err => { if (my === seq.current) setPane({ q, state: 'error', error: paneSearchError(err) }); },
    );
  };

  const q = query.trim();
  const searching = q.length > 0;
  const hits = useMemo(() => searchRows(rows, query), [rows, query]);
  const recent = useMemo(() => recentSessions(rows, recents, now), [rows, recents, now]);
  const paneDone = pane?.q === q && pane.state === 'done' ? pane.result : null;

  const items = useMemo(
    () => paletteItems({ q, history, recent, hits, paneQuery: pane?.q ?? null, paneResult: paneDone }),
    [q, history, recent, hits, pane?.q, paneDone],
  );

  useEffect(() => { setActive(0); }, [query]);
  // The list can shrink under the highlight (a forgotten search, the
  // pane-text item giving way to fewer hits).
  useEffect(() => { setActive(i => clampIndex(i, items.length)); }, [items.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (item: Item) => {
    if (item.kind === 'recent-query') { setQuery(item.q); remember(item.q); searchPanes(item.q); return; }
    if (item.kind === 'cta') { remember(item.q); searchPanes(item.q); return; }
    // Opening a result is what makes a search worth keeping.
    if (searching) remember(query);
    onClose();
    openTarget(item.kind === 'row' ? rowTarget(item.row) : hitTarget(item.hit));
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(items.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (items[active]) choose(items[active]);
      else if (searching) { remember(query); searchPanes(query); }
    }
  };

  const index = (it: Item) => items.indexOf(it);
  const head = (label: React.ReactNode) => <li className="palette-head" role="presentation">{label}</li>;
  const rowItem = (it: Extract<Item, { kind: 'row' }>) => (
    <SessionItem key={`r:${it.row.key}`} row={it.row} now={now} index={index(it)} active={index(it) === active} onSelect={() => choose(it)} />
  );

  return (
    <Dialog ariaLabel="Search" className="palette" backdropClassName="confirm-backdrop--top" onKeyDown={onKey} onClose={onClose}>
      <input
        className="palette-input"
        type="search"
        autoFocus
        placeholder="Search sessions and pane text"
        aria-label="Search sessions and pane text"
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      <div className="palette-scroll" ref={listRef}>
        <ul className="recents-list" role="listbox">
          {searching ? (
            <>
              {head('Sessions')}
              {hits.length === 0 && <li className="recents-empty">No session name matches “{q}”.</li>}
              {items.filter((it): it is Extract<Item, { kind: 'row' }> => it.kind === 'row').map(rowItem)}
              {head(<>Pane text{paneDone && <span className="palette-head-note"> · {paneSearchScope(paneDone)}</span>}</>)}
              {items.filter(it => it.kind === 'cta').map(it => (
                <li key="cta" role="option" aria-selected={index(it) === active}>
                  <button type="button" className={`recents-item palette-cta${index(it) === active ? ' is-active' : ''}`} data-index={index(it)} onClick={() => choose(it)}>
                    ⌕ Search pane text for “{q}”
                  </button>
                </li>
              ))}
              {pane?.q === q && pane.state === 'loading' && <li className="recents-empty">Searching every live pane…</li>}
              {pane?.q === q && pane.state === 'error' && <li className="recents-empty" role="alert">{pane.error}</li>}
              {paneDone && paneDone.hits.length === 0 && <li className="recents-empty">No pane mentions “{q}”.</li>}
              {items.filter((it): it is Extract<Item, { kind: 'hit' }> => it.kind === 'hit').map(it => {
                const status = hitStatus(it.hit.status);
                const i = index(it);
                return (
                  <li key={`h:${paneHitKey(it.hit)}`} role="option" aria-selected={i === active}>
                    <button type="button" className={`recents-item${i === active ? ' is-active' : ''}`} data-index={i} onClick={() => choose(it)}>
                      <span className="recents-status"><StatusDot status={status} /></span>
                      <span className="recents-body">
                        <span className="recents-title">
                          <span className="recents-name">{it.hit.projectName}</span>
                          {it.hit.workstream !== 'main' && <span className="workstream-bar-badge">{it.hit.workstream}</span>}
                          {it.hit.access !== 'owner' && <span className="recents-tag" title={`Owned by ${it.hit.owner}`}>shared</span>}
                          <span className="recents-tag">{it.hit.role}</span>
                        </span>
                        {/* Pane text is untrusted output: plain text, and kept out of session replays. */}
                        <span className="palette-lines replay-block">
                          {it.hit.matches.map(m => (
                            <span key={m.line} className="palette-line"><span className="palette-lineno">{m.line}</span><Highlight text={focusLine(m.text, it.q, 40)} needle={it.q} /></span>
                          ))}
                        </span>
                      </span>
                      <span className="recents-when">{it.hit.matchCount} {it.hit.matchCount === 1 ? 'match' : 'matches'}</span>
                    </button>
                  </li>
                );
              })}
            </>
          ) : (
            <>
              {history.length > 0 && head('Recent searches')}
              {items.filter((it): it is Extract<Item, { kind: 'recent-query' }> => it.kind === 'recent-query').map(it => {
                const i = index(it);
                return (
                  <li key={`q:${it.q}`} role="option" aria-selected={i === active} className="palette-recent-query">
                    <button type="button" className={`recents-item${i === active ? ' is-active' : ''}`} data-index={i} onClick={() => choose(it)}>
                      <span className="recents-status" aria-hidden>⌕</span>
                      <span className="recents-body"><span className="recents-name">{it.q}</span></span>
                    </button>
                    <button type="button" className="btn-ghost btn-tiny palette-forget" aria-label={`Forget the search ${it.q}`} onClick={() => forget(it.q)}>×</button>
                  </li>
                );
              })}
              {recent.length > 0 && head('Recent sessions')}
              {items.filter((it): it is Extract<Item, { kind: 'row' }> => it.kind === 'row').map(rowItem)}
              {history.length === 0 && recent.length === 0 && <li className="recents-empty">Nothing opened recently.</li>}
            </>
          )}
        </ul>
      </div>
      <div className="palette-foot">↑↓ move · Enter open · Esc close · {SHORTCUT}</div>
    </Dialog>
  );
}
