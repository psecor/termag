import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useConnection } from '../contexts/ConnectionContext';
import { useRecents } from '../hooks/useRecents';
import { recentSessions, searchRows, type InboxRow } from '../mobile/inbox';
import { asPaneSearchResult, focusLine, paneHitKey, paneSearchError, paneSearchScope } from '../mobile/paneSearch';
import { pushRecentSearch, readRecentSearches, removeRecentSearch, writeRecentSearches } from '../mobile/recentSearches';
import { useHome } from '../mobile/useHome';
import { prsApi, sessionsApi, type PaneSearchResult, type PrPipelineResponse, type PrRow } from '../services/api';
import { StatusDot } from './StatusDot';
import { OPEN_PALETTE_EVENT, clampIndex, hitStatus, matchActions, paletteItems, paletteSelectEvent, type OpenPaletteDetail, type PaletteAction, type PaletteItem as Item } from '../utils/searchPalette';
import { trackEvent } from '../observability';
import { currentSearchShortcut, hitTarget, isSearchShortcut, rowTarget, type WorkspaceTarget } from '../utils/workspaceTarget';
import { Dialog } from './Dialog';
import { LANE_SHORT, PRS_PARAM, PRS_REPO_PARAM, prsSearch, rowLabel, rowParam, searchPrRows } from '../utils/prPipeline';
import { fmtAge } from '../utils/format';
import { SessionItem, useOpenTarget } from './SessionList';

/** Pull requests the palette lists at most; the PR overlay's find goes further. */
const PR_LIMIT = 5;

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
 * Empty: recent searches, then recent sessions. Typing: the actions it
 * matches (Branch off…), then an instant filter over every session, then
 * the pull requests it finds in every lane (the PR overlay's find, read once
 * as the palette opens). The last item searches the pane text of every live
 * session, through the route MetaTerm's search_sessions uses.
 */
const SHORTCUT = currentSearchShortcut();

/** The workspace's ⌘K: its sessions from ProjectContext, opening in the workspace. */
export function SearchPalette({ actions = [] }: { actions?: PaletteAction[] }) {
  // Offline, the takeover blocks the workspace (ConnectionOverlay); the
  // palette would sit above it and land you in a terminal under it.
  const offline = useConnection().state === 'offline';
  const { rows, now } = useHome();
  const openTarget = useOpenTarget();
  return <PaletteLauncher actions={actions} offline={offline} rows={rows} now={now} openTarget={openTarget} />;
}

interface Source {
  /** Every session, as the home list builds them. */
  rows: readonly InboxRow[];
  now: number;
  /** Opens a session or pane hit. */
  openTarget: (t: WorkspaceTarget) => void;
  /** Opens a pull request; without it, the PR overlay opens over this page. */
  openPr?: (row: PrRow) => void;
  /** A session's box name: found by the search and shown as a pill on its result. */
  boxNameOf?: (row: InboxRow) => string | null;
}

/**
 * ⌘K, trigger and shortcut, with its sessions and their opening passed in:
 * SearchPalette in the workspace, DashboardSearch on the dashboard (no
 * ProjectContext there).
 */
