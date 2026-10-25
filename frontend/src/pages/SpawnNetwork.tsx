import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { spawnsApi, type SpawnNode, type SpawnTreeView } from '../services/api';
import { PROVIDERS } from '../providers/registry';
import { fmtK } from '../utils/format';
import { childLink, fosterNote, spawnStateLabel } from '../utils/spawnUsage';
import {
  NODE_H, NODE_W, ORIGIN_ID, edgePath, firstLine, fmtDuration, networkTone, nodeLabel, latestOnly, sessionNetworkLink, tidyLayout, treeSessions, type NetworkTone,
} from '../utils/spawnNetwork';
import { REPLAY_SPEEDS, advancePlayhead, buildLanes, offsetLabel, replaySpan, snapshotAt, type Lane, type PaneTone } from '../utils/spawnReplay';
import { radialLayout, radialPath } from '../utils/spawnRadial';
import { ProviderBadge, TreeHead, TreeRow } from './dashboard/AgentsSection';

/**
 * One spawn tree as a network: the tidy or the radial layout, live by polling, the
 * session that started it, dashed "adopted by" edges, a ring on orphans, a
 * replay scrubber and a timeline strip over the tree's events, its totals,
 * and the same nodes and events as tables. Mounted like the dashboard: no
 * status WebSocket and no human heartbeat, so reading it is not working time.
 */
const POLL_MS = 5000;
const SHOW_EVENTS = 100;
/** How often play advances the playhead. */
const TICK_MS = 100;

const TONE_LABEL: Record<NetworkTone, string> = {
  working: 'working', waiting: 'waiting on someone', idle: 'idle', done: 'done', failed: 'failed', parked: 'parked', ended: 'ended or retired',
};

type Target = { kind: 'tree'; rootId: string } | { kind: 'session'; projectId: string; workstream: string };

const targetKey = (t: Target) => (t.kind === 'tree' ? `tree:${t.rootId}` : `session:${t.projectId}/${t.workstream}`);

