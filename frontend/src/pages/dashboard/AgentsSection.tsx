import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { LineChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, YAxis } from 'recharts';
import type { SpawnNode, SpawnUsage } from '../../services/api';
import { PROVIDERS } from '../../providers/registry';
import { fmtAge, fmtK } from '../../utils/format';
import {
  childLink, hasSpawnActivity, meterFill, meterTone, nodeTokenTotal, reasonLabel, spawnStateLabel, spawnStateTone,
} from '../../utils/spawnUsage';

/**
 * Agents your agents started: the limits that apply to you and how much of each is used, hints,
 * the spawn trees of the last week (plus any older one still running) with
 * their tokens, refusals by reason, and each box's memory over the last day.
 * Absent until there is a spawn or a refusal to show.
 */
const SHOW_TREES = 5;

function Meter({ label, used, limit, note }: { label: string; used: number; limit: number; note: string }) {
  const tone = meterTone(used, limit);
  return (
    <div className="dash-tile">
      <div className="dash-tile-label">{label}</div>
      <div className="dash-tile-value">{used}<span className="spawn-meter-of"> / {limit}</span></div>
      <div
        className={`spawn-meter spawn-meter--${tone}`}
        role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label={`${label}: ${used} of ${limit}`}
      >
        <div className="spawn-meter-fill" style={{ width: `${meterFill(used, limit) * 100}%` }} />
      </div>
      <div className={`dash-tile-delta ${tone === 'ok' ? '' : 'bad'}`}>{tone === 'full' ? 'at the limit' : tone === 'near' ? 'close to the limit' : note}</div>
    </div>
  );
}

function ProviderBadge({ id }: { id: string }) {
  const p = PROVIDERS[id];
  if (!p) return <span className="usage-dim">{id}</span>;
  return (
    <span
      className="project-provider-badge"
      style={{ borderColor: p.color.bright.replace(/[\d.]+\)$/, '0.45)'), background: p.color.base.replace(/[\d.]+\)$/, '0.16)') }}
      title={p.displayName}
    >{p.badge}</span>
  );
}

function TreeRow({ n, now }: { n: SpawnNode; now: number }) {
  const link = childLink(n);
  const where = `${n.child.projectName}${n.child.workstream === 'main' ? '' : `/${n.child.workstream}`}`;
  const tokens = nodeTokenTotal(n);
  const started = Date.parse(n.createdAt);
  const summary = n.report?.summary.split('\n').find(l => l.trim()) ?? '';
  return (
    <tr className={`spawn-row spawn-row--${spawnStateTone(n)}`}>
      <td className="spawn-agent-cell" style={{ paddingLeft: 8 + n.level * 18 }}>
        {n.level > 0 && <span className="spawn-branch" aria-hidden="true">↳ </span>}
        {link ? <Link to={link} title={n.child.session}>{where}</Link> : <span title={n.child.session}>{where}</span>}
        <div className="spawn-title usage-dim" title={n.title}>{n.title}</div>
      </td>
      <td>{n.relationship}</td>
      <td><ProviderBadge id={n.provider} /></td>
      <td><span className={`spawn-state spawn-state--${spawnStateTone(n)}`}>{spawnStateLabel(n)}</span></td>
      <td className="usage-dim">{n.endedAt ? '—' : n.child.status.replace(/_/g, ' ')}</td>
      <td title={new Date(started).toLocaleString()}>{fmtAge(Math.max(0, now - started))} ago</td>
      <td className="spawn-num">{tokens === null ? '—' : fmtK(tokens)}</td>
      <td className="spawn-report" title={n.report ? `${n.report.status}: ${n.report.summary}` : n.error ?? ''}>
        {n.report ? <><span className="usage-dim">{n.report.status.replace(/_/g, ' ')}:</span> {summary}</> : n.error ? <span className="spawn-error">{n.error}</span> : <span className="usage-dim">—</span>}
      </td>
    </tr>
  );
}

const HEAT_LABEL: Record<SpawnUsage['boxes'][number]['heat'], string> = {
  hot: '▲ running hot', warm: '△ getting busy', ok: 'ok', unknown: 'no recent sample',
};