export function PaletteLauncher({ actions = [], offline = false, ...source }: Source & { actions?: PaletteAction[]; offline?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { if (offline) setOpen(false); }, [offline]);
  // Counted as it opens, with what opened it (custom event).
  const openedVia = useRef<'shortcut' | 'button' | OpenPaletteDetail['via']>('button');
  useEffect(() => { if (open) trackEvent('palette-opened', { via: openedVia.current }); }, [open]);
  // Closing gives the focus back to what had it (the PR overlay, a terminal),
  // so its keys work again without a click. Noted as the open is asked for:
  // by the time an effect runs, the palette's input has taken the focus. A
  // session it then opens takes the focus after this (FOCUS_PANE_EVENT runs
  // on the next tick).
  const returnFocus = useRef<HTMLElement | null>(null);
  const noteFocus = () => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && !el.closest('.palette')) returnFocus.current = el;
  };
  useEffect(() => {
    if (open) return;
    const el = returnFocus.current;
    returnFocus.current = null;
    if (el?.isConnected) el.focus();
  }, [open]);

  // Capture phase, so the shortcut works with a terminal focused (xterm's
  // own keydown listener sits on its textarea, below the window).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.type !== 'keydown' || !isSearchShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (offline) return;
      openedVia.current = 'shortcut';
      noteFocus();
      setOpen(o => !o);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [offline]);

  // Another part of the page asks for the palette (the PR overlay's Search… and `/`).
  useEffect(() => {
    const onOpen = (e: Event) => {
      if (offline) return;
      const detail = (e as CustomEvent<OpenPaletteDetail>).detail;
      openedVia.current = detail?.via ?? 'button';
      noteFocus();
      setOpen(true);
    };
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
  }, [offline]);

  return (
    <>
      <button type="button" className="search-trigger" onClick={() => { openedVia.current = 'button'; noteFocus(); setOpen(true); }} disabled={offline} title={`Search sessions, pull requests and pane text (${SHORTCUT})`}>
        <span>⌕ Search…</span><kbd>{SHORTCUT}</kbd>
      </button>
      {open && createPortal(<Palette actions={actions} {...source} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function Palette({ actions, rows, now, openTarget, openPr, boxNameOf, onClose }: Source & { actions: PaletteAction[]; onClose: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  // The PR list, once per opening (the route answers from its cache); without GitHub, no section.
  const [prs, setPrs] = useState<PrPipelineResponse | null>(null);
  useEffect(() => {
    let live = true;
    prsApi.list().then(res => { if (live) setPrs(res); }, () => {});
    return () => { live = false; };
  }, []);
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
  const matched = useMemo(() => matchActions(actions, query), [actions, query]);
  const hits = useMemo(() => searchRows(rows, query, boxNameOf), [rows, query, boxNameOf]);
  const prHits = useMemo(() => searchPrRows(prs, query, PR_LIMIT), [prs, query]);
  const recent = useMemo(() => recentSessions(rows, recents, now), [rows, recents, now]);
  const paneDone = pane?.q === q && pane.state === 'done' ? pane.result : null;

  const items = useMemo(
    () => paletteItems({ q, actions: matched, history, recent, hits, prs: prHits, paneQuery: pane?.q ?? null, paneResult: paneDone }),
    [q, matched, history, recent, hits, prHits, pane?.q, paneDone],
  );

  useEffect(() => { setActive(0); }, [query]);
  // The list can shrink under the highlight (a forgotten search, the
  // pane-text item giving way to fewer hits).
  useEffect(() => { setActive(i => clampIndex(i, items.length)); }, [items.length]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (item: Item) => {
    const event = paletteSelectEvent(item, q);
    trackEvent(event.key, event.data);
    if (item.kind === 'recent-query') { setQuery(item.q); remember(item.q); searchPanes(item.q); return; }
    if (item.kind === 'cta') { remember(item.q); searchPanes(item.q); return; }
    // An action is a command, not a search worth keeping.
    if (item.kind === 'action') { onClose(); item.action.run(); return; }
    // Opening a result is what makes a search worth keeping.
    if (searching) remember(query);
    onClose();
    // A pull request opens the PR overlay on its lane, with the row selected,
    // over this page. A repo filter from a link that would hide it is dropped,
    // so the row shows in the list as well as in the detail.
    if (item.kind === 'pr' && openPr) { openPr(item.row); return; }
    if (item.kind === 'pr') {
      const next = new URLSearchParams(prsSearch(location.search, item.row.lane, rowParam(item.row)));
      const only = next.get(PRS_REPO_PARAM);
      if (only && only !== item.row.repo) next.delete(PRS_REPO_PARAM);
      navigate({ search: `?${next.toString()}` });
      return;
    }
    // A session or pane hit: the PR overlay, if open, closes, or it would sit
    // over the workstream just opened beneath it.
    if (new URLSearchParams(location.search).has(PRS_PARAM)) navigate({ search: prsSearch(location.search, null) }, { replace: true });
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
    <SessionItem key={`r:${it.row.key}`} row={it.row} now={now} index={index(it)} active={index(it) === active} onSelect={() => choose(it)} box={boxNameOf?.(it.row)} />
  );

  return (
    <Dialog ariaLabel="Search" className="palette" backdropClassName="confirm-backdrop--top" onKeyDown={onKey} onClose={onClose}>
      <input
        className="palette-input"
        type="search"
        autoFocus
        placeholder="Search sessions, pull requests and pane text"
        aria-label="Search sessions, pull requests and pane text"
        value={query}
        onChange={e => setQuery(e.target.value)}
      />
      <div className="palette-scroll" ref={listRef}>
        <ul className="recents-list" role="listbox">
          {searching ? (
            <>
              {matched.length > 0 && head('Actions')}
              {items.filter((it): it is Extract<Item, { kind: 'action' }> => it.kind === 'action').map(it => {
                const i = index(it);
                return (
                  <li key={`a:${it.action.id}`} role="option" aria-selected={i === active}>
                    <button type="button" className={`recents-item palette-action${i === active ? ' is-active' : ''}`} data-index={i} onClick={() => choose(it)}>
                      <span className="recents-status" aria-hidden>›</span>
                      <span className="recents-body">
                        <span className="recents-title">
                          <span className="recents-name">{it.action.label}</span>
                          {it.action.detail && <span className="recents-tag">{it.action.detail}</span>}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {head('Sessions')}
              {hits.length === 0 && <li className="recents-empty">No session name matches “{q}”.</li>}
              {items.filter((it): it is Extract<Item, { kind: 'row' }> => it.kind === 'row').map(rowItem)}
              {prs?.connected && head('Pull requests')}
              {prs?.connected && prHits.length === 0 && <li className="recents-empty">No pull request matches “{q}”.</li>}
              {items.filter((it): it is Extract<Item, { kind: 'pr' }> => it.kind === 'pr').map(it => {
                const i = index(it);
                const at = it.row.requestedAt ?? it.row.mergedAt ?? it.row.at;
                return (
                  <li key={`p:${rowParam(it.row)}`} role="option" aria-selected={i === active}>
                    <button type="button" className={`recents-item palette-pr${i === active ? ' is-active' : ''}`} data-index={i} onClick={() => choose(it)}>
                      <span className="recents-status" aria-hidden>⇄</span>
                      <span className="recents-body">
                        <span className="recents-title">
                          <span className="recents-name">{rowLabel(it.row)}</span>
                          <span className="recents-tag">{LANE_SHORT[it.row.lane]}</span>
                        </span>
                        <span className="recents-detail">{it.row.kind === 'pr' ? it.row.title : `${it.row.headRefName} · no pull request yet`}</span>
                      </span>
                      {at && <span className="recents-when">{fmtAge(Math.max(0, now - Date.parse(at)))}</span>}
                    </button>
                  </li>
                );
              })}
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
