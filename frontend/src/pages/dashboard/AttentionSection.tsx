import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import type { AttentionItem, LiveSummary, Severity } from './triage';
import { fmtAge } from '../../utils/format';

const CHIP: Record<Severity, { glyph: string; label: string }> = {
  critical: { glyph: '●', label: 'CRITICAL' },
  warning: { glyph: '▲', label: 'WARN' },
  notice: { glyph: '○', label: 'NOTE' },
};
const SHOW = 8;

export function projectHref(projectId: string, workstream?: string): string {
  return `/?project=${encodeURIComponent(projectId)}${workstream && workstream !== 'main' ? `&ws=${encodeURIComponent(workstream)}` : ''}`;
}

function Item({ it }: { it: AttentionItem }) {
  const chip = CHIP[it.severity];
  const body = (
    <>
      <span className={`attn-chip attn-chip--${it.severity}`} aria-label={it.severity}>{chip.glyph} {chip.label}</span>
      <span className="attn-body">
        <span className="attn-title">
          {it.projectName && (
            <span className="attn-project">
              <i className="attn-dot" style={{ background: it.projectColor ?? 'var(--text-muted)' }} />
              {it.projectName}
              {it.workstream && it.workstream !== 'main' && <span className="workstream-bar-badge">{it.workstream}</span>}
            </span>
          )}
          {it.title}
        </span>
        <span className="attn-detail">{it.detail}</span>
      </span>
      <span className="attn-action">{it.action} {it.projectId ? '→' : ''}</span>
    </>
  );
  return it.projectId
    ? <Link className="attn-item" to={projectHref(it.projectId, it.workstream)}>{body}</Link>
    : <div className="attn-item">{body}</div>;
}

interface Props {
  items: AttentionItem[];
  summary: LiveSummary;
  loaded: boolean;
  checkedAt: number | null;
  now: number;
}

export function AttentionSection({ items, summary, loaded, checkedAt, now }: Props) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SHOW);
  const checked = checkedAt ? `checked ${fmtAge(now - checkedAt)} ago` : 'checking…';
  const counts = `${summary.working} working · ${summary.waiting} waiting · ${summary.idle} idle · ${summary.notRunning} not running`
    + (summary.offlineHosts ? ` · ${summary.offlineHosts} host${summary.offlineHosts > 1 ? 's' : ''} offline` : '');

  return (
    <section className="dash-section" aria-labelledby="attn-h">
      <div className="dash-section-title" id="attn-h">
        Attention {loaded && items.length > 0 && <span className="dash-count">{items.length}</span>}
      </div>
      {!loaded ? (
        <div className="attn-empty dash-stale"><span className="attn-empty-glyph">…</span><div>checking your sessions</div></div>
      ) : items.length === 0 ? (
        <div className="attn-empty">
          <span className="attn-empty-glyph" aria-hidden>✓</span>
          <div>
            <div>Nothing heavy or stale.</div>
            <div className="attn-empty-sub">{counts} · {checked}</div>
          </div>
        </div>
      ) : (
        <>
          <div className="attn-list">{shown.map(it => <Item key={it.id} it={it} />)}</div>
          <div className="attn-foot">
            {items.length > SHOW && (
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setAll(a => !a)}>
                {all ? 'show fewer' : `+${items.length - SHOW} more`}
              </button>
            )}
            <span className="usage-dim">{counts} · {checked}</span>
          </div>
        </>
      )}
    </section>
  );
}
