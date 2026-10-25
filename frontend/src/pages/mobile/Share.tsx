// What another app shared into termag: pick the session it is for. A GitHub PR link
// can start a Devin review there; anything else prefills the composer. Nothing
// is ever sent from here: the conversation shows the draft and waits.
import React, { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { parseShared, sharedConversationHref } from '../../mobile/share';
import { useHome } from '../../mobile/useHome';
import { SessionRow } from './SessionRow';

export function Share() {
  const [params] = useSearchParams();
  const shared = useMemo(
    () => parseShared({ title: params.get('title'), text: params.get('text'), url: params.get('url') }),
    [params],
  );
  const [mode, setMode] = useState<'review' | 'draft'>(shared.pr ? 'review' : 'draft');
  const { rows, now } = useHome();
  // Cloud sessions open on claude.ai; a share cannot reach their pane.
  const targets = rows.filter(r => r.kind !== 'cloud');
  const nothing = !shared.draft && !shared.pr;

  return (
    <div className="m-screen">
      <header className="m-header m-header-conv">
        <Link className="m-link m-back" to="/m" aria-label="Cancel">‹</Link>
        <span className="m-title m-conv-title">Share to a session</span>
      </header>
      <div className="m-share-card replay-block">
        {nothing ? <span className="m-form-note">Nothing was shared.</span> : <span className="m-share-text">{shared.draft || shared.pr?.url}</span>}
      </div>
      {shared.pr && (
        <div className="m-segments" role="radiogroup" aria-label="What to do with it">
          <button role="radio" aria-checked={mode === 'review'} className={`m-segment ${mode === 'review' ? 'active' : ''}`} onClick={() => setMode('review')}>
            Review PR #{shared.pr.number} with Devin
          </button>
          <button role="radio" aria-checked={mode === 'draft'} className={`m-segment ${mode === 'draft' ? 'active' : ''}`} onClick={() => setMode('draft')}>
            Send as a message
          </button>
        </div>
      )}
      <main className="m-scroll">
        {!nothing && targets.length === 0 && <div className="m-empty">No sessions to share to.</div>}
        {!nothing && targets.length > 0 && (
          <ul className="m-list">
            <li className="m-list-head" role="presentation">{mode === 'review' && shared.pr ? 'Start the review in…' : 'Put it in the composer of…'}</li>
            {targets.map(r => (
              <SessionRow
                key={r.key}
                row={r}
                now={now}
                href={sharedConversationHref(r, mode === 'review' && shared.pr ? { reviewUrl: shared.pr.url } : { draft: shared.draft })}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
