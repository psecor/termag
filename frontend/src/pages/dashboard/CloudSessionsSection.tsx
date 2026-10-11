import React, { useState } from 'react';
import type { CloudSession } from '../../types';
import { fmtAge } from '../../utils/format';
import { cloudStateLabel, fmtDurationSec, platformLabel } from '../../utils/cloudSessions';
import { PROVIDERS } from '../../providers/registry';

/**
 * Claude Code cloud sessions on the owner's boxes:
 * the active ones first, then the last 30 days, newest first. Owner only. The
 * section is absent until there is at least one session to show.
 */
const SHOW = 10;

function Row({ s, now }: { s: CloudSession; now: number }) {
  const run = s.current;
  const started = run ? Date.parse(run.startedAt) : Date.parse(s.firstSeenAt);
  const duration = run?.durationSec ?? (run && !run.endedAt ? Math.round((now - started) / 1000) : null);
  const title = s.url
    ? <a href={s.url} target="_blank" rel="noreferrer" title="Open on claude.ai">{s.name}</a>
    : <span>{s.name}</span>;
  const claude = PROVIDERS.claude;
  return (
    <tr className={`cloud-row cloud-${s.state}`}>
      <td className="cloud-title-cell">
        <span
          className="project-provider-badge cloud-provider-badge"
          style={{ borderColor: claude.color.bright.replace(/[\d.]+\)$/, '0.45)'), background: claude.color.base.replace(/[\d.]+\)$/, '0.16)') }}
          title="Claude Code cloud session (claude.ai)"
        >{claude.badge} ☁</span>
        {title}
      </td>
      <td className="cloud-title-cell usage-dim" title={s.title ?? ''}>{s.title ?? '—'}</td>
      <td><span className={`cloud-state cloud-state--${s.state}`} title={s.queuedReason ?? ''}>{cloudStateLabel(s)}</span></td>
      <td>{run ? `${run.boxName} · slot ${run.slot}` : '—'}</td>
      <td>{platformLabel(s.clientPlatform) ?? '—'}</td>
      <td title={new Date(started).toLocaleString()}>{fmtAge(Math.max(0, now - started))} ago</td>
      <td>{fmtDurationSec(duration)}</td>
      <td>{s.runs.length > 1 ? `${s.runs.length} runs` : ''}</td>
    </tr>
  );
}

export function CloudSessionsSection({ active, recent, now }: { active: CloudSession[] | null; recent: CloudSession[] | null; now: number }) {
  const [all, setAll] = useState(false);
  // The two polls are independent and each keeps its last good payload, so a
  // session that ended between fetches can be in both; the active row wins.
  const seen = new Set<string>();
  const rows = [...(active ?? []), ...(recent ?? [])].filter(s => (seen.has(s.key) ? false : (seen.add(s.key), true)));
  if (rows.length === 0) return null;
  const visible = all ? rows : rows.slice(0, SHOW);
  return (
    <section className="dash-section" aria-labelledby="cloud-h">
      <div className="dash-section-title" id="cloud-h">
        <span>Cloud sessions</span>
        <span className="usage-dim">
          {active?.length ? `${active.length} active · ` : ''}{recent?.length ?? 0} in the last 30 days
        </span>
        {rows.length > SHOW && (
          <button type="button" className="recents-link" onClick={() => setAll(a => !a)}>
            {all ? `show first ${SHOW}` : 'show all'}
          </button>
        )}
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table admin-table--dense cloud-table">
          <thead>
            <tr><th>Session</th><th>Title</th><th>State</th><th>Box</th><th>From</th><th>Started</th><th>Duration</th><th></th></tr>
          </thead>
          <tbody>
            {visible.map(s => <Row key={s.key} s={s} now={now} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}