function useTree(target: Target) {
  const key = targetKey(target);
  const [view, setView] = useState<SpawnTreeView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the latest request may land: a slow poll, or one for the tree before
  // a navigation, must not replace a newer answer.
  const latest = useRef(latestOnly());
  const load = useCallback(async () => {
    const current = latest.current.start();
    try {
      const v = target.kind === 'tree' ? await spawnsApi.tree(target.rootId) : await spawnsApi.sessionTree(target.projectId, target.workstream);
      if (!current()) return;
      setView(v);
      setError(null);
    } catch (err) {
      if (!current()) return;
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 404) {
        setView(null);
        setError(target.kind === 'tree' ? 'No such spawn tree, or it is not yours.' : 'That session started no spawn trees in the last week, or it is not yours.');
      } else {
        // A blip keeps the last good tree on screen, marked by the error.
        setError((err as Error).message);
      }
    }
    // The key names the target; the object itself is new on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    setView(null);
    setError(null);
    void load();
    // Only while the tab is visible: a background tab polls nothing.
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { latest.current.cancel(); clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);
  return { view, error, reload: load };
}

function NodeCard({ n, x, y, outsideFoster, onOpen }: { n: SpawnNode; x: number; y: number; outsideFoster: string | null; onOpen: (n: SpawnNode) => void }) {
  const tone = networkTone(n);
  const p = PROVIDERS[n.provider];
  const state = spawnStateLabel(n);
  const pane = n.endedAt || n.retiredAt ? null : paneLabel(n.child.status);
  const tip = [nodeLabel(n), firstLine(n.title), `state: ${state}`, pane ? `pane: ${pane}` : null, outsideFoster ? `⇢ ${outsideFoster}` : null, n.orphanedAt ? '○ orphaned: its parent went away' : null]
    .filter(Boolean).join('\n');
  const open = childLink(n);
  return (
    <g
      className={`spawn-net-node spawn-net-node--${tone}`}
      transform={`translate(${x},${y})`}
      role={open ? 'link' : 'img'}
      tabIndex={open ? 0 : -1}
      aria-label={tip.replace(/\n/g, ', ')}
      onClick={() => open && onOpen(n)}
      onKeyDown={e => { if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(n); } }}
    >
      <title>{tip}</title>
      {n.orphanedAt && <rect className="spawn-net-ring" x={-5} y={-5} width={NODE_W + 10} height={NODE_H + 10} rx={12} />}
      <rect className="spawn-net-box" width={NODE_W} height={NODE_H} rx={8} />
      <text className="spawn-net-badge" x={10} y={19} fill={p?.color.bright}>{p?.badge ?? n.provider}</text>
      <text className="spawn-net-label" x={34} y={19}>{clip(nodeLabel(n), 22)}</text>
      <text className="spawn-net-sub" x={10} y={37}>
        {clip(outsideFoster ? `⇢ ${outsideFoster}` : `${n.orphanedAt ? '○ ' : ''}${state}${pane && pane !== 'idle' ? ` · ${pane}` : ''}`, 32)}
      </text>
    </g>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A pane status in words; a replay before any status event says so rather than guessing. */
const paneLabel = (status: string) => (status === 'unknown' ? 'no status yet' : status.replace(/_/g, ' '));

/** Positions come from the whole tree (`full`), so a replay never moves a node; what is drawn comes from `view`. */
function Network({ full, view, onOpen }: { full: SpawnTreeView; view: SpawnTreeView; onOpen: (n: SpawnNode) => void }) {
  const whole = useMemo(() => tidyLayout(full), [full]);
  const layout = useMemo(() => tidyLayout(view), [view]);
  const at = new Map(whole.nodes.map(p => [p.id, p]));
  const sessions = useMemo(() => treeSessions(full), [full]);
  return (
    <div className="spawn-net-scroll">
      <svg className="spawn-net" width={whole.width} height={whole.height} role="group" aria-label="Spawn network: the session that started it on the left, children to the right">
        {layout.edges.map(e => {
          const a = at.get(e.from), b = at.get(e.to);
          if (!a || !b) return null;
          return <path key={`${e.kind}:${e.from}:${e.to}`} className={`spawn-net-edge spawn-net-edge--${e.kind}`} d={edgePath(a, b, e.kind)} />;
        })}
        {layout.nodes.map(q => {
          const p = { ...q, x: at.get(q.id)?.x ?? q.x, y: at.get(q.id)?.y ?? q.y };
          if (!p.node) {
            const o = view.origin!;
            return (
              <g key={ORIGIN_ID} className="spawn-net-node spawn-net-node--origin" transform={`translate(${p.x},${p.y})`} role="img" aria-label={`${o.label}: the session that started this tree, ${o.status.replace(/_/g, ' ')}`}>
                <title>{`${o.session}\nstarted this tree · ${o.status.replace(/_/g, ' ')}`}</title>
                <rect className="spawn-net-box" width={NODE_W} height={NODE_H} rx={8} />
                <text className="spawn-net-label" x={10} y={19}>{clip(o.label, 26)}</text>
                <text className="spawn-net-sub" x={10} y={37}>{`your session · ${o.status.replace(/_/g, ' ')}`}</text>
              </g>
            );
          }
          const outside = layout.fosteredOutside.has(p.id) ? fosterNote(p.node, sessions) : null;
          return <NodeCard key={p.id} n={p.node} x={p.x} y={p.y} outsideFoster={outside} onOpen={onOpen} />;
        })}
      </svg>
    </div>
  );
}

const sessionLabelOf = (sessions: Array<{ projectId: string; workstream: string; label: string }>, f: { projectId: string; workstream: string }) =>
  sessions.find(x => x.projectId === f.projectId && x.workstream === f.workstream)?.label ?? 'another session';
const shortName = (n: SpawnNode) => (n.child.workstream === 'main' ? n.child.projectName : n.child.workstream);

function Radial({ full, view, onOpen }: { full: SpawnTreeView; view: SpawnTreeView; onOpen: (n: SpawnNode) => void }) {
  const whole = useMemo(() => radialLayout(full), [full]);
  const layout = useMemo(() => radialLayout(view, full), [view, full]);
  const sessions = useMemo(() => treeSessions(full), [full]);
  const at = new Map(whole.nodes.map(p => [p.id, p]));
  if (!whole.size) return null;
  return (
    <div className="spawn-net-scroll spawn-net-scroll--radial">
      <svg className="spawn-net" width={whole.size} height={whole.size} role="group" aria-label="Spawn network, radial: the root at the center, its children on rings outward; node size is tokens, branch width is how long it ran">
        {layout.edges.map(e => {
          const a = at.get(e.from), b = at.get(e.to);
          if (!a || !b) return null;
          return <path key={`${e.kind}:${e.from}:${e.to}`} className={`spawn-net-edge spawn-net-edge--${e.kind}`} style={{ strokeWidth: e.width }} d={radialPath(a, b, whole.center, e.kind)} />;
        })}
        {layout.nodes.map(q => {
          const p = at.get(q.id);
          if (!p) return null;
          const n = q.node;
          if (!n) {
            // A session's view: the session itself at the center.
            const o = full.origin;
            const label = o?.label ?? 'this session';
            const st = o ? paneLabel(o.status) : '';
            return (
              <g key={p.id} className="spawn-net-node spawn-net-node--origin" role="img" aria-label={`${label}: the session that started these trees${st ? `, ${st}` : ''}`}>
                <title>{`${o?.session ?? label}\nstarted these trees${st ? ` · ${st}` : ''}`}</title>
                <circle className="spawn-net-box" cx={p.x} cy={p.y} r={p.r} />
                <text className="spawn-net-sub spawn-net-radial-label" x={p.x} y={p.y + p.r + 14} textAnchor="middle">{clip(label, 18)}</text>
              </g>
            );
          }
          const tone = networkTone(n);
          const state = spawnStateLabel(n);
          const outside = layout.fosteredOutside.has(n.id) ? fosterNote(n, sessions) : null;
          const tip = [nodeLabel(n), firstLine(n.title), `state: ${state}`, `pane: ${paneLabel(n.child.status)}`, outside ? `⇢ ${outside}` : null, n.orphanedAt ? '○ orphaned' : null].filter(Boolean).join('\n');
          const open = childLink(n);
          const right = Math.cos(p.angle) >= -0.01;
          const isRoot = n.id === full.rootId && full.scope !== 'session';
          return (
            <g key={p.id} className={`spawn-net-node spawn-net-node--${tone}`} role={open ? 'link' : 'img'} tabIndex={open ? 0 : -1}
              aria-label={tip.replace(/\n/g, ', ')}
              onClick={() => open && onOpen(n)}
              onKeyDown={e => { if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(n); } }}>
              <title>{tip}</title>
              {n.orphanedAt && <circle className="spawn-net-ring" cx={p.x} cy={p.y} r={p.r + 5} />}
              <circle className="spawn-net-box" cx={p.x} cy={p.y} r={p.r} />
              <text className="spawn-net-sub spawn-net-radial-label" x={isRoot ? p.x : p.x + (right ? p.r + 6 : -(p.r + 6))} y={isRoot ? p.y + p.r + 14 : p.y + 4}
                textAnchor={isRoot ? 'middle' : right ? 'start' : 'end'}>
                {clip(shortName(n), 16)}{n.orphanedAt ? ' ○' : ''}{outside && n.foster ? ` ⇢ ${clip(sessionLabelOf(sessions, n.foster), 14)}` : ''}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const LANE_H = 12, LANE_GAP = 6, LABEL_W = 170, TL_W = 1000, AXIS_H = 18;
const LANE_LABEL: Record<PaneTone, string> = { working: 'working', waiting: 'waiting', idle: 'idle', off: 'not running', unknown: 'no status yet', parked: 'parked', ended: 'ended' };

/** One lane per node: pane status over time, marks for reports and adoptions, the playhead. Click to move it. */
function Timeline({ view, lanes, span, t, onSeek }: { view: SpawnTreeView; lanes: Lane[]; span: { start: number; end: number }; t: number; onSeek: (t: number) => void }) {
  const width = TL_W - LABEL_W;
  const len = Math.max(1, span.end - span.start);
  const x = (ms: number) => LABEL_W + ((Math.min(Math.max(ms, span.start), span.end) - span.start) / len) * width;
  const height = AXIS_H + lanes.length * (LANE_H + LANE_GAP);
  const names = new Map(view.nodes.map(n => [n.id, nodeLabel(n)]));
  const seek = (e: React.MouseEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - box.left) / box.width) * TL_W;
    if (vx < LABEL_W) return;
    onSeek(span.start + ((vx - LABEL_W) / width) * len);
  };
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => span.start + f * len);
  return (
    <div className="spawn-tl-wrap">
      <svg className="spawn-tl" viewBox={`0 0 ${TL_W} ${height}`} width="100%" onClick={seek} role="img"
        aria-label="Timeline: one lane per agent, coloured by its pane status over time; click to move the playhead">
        {ticks.map(ms => (
          <g key={ms}>
            <line className="spawn-tl-grid" x1={x(ms)} x2={x(ms)} y1={AXIS_H - 4} y2={height} />
            <text className="spawn-tl-axis" x={x(ms)} y={11} textAnchor={ms === span.start ? 'start' : ms === span.end ? 'end' : 'middle'}>{offsetLabel(ms - span.start)}</text>
          </g>
        ))}
        {lanes.map((l, i) => {
          const y = AXIS_H + i * (LANE_H + LANE_GAP);
          return (
            <g key={l.id}>
              <text className="spawn-tl-name" x={LABEL_W - 8} y={y + LANE_H - 2} textAnchor="end">{clip(names.get(l.id) ?? l.id, 24)}</text>
              {l.segments.map(sg => (
                <rect key={sg.from} className={`spawn-tl-seg spawn-tl-seg--${sg.tone}`} x={x(sg.from)} y={y} width={Math.max(1, x(sg.to) - x(sg.from) - 1)} height={LANE_H} rx={3}>
                  <title>{`${names.get(l.id)}: ${LANE_LABEL[sg.tone]}, ${offsetLabel(sg.from - span.start)} → ${offsetLabel(sg.to - span.start)}`}</title>
                </rect>
              ))}
              {l.marks.map(m => (
                <path key={`${m.kind}:${m.at}`} className={`spawn-tl-mark spawn-tl-mark--${m.kind}`} d={`M${x(m.at)},${y - 2} l4,${LANE_H / 2 + 2} l-4,${LANE_H / 2 + 2} l-4,${-(LANE_H / 2 + 2)} z`}>
                  <title>{`${names.get(l.id)}: ${m.kind}${m.reason ? ` (${m.reason.replace(/_/g, ' ')})` : ''} at ${offsetLabel(m.at - span.start)}`}</title>
                </path>
              ))}
            </g>
          );
        })}
        <line className="spawn-tl-playhead" x1={x(t)} x2={x(t)} y1={AXIS_H - 4} y2={height} />
      </svg>
      <ul className="spawn-net-legend spawn-tl-legend" aria-label="Timeline legend">
        {(['working', 'waiting', 'idle', 'off', 'parked', 'unknown'] as PaneTone[]).map(k => (
          <li key={k}><span className={`spawn-tl-swatch spawn-tl-seg--${k}`} aria-hidden="true" />{LANE_LABEL[k]}</li>
        ))}
        <li><span className="spawn-tl-diamond spawn-tl-mark--reported" aria-hidden="true" />reported</li>
        <li><span className="spawn-tl-diamond spawn-tl-mark--adopted" aria-hidden="true" />adopted or orphaned</li>
      </ul>
    </div>
  );
}

/** The playhead: null is live (now, moving with each poll); a time is a replay. */
function useReplay(view: SpawnTreeView | null) {
  const [t, setT] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(REPLAY_SPEEDS[0]);
  const span = useMemo(() => (view ? replaySpan(view) : { start: 0, end: 0 }), [view]);
  // The playhead as of the last render, so the interval decides the end itself
  // (no side effects inside a state updater).
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    if (!playing) return;
    // Advance by the wall time that really passed: a tick that runs late on a big tree
    // would otherwise slow playback below the chosen speed.
    let last = performance.now();
    const id = setInterval(() => {
      const nowMs = performance.now();
      const step = advancePlayhead(tRef.current ?? span.start, nowMs - last, speed, span.end);
      last = nowMs;
      setT(step.t);
      if (step.done) setPlaying(false);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, speed, span.start, span.end]);
  const play = () => {
    // From the start when at the end or live; else from where it is.
    setT(cur => (cur === null || cur >= span.end ? span.start : cur));
    setPlaying(true);
  };
  return {
    t, span, playing, speed, setSpeed, play,
    pause: () => setPlaying(false),
    seek: (ms: number) => { setPlaying(false); setT(Math.min(Math.max(ms, span.start), span.end)); },
    live: () => { setPlaying(false); setT(null); },
  };
}

function ReplayBar({ r, truncated, limit }: { r: ReturnType<typeof useReplay>; truncated: boolean; limit?: number }) {
  const { span } = r;
  const at = r.t ?? span.end;
  return (
    <div className="spawn-replay">
      <button type="button" className="btn-ghost" onClick={r.playing ? r.pause : r.play} aria-label={r.playing ? 'Pause the replay' : 'Play the replay from here'}>
        {r.playing ? '❚❚ Pause' : '▶ Play'}
      </button>
      <label className="usage-dim">
        speed{' '}
        <select value={r.speed} onChange={e => r.setSpeed(Number(e.target.value))}>
          {REPLAY_SPEEDS.map(s => <option key={s} value={s}>{s}×</option>)}
        </select>
      </label>
      <input type="range" className="spawn-replay-range" min={span.start} max={Math.max(span.end, span.start + 1)} step={1000} value={at}
        onChange={e => r.seek(Number(e.target.value))} aria-label="Replay position" aria-valuetext={offsetLabel(at - span.start)} />
      <span className="spawn-replay-at" aria-live="off">{offsetLabel(at - span.start)} · {new Date(at).toLocaleTimeString()}</span>
      {r.t === null
        ? <span className="spawn-replay-live">● live</span>
        : <button type="button" className="btn-ghost" onClick={r.live}>Back to live</button>}
      {truncated && <span className="usage-dim" role="note">replays the oldest {limit ?? 'few thousand'} events only</span>}
    </div>
  );
}

function Legend() {
  return (
    <ul className="spawn-net-legend" aria-label="Legend">
      {(Object.keys(TONE_LABEL) as NetworkTone[]).map(t => (
        <li key={t}><span className={`spawn-net-swatch spawn-net-node--${t}`} aria-hidden="true" />{TONE_LABEL[t]}</li>
      ))}
      <li><span className="spawn-net-swatch spawn-net-swatch--orphan" aria-hidden="true" />○ orphaned</li>
      <li><svg width="26" height="8" aria-hidden="true"><path className="spawn-net-edge spawn-net-edge--adopted" d="M1,4 L25,4" /></svg>⇢ adopted by</li>
    </ul>
  );
}

function Totals({ view }: { view: SpawnTreeView }) {
  const t = view.totals;
  const states = Object.entries(t.states).sort((a, b) => b[1] - a[1]).map(([s, c]) => `${c} ${s.replace(/_/g, ' ')}`).join(' · ');
  return (
    <div className="dash-kpis">
      <div className="dash-tile"><div className="dash-tile-label">Agents</div><div className="dash-tile-value">{t.agents}{view.nodesTruncated ? '+' : ''}</div><div className="dash-tile-delta">{view.nodesTruncated ? 'the oldest shown and counted · ' : ''}{states}</div></div>
      <div className="dash-tile"><div className="dash-tile-label">At peak</div><div className="dash-tile-value">{t.peakRunning}</div><div className="dash-tile-delta">running at once</div></div>
      <div className="dash-tile"><div className="dash-tile-label">Tokens</div><div className="dash-tile-value">{fmtK(t.tokens)}</div><div className="dash-tile-delta">of which {fmtK(t.cacheRead)} cache reads</div></div>
      <div className="dash-tile"><div className="dash-tile-label">To last report</div><div className="dash-tile-value">{t.secondsToLastReport === null ? '—' : fmtDuration(t.secondsToLastReport)}</div><div className="dash-tile-delta">from the first spawn</div></div>
    </div>
  );
}

function Events({ view }: { view: SpawnTreeView }) {
  const [all, setAll] = useState(false);
  const names = new Map(view.nodes.map(n => [n.id, nodeLabel(n)]));
  const newest = [...view.events].reverse();
  const shown = all ? newest : newest.slice(0, SHOW_EVENTS);
  return (
    <section className="dash-section" aria-labelledby="spawn-events-h">
      <div className="dash-section-title" id="spawn-events-h">
        <span>Events</span>
        <span className="usage-dim">{view.events.length}{view.eventsTruncated ? '+ (the oldest are shown)' : ''}, newest first</span>
        {newest.length > SHOW_EVENTS && <button type="button" className="recents-link" onClick={() => setAll(a => !a)}>{all ? `Show newest ${SHOW_EVENTS}` : 'Show all'}</button>}
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table admin-table--dense spawn-table">
          <thead><tr><th>When</th><th>Agent</th><th>Event</th><th>Detail</th></tr></thead>
          <tbody>
            {shown.map((e, i) => (
              <tr key={`${e.at}:${i}`}>
                <td title={new Date(e.at).toLocaleString()}>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                <td>{(e.spawnId && names.get(e.spawnId)) ?? '—'}</td>
                <td>{e.kind.replace(/_/g, ' ')}</td>
                <td className="usage-dim">{e.reason?.replace(/_/g, ' ') ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function SpawnNetwork() {
  const { rootId = '', projectId, workstream } = useParams();
  const target: Target = projectId ? { kind: 'session', projectId, workstream: workstream ?? 'main' } : { kind: 'tree', rootId };
  // Keyed on what it shows, so a navigation to another tree starts with a fresh playhead.
  return <SpawnNetworkPage key={targetKey(target)} target={target} />;
}

function SpawnNetworkPage({ target }: { target: Target }) {
  const navigate = useNavigate();
  const { view, error, reload } = useTree(target);
  const [params, setParams] = useSearchParams();
  const radial = params.get('view') === 'radial';
  const replay = useReplay(view);
  const shown = useMemo(() => (view && replay.t !== null ? snapshotAt(view, replay.t) : view), [view, replay.t]);
  const lanes = useMemo(() => (view ? buildLanes(view, replay.span.end) : []), [view, replay.span.end]);
  const root = view?.nodes[0];
  const now = view ? Date.parse(view.at) : Date.now();
  const open = (n: SpawnNode) => { const to = childLink(n); if (to) navigate(to); };
  return (
    <div className="dash-root">
      <div className="dash-page spawn-net-page">
        <header className="dash-header">
          <h1>Spawn network</h1>
          <Link to="/dashboard">← dashboard</Link>
          <span className="dash-updated">{view ? `${replay.t === null ? 'live' : 'replaying'} · updated ${new Date(view.at).toLocaleTimeString()}` : ''}</span>
        </header>
        {error && <div className="spawn-error" role="alert">{error}</div>}
        {!view && !error && <div className="usage-dim">Loading…</div>}
        {view && root && (
          <>
            {view.scope === 'session' ? (
              <div className="spawn-net-root">
                <strong>{view.origin?.label ?? 'This session'}</strong>
                <span className="usage-dim">
                  {' '}· {view.rootsTruncated ? `the newest ${view.rootIds?.length ?? 0}` : view.rootIds?.length ?? 0} tree{view.rootIds?.length === 1 ? '' : 's'} it started in the last week (and any still running), the first {new Date(view.createdAt).toLocaleString()}
                </span>
              </div>
            ) : (
              <div className="spawn-net-root">
                {root && <ProviderBadge id={root.provider} />} <strong>{nodeLabel(root)}</strong>
                <span className="usage-dim"> · {firstLine(root.title)} · started {new Date(view.createdAt).toLocaleString()}{view.origin ? ` from ${view.origin.label}` : ''}</span>
                {view.origin?.projectId && (
                  <> · <Link to={sessionNetworkLink(view.origin.projectId, view.origin.workstream)}>every tree from {view.origin.label} ↗</Link></>
                )}
              </div>
            )}
            <Totals view={view} />
            <section className="dash-section" aria-labelledby="spawn-net-h">
              <div className="dash-section-title" id="spawn-net-h">
                <span>Network</span>
                <span className="spawn-net-toggle" role="group" aria-label="Layout">
                  <button type="button" className={`btn-ghost${radial ? '' : ' active'}`} aria-pressed={!radial} onClick={() => { params.delete('view'); setParams(params, { replace: true }); }}>Tidy</button>
                  <button type="button" className={`btn-ghost${radial ? ' active' : ''}`} aria-pressed={radial} onClick={() => { params.set('view', 'radial'); setParams(params, { replace: true }); }}>Radial</button>
                </span>
                <Legend />
              </div>
              <ReplayBar r={replay} truncated={view.eventsTruncated} limit={view.eventsLimit} />
              {shown && (radial ? <Radial full={view} view={shown} onOpen={open} /> : <Network full={view} view={shown} onOpen={open} />)}
            </section>
            <section className="dash-section" aria-labelledby="spawn-tl-h">
              <div className="dash-section-title" id="spawn-tl-h"><span>Timeline</span><span className="usage-dim">pane status over time; click to replay from there</span></div>
              <Timeline view={view} lanes={lanes} span={replay.span} t={replay.t ?? replay.span.end} onSeek={replay.seek} />
            </section>
            <section className="dash-section" aria-labelledby="spawn-nodes-h">
              <div className="dash-section-title" id="spawn-nodes-h"><span>Agents</span><span className="usage-dim">the same nodes as a table</span></div>
              <div className="admin-table-wrap">
                <table className="admin-table admin-table--dense spawn-table">
                  <thead><TreeHead /></thead>
                  <tbody className="spawn-tree">
                    {view.nodes.map(n => <TreeRow key={n.id} n={n} now={now} sessions={treeSessions(view)} onChanged={() => void reload()} />)}
                  </tbody>
                </table>
              </div>
            </section>
            <Events view={view} />
          </>
        )}
      </div>
    </div>
  );
}
