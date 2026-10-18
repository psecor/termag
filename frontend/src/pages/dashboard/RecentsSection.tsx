import React, { useState } from 'react';
import { useRecents } from '../../hooks/useRecents';
import { RecentsList } from '../../components/RecentsList';
import { filterRecents, groupRecentsByDay, RECENTS_DEFAULT_LIMIT } from '../../utils/recents';

/**
 * "Recents" on the dashboard: the sessions you opened most recently, newest
 * first, so you can scan and remember what you were working on. Ten by
 * default; "show all" expands and groups by day. Archived projects stay in,
 * dimmed — the point here is recall, not jumping.
 */
export function RecentsSection({ now }: { now: number }) {
  const [all, setAll] = useState(false);
  const { rows, loading } = useRecents(all ? 'all' : RECENTS_DEFAULT_LIMIT);
  const visible = filterRecents(rows ?? [], { includeArchived: true });

  return (
    <section className="dash-section" aria-labelledby="recents-h">
      <div className="dash-section-title" id="recents-h">
        <span>Recents</span>
        <span className="usage-dim">
          {rows === null ? 'loading…' : all ? `${visible.length} sessions` : `last ${Math.min(visible.length, RECENTS_DEFAULT_LIMIT)}`}
          {loading && rows !== null ? ' · refreshing' : ''}
        </span>
        {rows !== null && (
          <button type="button" className="recents-link" onClick={() => setAll(a => !a)}>
            {all ? `Show last ${RECENTS_DEFAULT_LIMIT}` : 'Show all'}
          </button>
        )}
      </div>
      {rows === null ? null : all ? (
        groupRecentsByDay(visible, now).map(g => (
          <div key={g.label} className="recents-group">
            <div className="recents-group-label">{g.label}</div>
            <RecentsList rows={g.rows} now={now} mode="link" />
          </div>
        ))
      ) : (
        <RecentsList rows={visible.slice(0, RECENTS_DEFAULT_LIMIT)} now={now} mode="link" />
      )}
    </section>
  );
}
