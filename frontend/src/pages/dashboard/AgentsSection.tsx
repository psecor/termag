import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { LineChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, YAxis } from 'recharts';
import { spawnsApi, type SpawnNode, type SpawnSession, type SpawnUsage } from '../../services/api';
import { PROVIDERS } from '../../providers/registry';
import { fmtAge, fmtK } from '../../utils/format';
import { networkLink, sessionNetworkLink } from '../../utils/spawnNetwork';
import {
  childLink, fosterNote, groupTreesByOrigin, hasSpawnActivity, meterFill, meterTone, nodeTokenTotal, pickedSession, reasonLabel, sessionKey,
  spawnActions, spawnStateLabel, spawnStateTone,
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

export function ProviderBadge({ id }: { id: string }) {
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

const errorText = (err: unknown) => (err as { response?: { data?: { error?: string } } }).response?.data?.error ?? (err as Error).message;

const ACTION_LABEL = { park: 'Park', resume: 'Resume', retire: 'Retire' } as const;

/** Park / Resume / Retire for one spawned agent. */
function RowActions({ n, onChanged }: { n: SpawnNode; onChanged?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = spawnActions(n);
  if (!actions.length && !error) return null;
  const where = `${n.child.projectName}${n.child.workstream === 'main' ? '' : `/${n.child.workstream}`}`;
  const run = async (a: 'park' | 'resume' | 'retire') => {
    if (a === 'retire' && !window.confirm(`Retire ${where}? Its workstream, worktree and tmux pair are removed, and its local branch once pushed. It is refused if that would lose uncommitted or unpushed work.`)) return;
    setBusy(a);
    setError(null);
    try {
      if (a === 'resume') await spawnsApi.resume(n.id);
      else await spawnsApi.dismiss(n.id, a);
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="spawn-actions">
      {actions.map(a => (
        <button key={a} type="button" className="recents-link" disabled={busy !== null} onClick={() => void run(a)}
          title={a === 'park' ? 'Stop its agent CLI; keep the worktree and conversation' : a === 'resume' ? 'Start it again on its conversation' : 'Remove its workstream when nothing would be lost'}>
          {busy === a ? '…' : ACTION_LABEL[a]}
        </button>
      ))}
      {error && <span className="spawn-error" role="alert">{error}</span>}
    </div>
  );
}

/** A select of the owner's sessions; picking one calls onPick (the select resets after). */
function SessionPicker({ sessions, label, placeholder, value, onPick, disabled, clearLabel }: {
  sessions: SpawnSession[]; label: string; placeholder: string; value?: string; disabled?: boolean;
  onPick: (to: { projectId: string; workstream: string } | null) => void; clearLabel?: string;
}) {
  return (
    <select className="spawn-picker" aria-label={label} value={value ?? ''} disabled={disabled}
      onChange={e => { const v = e.target.value; if (v === '__clear') onPick(null); else { const to = pickedSession(v); if (to) onPick(to); } }}>
      <option value="" disabled={!value}>{placeholder}</option>
      {clearLabel && value && <option value="__clear">{clearLabel}</option>}
      {sessions.map(s => <option key={sessionKey(s)} value={sessionKey(s)}>{s.label}</option>)}
    </select>
  );
}

/** "Adopt into…" for an orphan: the picked session takes its reports from then on. */
function AdoptInto({ n, sessions, onChanged }: { n: SpawnNode; sessions: SpawnSession[]; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = sessions.filter(s => !(s.projectId === n.child.projectId && s.workstream === n.child.workstream));
  const pick = async (to: { projectId: string; workstream: string } | null) => {
    if (!to) return;
    setBusy(true);
    setError(null);
    try {
      await spawnsApi.adopt(n.id, to);
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="spawn-actions">
      <SessionPicker sessions={own} label={`Adopt ${n.child.projectName}/${n.child.workstream} into`} placeholder={busy ? 'Adopting…' : 'Adopt into…'} disabled={busy} onPick={to => void pick(to)} />
      {error && <span className="spawn-error" role="alert">{error}</span>}
    </div>
  );
}

/** The orphan home: where orphans go when no ancestor is alive. */
function OrphanHome({ usage, onChanged }: { usage: SpawnUsage; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessions = usage.sessions ?? [];
  const home = usage.orphanHome ?? null;
  const pick = async (to: { projectId: string; workstream: string } | null) => {
    setBusy(true);
    setError(null);
    try {
      await spawnsApi.setOrphanHome(to);
      onChanged?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="usage-dim spawn-limits-note spawn-orphan-home">
      <span>Orphan home</span>
      <SessionPicker sessions={sessions} label="Orphan home" placeholder="none: orphans wait here" value={home ? sessionKey(home) : undefined}
        disabled={busy} onPick={to => void pick(to)} clearLabel="none: orphans wait here" />
      <span>
        {home && !home.label ? 'its session is gone, so orphans wait here; pick another. ' : ''}
        When a spawned agent's parent goes away, its nearest living ancestor adopts it, else this session if its agent pane is running then.
      </span>
      {error && <span className="spawn-error" role="alert">{error}</span>}
    </div>
  );
}

export function TreeRow({ n, now, onChanged, sessions, adopt, network }: { n: SpawnNode; now: number; onChanged?: () => void; sessions?: SpawnSession[]; adopt?: boolean; network?: string }) {
  const link = childLink(n);
  const foster = fosterNote(n, sessions);
  const where = `${n.child.projectName}${n.child.workstream === 'main' ? '' : `/${n.child.workstream}`}`;
  const tokens = nodeTokenTotal(n);
  const started = Date.parse(n.createdAt);
  const summary = n.report?.summary.split('\n').find(l => l.trim()) ?? '';
  return (
    <tr className={`spawn-row spawn-row--${spawnStateTone(n)}${n.orphanedAt ? ' spawn-row--orphan' : ''}`}>
      <td className="spawn-agent-cell" style={{ paddingLeft: 8 + n.level * 18 }}>
        {n.level > 0 && <span className="spawn-branch" aria-hidden="true">↳ </span>}
        {link ? <Link to={link} title={n.child.session}>{where}</Link> : <span title={n.child.session}>{where}</span>}
        {network && <Link className="spawn-net-link" to={networkLink(network)} title="This tree as a network, live">network ↗</Link>}
        <div className="spawn-title usage-dim" title={n.title}>{n.title}</div>
        {n.orphanedAt && <div className="spawn-foster spawn-foster--orphan">○ orphaned: its parent went away</div>}
        {foster && <div className="spawn-foster usage-dim">⇢ {foster}</div>}
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
      <td>
        {adopt && sessions && <AdoptInto n={n} sessions={sessions} onChanged={onChanged} />}
        <RowActions n={n} onChanged={onChanged} />
      </td>
    </tr>
  );
}

/** The parent row: the session that started the trees below it. */
function OriginRow({ g, folded, onToggle }: { g: ReturnType<typeof groupTreesByOrigin>[number]; folded: boolean; onToggle: () => void }) {
  const label = g.origin ? g.origin.label : 'Started from the dashboard';
  const counts = [
    `${g.trees.length} tree${g.trees.length === 1 ? '' : 's'}`,
    `${g.agents} agent${g.agents === 1 ? '' : 's'}`,
    g.running ? `${g.running} running` : null,
    g.attention ? `${g.attention} waiting on someone` : null,
  ].filter(Boolean).join(' · ');
  return (
    <tbody className="spawn-origin">
      <tr className="spawn-origin-row">
        <td colSpan={9}>
          <button type="button" className="spawn-origin-toggle" aria-expanded={!folded} onClick={onToggle}
            title={folded ? 'Show its trees' : 'Fold its trees into this row'}>
            <span aria-hidden="true">{folded ? '▸' : '▾'}</span> <strong>{label}</strong>
          </button>
          <span className="usage-dim">{g.origin ? ' your session · ' : ' '}{counts}</span>
          {g.origin && <Link className="spawn-net-link" to={sessionNetworkLink(g.origin.projectId, g.origin.workstream)} title="Every tree this session started, as one network">network ↗</Link>}
        </td>
      </tr>
    </tbody>
  );
}

export const TreeHead = () => <tr><th>Agent</th><th>As</th><th>CLI</th><th>State</th><th>Pane</th><th>Started</th><th>Tokens</th><th>Last report</th><th></th></tr>;

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

export function AgentsSection({ usage, now, onChanged }: { usage: SpawnUsage | null; now: number; onChanged?: () => void }) {
  const [all, setAll] = useState(false);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const toggle = (key: string) => setFolded(f => { const next = new Set(f); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  if (!hasSpawnActivity(usage)) return null;
  const { budget, trees, treesTotal, refusals, boxes, days } = usage;
  const l = budget.limits;
  const refusedTotal = refusals.reduce((s, r) => s + r.count, 0);
  const visible = all ? trees : trees.slice(0, SHOW_TREES);
  const orphans = usage.orphans ?? [];
  const sessions = usage.sessions;
  const head = <TreeHead />;
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

      {orphans.length > 0 && (
        <div className="admin-table-wrap spawn-orphans">
          <div className="dash-section-title spawn-orphans-title">
            <span>Orphans</span>
            <span className="usage-dim">{orphans.length} whose parent went away, with no living ancestor{usage.orphanHome?.label ? '' : ' or orphan home'} to take their reports</span>
          </div>
          <table className="admin-table admin-table--dense spawn-table">
            <thead>{head}</thead>
            <tbody>
              {orphans.map(n => <TreeRow key={n.id} n={{ ...n, level: 0 }} now={now} onChanged={onChanged} sessions={sessions} adopt />)}
            </tbody>
          </table>
        </div>
      )}

      {sessions && <OrphanHome usage={usage} onChanged={onChanged} />}

      {trees.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-table admin-table--dense spawn-table">
            <thead>{head}</thead>
            {groupTreesByOrigin(visible).map(g => (
              <React.Fragment key={g.key || 'browser'}>
                <OriginRow g={g} folded={folded.has(g.key)} onToggle={() => toggle(g.key)} />
                {!folded.has(g.key) && g.trees.map(t => (
                  <tbody key={t.rootId} className="spawn-tree spawn-tree--grouped">
                    {t.nodes.map((n, i) => <TreeRow key={n.id} n={n} now={now} onChanged={onChanged} sessions={sessions} network={i === 0 ? t.rootId : undefined} />)}
                  </tbody>
                ))}
              </React.Fragment>
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
