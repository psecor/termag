import { spawn } from 'node:child_process';
import { Box, useApp, useInput, useWindowSize } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TermagApi } from '../api.js';
import { runRemoteAttach } from '../attach.js';
import type { TuiConfig } from '../config.js';
import { saveLastTarget } from '../config.js';
import { connectionState, type Contact } from '../connection.js';
import {
  buildRows, findRowIndex, lobbyCounts, hopIndex, indexSessions, inferLocalInstance, isSelectable, nextIndex, rowStatusKey, selectionOf, sessionFor, targetSession,
  updateFlashes, waitingIndices, type FlashState, type Row, type Selection, type SessionMap,
} from '../model.js';
import { BELL, notificationSequence } from '../notify.js';
import { lobbyPills, prCount, workstreamKey, type Pill, type PrsResponse } from '../prs.js';
import { StatusSocket, applyStatusFrame, type SocketState } from '../statusSocket.js';
import { bindReturnKey, currentSession, insideTmux, listLocalSessions, switchClient } from '../tmux.js';
import type { AgentStatusValue, Project, Role, Whoami } from '../types.js';
import { Header, Help, Hints, Message, Peek, ProjectList, Prompt } from './components.js';

const SESSIONS_POLL_MS = 2_500;
const PROJECTS_POLL_MS = 10_000;
const LOCAL_TMUX_POLL_MS = 5_000;
// The capture route is rate-limited to 1/s per session server-side.
const PEEK_POLL_MS = 1_500;
// The backend memoizes the PR pipeline for a minute per user.
const PRS_POLL_MS = 60_000;
// The CLI API has no send-keys; a handoff (H) is the one session action, and the server types it.
const SEND_DISABLED_HINT = 'sending is off in the TUI for now: attach to type (enter / c)';

type Mode = 'list' | 'filter' | 'help' | 'handoff';
type PeekRole = Extract<Role, 'agent' | 'ctrl'>;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g;
function cleanLines(content: string): string[] {
  return content.replace(ANSI_RE, '').replace(/\r/g, '').split('\n').map(l => l.replace(/\t/g, '    '));
}