function BoxCard({ b }: { b: SpawnUsage['boxes'][number] }) {
  const hotMem = b.hotMemPct;
  const series = b.samples.filter(s => s.memUsedPct !== null).map(s => ({ t: Date.parse(s.at), mem: s.memUsedPct as number }));
  const agents = b.liveAgents === null ? null : `${b.liveAgents}${b.capacity === null ? '' : ` / ${b.capacity}`} agent${b.liveAgents === 1 && b.capacity === null ? '' : 's'}`;
  const facts = [agents, b.memUsedPct === null ? null : `mem ${b.memUsedPct}%`, b.loadPerCore === null ? null : `load ${b.loadPerCore.toFixed(2)}/core`].filter(Boolean);
  return (
    <div className={`spawn-box spawn-box--${b.heat}`}>
      <div className="spawn-box-head">
        <span className="spawn-box-name">{b.name}</span>
        <span className={`spawn-heat spawn-heat--${b.heat}`} title={b.heatReasons.join(', ')}>{HEAT_LABEL[b.heat]}</span>
      </div>
      <div className="usage-dim spawn-box-facts">{facts.length ? facts.join(' · ') : '—'}</div>
      {series.length > 1 ? (
        <div className="spawn-spark" aria-label={`${b.name} memory over the last day`}>
          <ResponsiveContainer width="100%" height={40}>
            <LineChart data={series} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
              <YAxis domain={[0, 100]} hide />
              <ReferenceLine y={hotMem} stroke="var(--warning)" strokeDasharray="3 3" strokeWidth={1} />
              <Line type="monotone" dataKey="mem" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Tooltip
                cursor={{ stroke: 'var(--border)' }}
                content={({ active, payload }) => {
                  const p = active && payload?.[0]?.payload as { t: number; mem: number } | undefined;
                  if (!p) return null;
                  return (
                    <div className="dash-tip" role="tooltip">
                      <div className="dash-tip-label">{new Date(p.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                      <div className="dash-tip-row"><span className="dash-tip-value">{p.mem}%</span><span className="dash-tip-name">memory</span></div>
                    </div>
                  );
                }}
              />
            </LineChart>
          </ResponsiveContainer>
          <div className="usage-dim spawn-spark-caption">memory, last 24 h · dashed: refuses spawns at {hotMem}%</div>
        </div>
      ) : (
        <div className="usage-dim spawn-spark-caption">no history yet (samples every 5 min)</div>
      )}
    </div>
  );
}

export function AgentsSection({ usage, now }: { usage: SpawnUsage | null; now: number }) {
  const [all, setAll] = useState(false);
  if (!hasSpawnActivity(usage)) return null;
  const { budget, trees, treesTotal, refusals, boxes, days } = usage;
  const l = budget.limits;
  const refusedTotal = refusals.reduce((s, r) => s + r.count, 0);
  const visible = all ? trees : trees.slice(0, SHOW_TREES);
  return (
    <section className="dash-section" aria-labelledby="agents-h">
      <div className="dash-section-title" id="agents-h">
        <span>Spawned agents</span>
        <span className="usage-dim">
          {budget.used.running} running · {treesTotal > trees.length ? `the newest ${trees.length} of ${treesTotal} trees` : `${trees.length} tree${trees.length === 1 ? '' : 's'}`} in the last {days} days
        </span>
        {trees.length > SHOW_TREES && (
          <button type="button" className="recents-link" onClick={() => setAll(a => !a)}>
            {all ? `Show first ${SHOW_TREES}` : 'Show all'}
          </button>
        )}
      </div>

      <div className="dash-kpis">
        <Meter label="Spawned this hour" used={budget.used.lastHour} limit={l.perHour} note="rolling hour" />
        <Meter label="Running now" used={budget.used.running} limit={l.maxConcurrentPerUser} note="not yet ended" />
        <div className="dash-tile">
          <div className="dash-tile-label">Finished, still running</div>
          <div className="dash-tile-value">{budget.finishedRunning}</div>
          <div className={`dash-tile-delta ${budget.finishedRunning ? 'bad' : ''}`}>{budget.finishedRunning ? 'stop them to free box memory' : 'none holding memory'}</div>
        </div>
        <div className="dash-tile">
          <div className="dash-tile-label">Refused, last {days} days</div>
          <div className="dash-tile-value">{refusedTotal}</div>
          <div className="dash-tile-delta" title={refusals.map(r => `${r.count} ${reasonLabel(r.reason)}`).join(', ')}>
            {refusals.length ? refusals.slice(0, 2).map(r => `${r.count} ${reasonLabel(r.reason)}`).join(' · ') : 'none'}
          </div>
        </div>
      </div>
      <div className="usage-dim spawn-limits-note">
        Also per spawn: depth ≤ {l.maxDepth}, ≤ {l.maxOpenChildren} unreported children per session
        {l.boxCapacity === null ? '' : `, ≤ ${l.boxCapacity} agents per box`}. Set by your admins (agent-spawn-limits).
      </div>

      {budget.hints.length > 0 && (
        <ul className="spawn-hints">
          {budget.hints.map(h => <li key={`${h.kind}:${h.message}`} className={`spawn-hint spawn-hint--${h.kind}`}><span aria-hidden="true">⚠ </span>{h.message}</li>)}
        </ul>
      )}

      {trees.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table admin-table--dense spawn-table">
            <thead>
              <tr><th>Agent</th><th>As</th><th>CLI</th><th>State</th><th>Pane</th><th>Started</th><th>Tokens</th><th>Last report</th></tr>
            </thead>
            {visible.map(t => (
              <tbody key={t.rootId} className="spawn-tree">
                {t.nodes.map(n => <TreeRow key={n.id} n={n} now={now} />)}
              </tbody>
            ))}
          </table>
        </div>
      )}

      {boxes.length > 0 && (
        <div className="spawn-boxes">
          {boxes.map(b => <BoxCard key={b.id} b={b} />)}
        </div>
      )}
    </section>
  );
}
