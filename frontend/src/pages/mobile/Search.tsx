import React, { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useRecents } from '../../hooks/useRecents';
import { InboxRow, recentSessions, searchRows, STATUS_GLYPH } from '../../mobile/inbox';
import { asPaneSearchResult, focusLine, paneHitHref, paneHitKey, paneSearchError, paneSearchScope } from '../../mobile/paneSearch';
import { sessionsApi, type PaneSearchHit, type PaneSearchResult } from '../../services/api';
import type { AgentStatusValue } from '../../types';
import { pushRecentSearch, readRecentSearches, removeRecentSearch, writeRecentSearches } from '../../mobile/recentSearches';
import { useHome } from '../../mobile/useHome';
import { SessionRow, useRowActions } from './SessionRow';
import { TabBar } from './TabBar';

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

function PaneHit({ hit, needle, onOpen }: { hit: PaneSearchHit; needle: string; onOpen: () => void }) {
  const status = (hit.status in STATUS_GLYPH ? hit.status : 'not_running') as AgentStatusValue;
  return (
    <li className="m-row-wrap">
      <Link className="m-row" to={paneHitHref(hit)} data-status={status} onClick={onOpen}>
        <span className="m-glyph" data-status={status} aria-hidden>{STATUS_GLYPH[status]}</span>
        <span className="m-row-main">
          <span className="m-row-title">
            {hit.projectName}
            {hit.workstream !== 'main' && <span className="m-ws"> · {hit.workstream}</span>}
            {hit.access !== 'owner' && <span className="m-owner"> ({hit.owner})</span>}
          </span>
          {/* Pane text is untrusted output: plain text, and kept out of session replays. */}
          <span className="m-pane-lines replay-block">
            {hit.matches.map(m => (
              <span key={m.line} className="m-pane-line"><span className="m-pane-lineno">{m.line}</span><Highlight text={focusLine(m.text, needle)} needle={needle} /></span>
            ))}
          </span>
        </span>
        <span className="m-row-side">
          <span className="m-row-badges"><span className="m-badge">{hit.role}</span></span>
          <span className="m-row-clock">{hit.matchCount} {hit.matchCount === 1 ? 'match' : 'matches'}</span>
        </span>
      </Link>
    </li>
  );
}

// The Search tab. Empty: recent searches, then recent
// sessions by day. Typing: an instant filter over the session list.
// Submitting: the pane text of every live session, through the same search
// route MetaTerm's search_sessions tool uses.
export function Search() {
  const { rows, counts, now } = useHome();
  const actions = useRowActions();
  const { rows: recents } = useRecents(10);
  const [query, setQuery] = useState('');
  const [history, setHistory] = useState<string[]>(() => readRecentSearches(store()));
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

  const hits = useMemo(() => searchRows(rows, query), [rows, query]);
  const recent = useMemo(() => recentSessions(rows, recents, now), [rows, recents, now]);
  const searching = query.trim().length > 0;
  // Opening a hit is what makes a search worth keeping.
  const onOpen = (_row: InboxRow) => { if (searching) remember(query); };

  return (
    <div className="m-screen">
      <header className="m-header">
        <form
          className="m-search-form"
          role="search"
          onSubmit={e => { e.preventDefault(); remember(query); searchPanes(query); (document.activeElement as HTMLElement | null)?.blur(); }}
        >
          <input
            className="m-search-input"
            type="search"
            enterKeyHint="search"
            placeholder="Search sessions and pane text"
            aria-label="Search sessions and pane text"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </form>
      </header>
      {actions.error && <div className="m-banner" data-connection="offline" role="alert" onClick={actions.clearError}>{actions.error} · tap to dismiss</div>}
      <main className="m-scroll">
        {searching ? (
          <ul className="m-list">
            <li className="m-list-head" role="presentation">Sessions</li>
            {hits.length === 0 && <li className="m-empty m-empty-inline">No session name matches “{query.trim()}”.</li>}
            {hits.map(r => <SessionRow key={r.key} row={r} now={now} onMore={actions.open} onOpen={onOpen} />)}
            <li className="m-list-head" role="presentation">
              Pane text{pane?.q === query.trim() && pane.state === 'done' && <span className="m-list-head-note"> · {paneSearchScope(pane.result)}</span>}
            </li>
            {pane?.q !== query.trim() ? (
              query.trim().length >= 2 && (
                <li className="m-pane-cta">
                  <button className="m-link" onClick={() => { remember(query); searchPanes(query); }}>Search pane text for “{query.trim()}”</button>
                </li>
              )
            ) : pane.state === 'loading' ? (
              <li className="m-empty m-empty-inline">Searching every live pane…</li>
            ) : pane.state === 'error' ? (
              <li className="m-empty m-empty-inline" role="alert">{pane.error}</li>
            ) : pane.result.hits.length === 0 ? (
              <li className="m-empty m-empty-inline">No pane mentions “{pane.q}”.</li>
            ) : (
              pane.result.hits.map(h => <PaneHit key={paneHitKey(h)} hit={h} needle={pane.q} onOpen={() => remember(pane.q)} />)
            )}
          </ul>
        ) : (
          <ul className="m-list">
            {history.length > 0 && <li className="m-list-head" role="presentation">Recent searches</li>}
            {history.map(q => (
              <li key={`q:${q}`} className="m-row-wrap">
                <button className="m-row m-search-recent" onClick={() => { setQuery(q); remember(q); searchPanes(q); }}>
                  <span className="m-glyph" aria-hidden>⌕</span>
                  <span className="m-row-main"><span className="m-row-title">{q}</span></span>
                </button>
                <button className="m-more" aria-label={`Forget the search ${q}`} onClick={() => forget(q)}>×</button>
              </li>
            ))}
            {recent.map((r, i) => {
              const head = r.bucket && r.bucket !== recent[i - 1]?.bucket
                ? <li key={`head:${r.bucket}`} className="m-list-head" role="presentation">{i === 0 ? `Recent sessions · ${r.bucket}` : r.bucket}</li>
                : null;
              return (
                <React.Fragment key={`r:${r.key}`}>
                  {head}
                  <SessionRow row={r} now={now} recent onMore={actions.open} />
                </React.Fragment>
              );
            })}
            {history.length === 0 && recent.length === 0 && <li className="m-empty">Nothing opened recently.</li>}
          </ul>
        )}
      </main>
      <TabBar attention={counts.attention} />
      {actions.sheets}
    </div>
  );
}