export function App({ config }: { config: TuiConfig }) {
  const api = useMemo(() => new TermagApi(config.url, config.token, config.refresh), [config.url, config.token, config.refresh]);
  const { exit, suspendTerminal } = useApp();
  const { columns, rows: termRows } = useWindowSize();
  const inTmux = insideTmux();

  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<SessionMap>({});
  const [localSessions, setLocalSessions] = useState<Set<string>>(new Set());
  const [contact, setContact] = useState<Contact>({ lastOkAt: null, consecutiveFailures: 0 });
  const [identity, setIdentity] = useState<Whoami | null>(null);
  const [socketState, setSocketState] = useState<SocketState>('closed');
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<Mode>('list');
  const [selected, setSelected] = useState<Selection | null>(config.lastTarget ?? null);
  const [peekRole, setPeekRole] = useState<PeekRole>('agent');
  const [peek, setPeek] = useState<{ session: string; lines: string[]; error: string | null; at: number } | null>(null);
  const [message, setMessage] = useState<{ text: string; kind: 'info' | 'error' }>({ text: '', kind: 'info' });
  const [flashUntil, setFlashUntil] = useState<FlashState['flashUntil']>({});
  const [returnKeyActive, setReturnKeyActive] = useState(false);
  const [prs, setPrs] = useState<PrsResponse | null>(null);
  const [, setTick] = useState(0);
  const scrollRef = useRef(0);
  const flashRef = useRef<FlashState>({ prev: {}, flashUntil: {} });
  const mountedAt = useRef(Date.now());

  const me = useMemo(() => {
    if (identity?.user.unixUsername) return identity.user.unixUsername;
    const own = Object.values(sessions).find(s => s.access === 'owner');
    if (own) return own.owner;
    return projects.find(p => p.role === 'owner')?.ownerUsername ?? '';
  }, [identity, sessions, projects]);

  const say = useCallback((text: string, kind: 'info' | 'error' = 'info') => setMessage({ text, kind }), []);

  // ── polling ──────────────────────────────────────────────────────────────
  const ok = useCallback(() => setContact({ lastOkAt: Date.now(), consecutiveFailures: 0 }), []);
  const fail = useCallback((err: unknown) => {
    setContact(c => ({ ...c, consecutiveFailures: c.consecutiveFailures + 1 }));
    say(err instanceof Error ? err.message : String(err), 'error');
  }, [say]);

  const refreshSessions = useCallback(async () => {
    try { setSessions(indexSessions(await api.listSessions())); ok(); } catch (e) { fail(e); }
  }, [api, ok, fail]);
  const refreshProjects = useCallback(async () => {
    try { setProjects(await api.listProjects()); ok(); } catch (e) { fail(e); }
  }, [api, ok, fail]);
  const refreshLocal = useCallback(async () => { setLocalSessions(await listLocalSessions()); }, []);
  const refreshAll = useCallback(() => { void refreshProjects(); void refreshSessions(); void refreshLocal(); }, [refreshProjects, refreshSessions, refreshLocal]);

  useEffect(() => {
    refreshAll();
    api.whoami().then(setIdentity).catch(() => setIdentity(null));
    const a = setInterval(() => void refreshSessions(), SESSIONS_POLL_MS);
    const b = setInterval(() => void refreshProjects(), PROJECTS_POLL_MS);
    const c = setInterval(() => void refreshLocal(), LOCAL_TMUX_POLL_MS);
    const t = setInterval(() => setTick(n => n + 1), 1000);
    return () => { clearInterval(a); clearInterval(b); clearInterval(c); clearInterval(t); };
  }, [api, refreshAll, refreshProjects, refreshSessions, refreshLocal]);

  // PR pills: only a device sign-in may read the PR list (a box credential
  // gets 403), so a box's TUI shows none until `termag login`.
  const deviceSignIn = identity?.credential.kind === 'device';
  useEffect(() => {
    if (!deviceSignIn) { setPrs(null); return; }
    let stopped = false;
    const load = () => api.listPrs().then(r => { if (!stopped) setPrs(r); }).catch(() => { /* keep the last list; the lobby is not about PRs */ });
    load();
    const t = setInterval(load, PRS_POLL_MS);
    return () => { stopped = true; clearInterval(t); };
  }, [api, deviceSignIn]);
  const pillsByWs = useMemo(() => lobbyPills(prs, Date.now()), [prs]);
  const pillsFor = useCallback((projectId: string, ws: string): Pill[] => pillsByWs.get(workstreamKey(projectId, ws)) ?? [], [pillsByWs]);

  // Live status push on the CLI's status socket. Polling alone carries the
  // lobby when the server has no such socket yet or refuses the credential.
  useEffect(() => {
    const sock = new StatusSocket(api.wsUrl('status'), () => api.accessToken(), {
      onFrame: (f) => { if (f.type === 'status') setSessions(m => applyStatusFrame(m, f)); },
      onState: setSocketState,
    });
    sock.start();
    return () => sock.stop();
  }, [api]);

  // One-time: give the user a way back when attach switches the tmux client away.
  useEffect(() => {
    if (!inTmux || !config.returnKey) return;
    const cur = currentSession();
    if (!cur) return;
    const r = bindReturnKey(config.returnKey, cur);
    setReturnKeyActive(r === 'bound');
    if (r === 'occupied') say(`prefix+${config.returnKey} is already bound in your tmux; set "returnKey" in ~/.config/termag/tui.json to another key`, 'error');
  }, [inTmux, config.returnKey, say]);

  // ── derived rows / cursor ────────────────────────────────────────────────
  const rows = useMemo(() => buildRows(projects, sessions, { filter, localSessions, me }), [projects, sessions, filter, localSessions, me]);
  const localInstance = useMemo(() => inferLocalInstance(Object.values(sessions), localSessions), [sessions, localSessions]);
  let cursor = findRowIndex(rows, selected);
  if (cursor < 0) cursor = rows.findIndex(isSelectable);
  const selectedRow = cursor >= 0 ? rows[cursor] : null;
  // A workstream row's pills, and a project row's when it has only the one workstream (as the web sidebar).
  const rowPills = useCallback((row: Row): Pill[] => {
    if (row.kind === 'workstream') return pillsFor(row.project.id, row.workstream.name);
    if (row.kind === 'project' && row.workstreamCount <= 1) return pillsFor(row.project.id, row.target.workstream);
    return [];
  }, [pillsFor]);

  // Keep `selected` pointing at a real row once data arrives.
  useEffect(() => {
    if (selectedRow && isSelectable(selectedRow)) {
      const t = selectionOf(selectedRow);
      if (!selected || selected.projectId !== t.projectId || selected.workstream !== t.workstream || selected.kind !== t.kind) setSelected(t);
    }
  }, [selectedRow, selected]);

  // Transition flashes + bell + desktop notification.
  useEffect(() => {
    const current: Record<string, AgentStatusValue | null> = {};
    for (const r of rows) { const k = rowStatusKey(r); if (k && r.kind !== 'group') current[k] = r.status; }
    const now = Date.now();
    const u = updateFlashes(flashRef.current, current, now, mountedAt.current);
    flashRef.current = u.next;
    setFlashUntil(u.next.flashUntil);
    if (u.nowWaiting.length) {
      // Bell always; a desktop notification when the terminal honours OSC 777/9
      // (inside tmux this needs `allow-passthrough on`). Names come from the rows.
      const names = u.nowWaiting.map(k => {
        const r = rows.find(x => rowStatusKey(x) === k);
        return r && r.kind !== 'group' ? (r.kind === 'workstream' ? `${r.project.name}/${r.workstream.name}` : r.project.name) : k;
      });
      process.stdout.write(BELL + (config.notify ? notificationSequence('termag', `${names.join(', ')} waiting for you`) : ''));
    }
  }, [rows, config.notify]);

  const flashing = useCallback((row: Row): AgentStatusValue | null => {
    const k = rowStatusKey(row);
    if (!k) return null;
    const f = flashUntil[k];
    return f && f.until > Date.now() ? f.status : null;
  }, [flashUntil]);

  const move = useCallback((dir: 1 | -1, count = 1) => {
    let i = cursor;
    for (let n = 0; n < count; n++) {
      let j = i + dir;
      while (j >= 0 && j < rows.length && !isSelectable(rows[j])) j += dir;
      if (j < 0 || j >= rows.length) break;
      i = j;
    }
    const r = rows[i];
    if (r && isSelectable(r)) setSelected(selectionOf(r));
  }, [cursor, rows]);

  const jumpTo = useCallback((i: number | null) => {
    if (i == null) { say('nothing is waiting'); return; }
    const r = rows[i];
    if (r && isSelectable(r)) setSelected(selectionOf(r));
  }, [rows, say]);

  // ── peek ─────────────────────────────────────────────────────────────────
  const listWidth = Math.min(Math.max(34, Math.floor(columns * 0.42)), 64);
  const peekWidth = Math.max(20, columns - listWidth);
  const bodyHeight = Math.max(5, termRows - 3);
  const peekLines = Math.max(1, bodyHeight - 3);

  const peekTarget = selectedRow && isSelectable(selectedRow) ? selectedRow.target : null;
  const peekSession = peekTarget ? targetSession(peekTarget, peekRole, me) : null;
  const peekSessionRow = peekTarget ? sessionFor(sessions, peekTarget.project, peekTarget.workstream, peekRole) : undefined;
  // The poll loop reads the current pane height through a ref so a resize
  // changes the next request without restarting the interval.
  const peekLinesRef = useRef(peekLines);
  peekLinesRef.current = peekLines;

  useEffect(() => {
    if (!peekTarget || !peekSession) { setPeek(null); return; }
    let cancelled = false;
    const { project, workstream } = peekTarget;
    const run = async () => {
      try {
        const r = await api.capture(project.id, peekRole, workstream, Math.min(1000, peekLinesRef.current + 5));
        if (!cancelled) setPeek({ session: peekSession, lines: cleanLines(r.content ?? ''), error: null, at: Date.now() });
      } catch (e) {
        if (!cancelled) setPeek(prev => ({ session: peekSession, lines: prev?.session === peekSession ? prev.lines : [], error: e instanceof Error ? e.message : String(e), at: prev?.at ?? 0 }));
      }
    };
    void run();
    const h = setInterval(() => void run(), PEEK_POLL_MS);
    return () => { cancelled = true; clearInterval(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, peekTarget?.project.id, peekTarget?.workstream, peekRole, peekSession]);

  // ── attach ──────────────────────────────────────────────────────────────
  const attach = useCallback(async (role: PeekRole) => {
    if (!selectedRow || !isSelectable(selectedRow)) return;
    const name = targetSession(selectedRow.target, role, me);
    saveLastTarget({ projectId: selectedRow.project.id, workstream: selectedRow.target.workstream });
    // Session names carry owner + project but not box, so "a session with this
    // name exists here" is not enough: the same project name on another box
    // would land in THIS box's session. Local attach only on positive evidence
    // the project is here; everything else goes through the CLI's terminal
    // socket to the owning box's agent.
    const projectInstance = selectedRow.project.instanceId ?? null;
    const elsewhere = localInstance !== undefined && projectInstance !== localInstance;
    const isLocal = !elsewhere && localSessions.has(name);
    if (!isLocal) {
      // Remote: hand the terminal over, hopping between sessions on the prefix
      // chord until the user detaches. Rows are a snapshot from attach time.
      let hopRow = selectedRow;
      let hopRole: PeekRole = role;
      let outcome: Awaited<ReturnType<typeof runRemoteAttach>> | null = null;
      await suspendTerminal(async () => {
        for (;;) {
          const t = hopRow.target;
          const from = rows.indexOf(hopRow);
          outcome = await runRemoteAttach({
            api, prefix: config.prefix,
            target: {
              session: targetSession(t, hopRole, me), projectId: t.project.id, projectName: t.project.name,
              workstream: t.workstream, role: hopRole, instanceId: t.project.instanceId ?? null,
            },
            // n / p move by project; at either end the attach stays up and the bell rings.
            canHop: (d) => hopIndex(rows, from, d === 'next' ? 1 : -1) >= 0,
          });
          if (outcome.kind === 'flip') { hopRole = hopRole === 'agent' ? 'ctrl' : 'agent'; continue; }
          if (outcome.kind === 'next' || outcome.kind === 'prev') {
            const r = rows[hopIndex(rows, from, outcome.kind === 'next' ? 1 : -1)];
            if (r && isSelectable(r)) hopRow = r;
            continue;
          }
          break;
        }
      });
      setSelected(selectionOf(hopRow));
      setPeekRole(hopRole);
      const o = outcome as Awaited<ReturnType<typeof runRemoteAttach>> | null;
      if (o?.kind === 'error') say(o.message, 'error');
      else if (o?.kind === 'ended') say(o.message);
      else say(`detached from ${targetSession(hopRow.target, hopRole, me)}`);
      refreshAll();
      return;
    }
    if (inTmux) {
      try {
        await switchClient(name);
        say(`switched to ${name}${returnKeyActive ? ` · prefix+${config.returnKey} returns here` : ''}`);
      } catch (e) { say(e instanceof Error ? e.message : String(e), 'error'); }
      return;
    }
    await suspendTerminal(() => new Promise<void>((resolve) => {
      const child = spawn('tmux', ['attach-session', '-t', name], { stdio: 'inherit' });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    }));
    say(`detached from ${name}`);
    void refreshSessions();
  }, [selectedRow, rows, me, localSessions, localInstance, inTmux, config.prefix, config.returnKey, returnKeyActive, say, suspendTerminal, refreshSessions, refreshAll, api]);

  // ── keys ─────────────────────────────────────────────────────────────────
  useInput((input, key) => {
    if (mode === 'help') { setMode('list'); return; }
    if (input === 'q') { exit(); return; }
    if (input === '?') { setMode('help'); return; }
    if (input === 'j' || key.downArrow) { move(1); return; }
    if (input === 'k' || key.upArrow) { move(-1); return; }
    if (key.pageDown) { move(1, Math.max(1, bodyHeight - 2)); return; }
    if (key.pageUp) { move(-1, Math.max(1, bodyHeight - 2)); return; }
    if (input === 'g') { jumpTo(rows.findIndex(isSelectable)); return; }
    if (input === 'G') { for (let i = rows.length - 1; i >= 0; i--) if (isSelectable(rows[i])) { jumpTo(i); break; } return; }
    if (key.return) { void attach('agent'); return; }
    if (input === 'c') { void attach('ctrl'); return; }
    if (key.tab) { setPeekRole(r => (r === 'agent' ? 'ctrl' : 'agent')); return; }
    if (input === 'w') { jumpTo(nextIndex(waitingIndices(rows), cursor, 1)); return; }
    if (input === 'W') { jumpTo(nextIndex(waitingIndices(rows), cursor, -1)); return; }
    if (input === 's') { say(SEND_DISABLED_HINT); return; }
    if (input === 'H') {
      if (!selectedRow || !isSelectable(selectedRow)) return;
      if (selectedRow.project.role === 'collaborator') { say('only the owner can hand this agent off', 'error'); return; }
      setMode('handoff');
      say(`hand off ${targetSession(selectedRow.target, 'agent', me)}? y clear & read back in · r restart · any other key cancels`);
      return;
    }
    if (input === 'o') {
      const top = selectedRow ? rowPills(selectedRow)[0] : undefined;
      if (top?.url) say(`${top.label} ${top.url}`);
      else if (!deviceSignIn) say('pull requests need a device sign-in: run `termag login`');
      else say('no pull request for this row');
      return;
    }
    if (input === '/') { setDraft(filter); setMode('filter'); return; }
    if (input === 'R') { refreshAll(); say('refreshed'); return; }
    if (key.escape && filter) { setFilter(''); say('filter cleared'); }
  }, { isActive: mode === 'list' || mode === 'help' });

  // ── hand off (H) ─────────────────────────────────────────────────────────
  // One key confirms: the agent writes a handoff first, so nothing is lost,
  // but the pane is then reset, which is worth a second keystroke.
  const handOff = useCallback(async (handoffMode: 'clear' | 'restart') => {
    if (!selectedRow || !isSelectable(selectedRow)) return;
    const t = selectedRow.target;
    try {
      const r = await api.handOff(t.project.id, t.workstream, handoffMode);
      say(`handing off ${targetSession(t, 'agent', me)} (${r.handoff.mode}): the agent writes a handoff when its turn ends${r.note ? ` · ${r.note}` : ''}`);
    } catch (e) { say(e instanceof Error ? e.message : String(e), 'error'); }
  }, [selectedRow, api, me, say]);

  useInput((input, key) => {
    setMode('list');
    if (input === 'y' || key.return) { void handOff('clear'); return; }
    if (input === 'r') { void handOff('restart'); return; }
    say('hand off cancelled');
  }, { isActive: mode === 'handoff' });

  // ── render ───────────────────────────────────────────────────────────────
  // Keep the cursor inside the visible window.
  const listHeight = bodyHeight;
  if (cursor >= 0) {
    if (cursor < scrollRef.current) scrollRef.current = Math.max(0, cursor - 1);
    if (cursor >= scrollRef.current + listHeight) scrollRef.current = cursor - listHeight + 1;
  }
  scrollRef.current = Math.min(scrollRef.current, Math.max(0, rows.length - listHeight));

  const conn = connectionState(contact, Date.now());
  const { working, waiting, reviewing } = lobbyCounts(rows, sessions);
  const prsNeedingYou = prs?.connected ? prCount(prs, Date.now()) : null;

  const peekTitle = peekSession ?? '';
  const peekSubtitle = peekSessionRow
    ? `${peekRole} · ${peekSessionRow.alive ? 'live' : 'not running'}${peekSessionRow.connected ? '' : ' · agent OFFLINE'}${peekSessionRow.contextTokens != null ? ` · ctx ${Math.round(peekSessionRow.contextTokens / 1000)}K` : ''}${peekSessionRow.rateLimited ? ' · RATE LIMITED' : ''}`
    : peekTarget ? `${peekRole} · no session row` : '';

  // How status arrives: pushed over the socket, or by poll alone.
  const pushLabel = socketState === 'open' ? 'push' : socketState === 'connecting' ? 'push…' : 'poll';

  return (
    <Box flexDirection="column" width={columns} height={termRows}>
      <Header me={me} source={`${config.source} · ${pushLabel}`} conn={conn} working={working} waiting={waiting} reviewing={reviewing} prs={prsNeedingYou} width={columns} />
      {mode === 'help' ? (
        <Help width={columns} height={bodyHeight} inTmux={inTmux} returnKey={config.returnKey} prefix={config.prefix} />
      ) : (
        <Box flexDirection="row" height={bodyHeight}>
          <ProjectList rows={rows} cursor={cursor} scroll={scrollRef.current} height={listHeight} width={listWidth} flashing={flashing} pills={rowPills} />
          <Peek
            title={peekTitle}
            subtitle={peekSubtitle}
            status={peekSessionRow?.status ?? (peekTarget ? 'not_running' : null)}
            lines={peek?.session === peekSession ? peek.lines : []}
            error={peek?.session === peekSession ? peek.error : null}
            ageMs={peek?.session === peekSession && peek.at ? Date.now() - peek.at : null}
            width={peekWidth}
            height={bodyHeight}
          />
        </Box>
      )}
      <Hints inTmux={inTmux} returnKey={returnKeyActive ? config.returnKey : null} width={columns} />
      {mode === 'filter' ? (
        <Prompt label="filter:" value={draft} width={columns}
          onChange={(v) => { setDraft(v); setFilter(v); }}
          onSubmit={() => setMode('list')}
          onCancel={() => { setFilter(''); setMode('list'); }} />
      ) : (
        <Message text={message.text || (projects.length ? '' : 'loading…')} kind={message.kind} width={columns} />
      )}
    </Box>
  );
}
