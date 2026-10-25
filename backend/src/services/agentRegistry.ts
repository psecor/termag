/**
 * Agent Registry
 *
 * Tracks connected user-agents. Two coexisting maps:
 *
 *   userAgents     — keyed by userId. Holds legacy per-user agents
 *                    (Mac via launchd, Linux host via systemd-user).
 *                    One per user; new connect kicks
 *                    the previous off. Backwards-compatible with all
 *                    pre-Instance code.
 *
 *   instanceAgents — keyed by instanceId. Holds the agent for a specific
 *                    AWS box (Instance row). Multiple per user, one per
 *                    instance. New connect kicks any previous agent for
 *                    the SAME instance, but does NOT touch the user's
 *                    legacy agent or other instances.
 *
 * `sendToAgent(userId, ...)` still works for callers that don't know
 * about boxes (anything pre-Task E). Per-instance routing is
 * `sendToInstanceAgent(instanceId, ...)`.
 */

import { WebSocket } from 'ws';
import { forgetBoxOwner, rememberBoxOwner } from './boxOwners';
import { hostSampleData } from './hostSamples';
import { Instance, User } from '@prisma/client';
import { prisma } from '../db';
import { reconstructUserSessions, reconstructInstanceSessions } from './agentRuntime';
import { parseAgentHello } from './agentHello';
import {
  AgentConnection,
  connectUpdate,
  parseAgentConnection,
  registryKeyOf,
  warmCompletionUpdate,
} from './instanceLifecycle';
import { describeOnWarmRun, onWarmRunUpdate, parseOnWarmReport, promotesToWarm } from './onWarmStatus';
import { deliverToInstance, CREDENTIALS_CAPABILITY } from './credentialDelivery';
import { onClaimRunUpdate, parseOnClaimReport } from './onClaimStatus';
import { syncBoxAuthorizedKeys } from './sshKeySync';
import { clearsPowerErrorOnConnect } from './boxPowerPolicy';
import { isTerminalReport, noteBoxActivity } from './boxActivity';


interface ConnectedAgent {
  ws: WebSocket;
  conn: AgentConnection;
  capabilities: string[];
  // From the hello (agentHello.ts); null until it arrives or from an older agent.
  agentCommit: string | null;
  agentCommitAt: Date | null;
  // Until the hello, empty capabilities mean "not said yet", not "can't".
  helloReceived: boolean;
  pendingRequests: Map<string, {
    resolve: (data: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>;
}

const userAgents = new Map<string, ConnectedAgent>();      // userId → agent (legacy)
const instanceAgents = new Map<string, ConnectedAgent>();  // instanceId → agent (V1+)

export interface ConnectedOwnedBox {
  instance: Instance;
  user: User;
  agentCommit: string | null;
  capabilities: string[];
}

/** What an owned box's agent said about itself on connect, for listeners outside this module. */
export interface BoxAgentHelloEvent extends ConnectedOwnedBox {
  /**
   * Resolves once the hello's host identity write and credential delivery
   * have finished, whether or not they succeeded: hostHome decides the
   * project dir, and the GitHub broker has to be in place before a clone.
   */
  settled: Promise<void>;
}

/** A frame an owned box's agent sent unprompted, with the box the socket is bound to. */
export interface BoxAgentFrame {
  instance: Instance;
  user: User;
  msg: Record<string, unknown>;
}

// Listeners on owned boxes' agents (services/boxUpdate, services/projectClone).
// Listeners rather than imports: those modules send through this one, and
// this module importing them back would be a cycle.
const boxHelloListeners = new Set<(ev: BoxAgentHelloEvent) => void>();
const boxFrameListeners = new Map<string, Set<(frame: BoxAgentFrame) => void>>();

/** Every agent hello, including a per-user agent and a warm box. Warm boxes have no user. */
export interface AgentHelloEvent {
  userId: string | null;
  instanceId: string | null;
  capabilities: readonly string[];
}

const agentHelloListeners = new Set<(ev: AgentHelloEvent) => void>();

function emitAgentHello(ev: AgentHelloEvent, label: string): void {
  for (const listener of agentHelloListeners) {
    try {
      listener(ev);
    } catch (err) {
      console.error(`[AGENT] a hello listener failed for ${label}:`, (err as Error).message);
    }
  }
}

/** Called after any agent's hello is recorded. Returns the unsubscribe. */
export function onAgentHello(listener: (ev: AgentHelloEvent) => void): () => void {
  agentHelloListeners.add(listener);
  return () => { agentHelloListeners.delete(listener); };
}

/** Called after an owned box's agent has said hello and its fields are recorded. Returns the unsubscribe. */
export function onBoxAgentHello(listener: (ev: BoxAgentHelloEvent) => void): () => void {
  boxHelloListeners.add(listener);
  return () => { boxHelloListeners.delete(listener); };
}

/** Called for each frame of this type from an owned box's agent. Returns the unsubscribe. */
export function onBoxAgentFrame(type: string, listener: (frame: BoxAgentFrame) => void): () => void {
  let listeners = boxFrameListeners.get(type);
  if (!listeners) boxFrameListeners.set(type, listeners = new Set());
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Terminal data subscribers: streamId → { callback, userId, instanceId }
type TerminalStream = { onData: (msg: any) => void; userId: string; instanceId: string | null };
const terminalStreams = new Map<string, TerminalStream>();

// Browser pane subscribers: streamId → { callback, holder }.
// A stream is bound to the agent socket that opened its browser: only that
// socket may feed it, and its close ends the stream, whether or not another
// agent has taken over the key by then (a box update does exactly that).
type BrowserStream = { onEvent: (msg: any) => void; agent: ConnectedAgent; instanceId: string | null };
const browserStreams = new Map<string, BrowserStream>();
// browser-blocked and browser-checkout come from guest panes only.
const BROWSER_STREAM_EVENTS: ReadonlySet<string> = new Set(['browser-frame', 'browser-nav', 'browser-exit', 'browser-blocked', 'browser-checkout', 'browser-dialog', 'browser-dialog-closed']);

let requestCounter = 0;

// A process draining for a deploy hands its agents to the new one. Their close
// here is not a disconnect: stamping agentDisconnectedAt could land after the
// new process recorded the reconnect, and the warm pool would read it as down.
let draining = false;

export function setAgentRegistryDraining(value: boolean): void {
  draining = value;
}

function nextRequestId(): string {
  return `req_${++requestCounter}_${Date.now()}`;
}

export function registerAgent(user: User | null, ws: WebSocket, instance: Instance | null): void {
  const conn = parseAgentConnection({ user, instance });
  if (!conn) {
    ws.close(1008, 'agent token must carry a user or an instance');
    return;
  }

  const { scope, key: targetKey, label } = registryKeyOf(conn);
  const targetMap = scope === 'instance' ? instanceAgents : userAgents;

  // Replace any existing agent for the SAME key. Other agents (e.g. the
  // user's Mac while we're connecting an instance) stay put.
  const existing = targetMap.get(targetKey);
  if (existing && existing.ws.readyState === WebSocket.OPEN) {
    existing.ws.close(1000, 'replaced by new agent');
  }

  const agent: ConnectedAgent = {
    ws,
    conn,
    capabilities: [],
    agentCommit: null,
    agentCommitAt: null,
    helloReceived: false,
    pendingRequests: new Map(),
  };
  targetMap.set(targetKey, agent);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      // Response to a pending request
      if (msg.requestId && agent.pendingRequests.has(msg.requestId)) {
        const pending = agent.pendingRequests.get(msg.requestId)!;
        clearTimeout(pending.timer);
        agent.pendingRequests.delete(msg.requestId);

        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.data);
        }
        return;
      }

      // Agent identifying itself on connect
      if (msg.type === 'hello') {
        const hello = parseAgentHello(msg);
        if (!hello) return;
        agent.capabilities = hello.capabilities;
        agent.agentCommit = hello.agentCommit;
        agent.agentCommitAt = hello.agentCommitAt;
        agent.helloReceived = true;
        console.log(
          `[AGENT] Hello: ${label} unixUser=${hello.unixUser} home=${hello.home} ` +
          `hostname=${hello.hostname ?? 'unknown'} agentVersion=${hello.agentVersion ?? 'unknown'} ` +
          `agentCommit=${hello.agentCommit?.slice(0, 12) ?? 'unknown'} warm=${hello.warm}` +
          (hello.capabilities.length ? ` capabilities=${hello.capabilities.join(',')}` : ''),
        );
        let credentials: Promise<void> = Promise.resolve();
        if (conn.kind === 'owned-box' && hello.capabilities.includes(CREDENTIALS_CAPABILITY)) {
          credentials = deliverToInstance(conn.instance.id, conn.user.id).catch(err => {
            console.error(`[CRED] delivery to ${label} failed:`, err.message);
          });
        }
        let hostIdentity: Promise<unknown> = Promise.resolve();
        // Only an instance-bound connection has a row to record this on; a
        // per-user token names no host, so there is nothing to write.
        if (instance) {
          hostIdentity = prisma.instance.update({
            where: { id: instance.id },
            data: { hostUnixUser: hello.unixUser, hostHome: hello.home, ...hostSampleData(hello.host) },
          }).catch(err => {
            console.error(`[AGENT] Failed to record host identity for instance ${instance.id}:`, err.message);
          });
          // Catches up a box that was offline when its owner's keys changed.
          if (instance.userId && instance.kind === 'ec2') {
            syncBoxAuthorizedKeys(instance.id, instance.userId, hello.home).catch(err => {
              console.error(`[SSH-KEYS] instance ${instance.name}: sync on connect failed:`, err.message);
            });
          }
          // The backend starts the warm run rather than cloud-init, so the
          // GitHub token this RPC carries once the on-warm scripts need one is
          // handed to a connected agent and never rides in user_data. Re-sent
          // on every reconnect while the box is still warming, which is how a
          // run interrupted by an agent restart resumes reporting; the agent's
          // start is idempotent.
          if (hello.warm && instance.status === 'warming') {
            console.log(`[POOL] instance ${instance.name} agent connected, starting the on-warm run`);
            sendToInstanceAgent(instance.id, 'on-warm-start', {}).catch(err => {
              // Not fatal to the socket. The stuck sweep fails a box whose warm
              // run never reports, and the next reconnect tries again.
              console.error(`[POOL] instance ${instance.name} on-warm-start failed:`, err.message);
            });
          }
        }
        if (conn.kind === 'owned-box') {
          // The worktime accumulator banks runner sessions under this owner (services/boxOwners.ts).
          rememberBoxOwner(conn.instance.id, conn.user.unixUsername);
          const event: BoxAgentHelloEvent = {
            instance: conn.instance, user: conn.user, agentCommit: hello.agentCommit, capabilities: hello.capabilities,
            settled: Promise.all([hostIdentity, credentials]).then(() => { settledOwnedConns.add(conn); }),
          };
          for (const listener of boxHelloListeners) {
            try {
              listener(event);
            } catch (err) {
              console.error(`[AGENT] a hello listener failed for ${label}:`, (err as Error).message);
            }
          }
        }
        // The live connection, not the one this socket registered with. A warm
        // box claimed in place is owned by the time a late hello arrives, and
        // that hello is what opens the chat gate.
        const live = agent.conn;
        emitAgentHello({
          userId: live.kind === 'warm-box' ? null : live.user.id,
          instanceId: live.kind === 'user-agent' ? null : live.instance.id,
          capabilities: hello.capabilities,
        }, label);
        return;
      }

      if (msg.type === 'on-warm-status') {
        // Only an instance-bound connection owns these columns; a per-user
        // token names no box to write them on.
        if (!instance) return;
        const report = parseOnWarmReport(msg);
        if (!report) {
          console.warn(`[POOL] instance ${instance.name} sent an unreadable on-warm status`);
          return;
        }
        console.log(`[POOL] instance ${instance.name} on-warm ${describeOnWarmRun(report)}`);
        // updateMany rather than update because the where clause is guarded on
        // `warming`, so a box the sweep already failed, or one terminated
        // mid-run, reports its last state into nothing instead of throwing or
        // rewriting a settled outcome.
        prisma.instance.updateMany(onWarmRunUpdate(instance.id, report))
          .then(() => promotesToWarm(report) ? markWarmIfComplete(instance.id) : undefined)
          .catch(err => {
            console.error(`[POOL] Failed to record on-warm status for instance ${instance.id}:`, err.message);
          });
        return;
      }

      if (msg.type === 'on-claim-status') {
        if (!instance) return;
        const report = parseOnClaimReport(msg);
        if (!report) {
          console.warn(`[CLAIM] instance ${instance.name} sent an unreadable on-claim status`);
          return;
        }
        console.log(`[CLAIM] instance ${instance.name} personalization ${report.state}`);
        prisma.instance.updateMany(onClaimRunUpdate(instance.id, report)).catch(err => {
          console.error(`[CLAIM] Failed to record on-claim status for instance ${instance.id}:`, err.message);
        });
        return;
      }

      // Streaming terminal data from agent
      if (msg.type === 'terminal-data' && msg.streamId) {
        const stream = terminalStreams.get(msg.streamId);
        // Stream ids are guessable, so only the agent that holds a stream may feed it.
        if (stream && streamAgent(stream) === agent) {
          stream.onData(msg);
        } else {
          // Nobody here reads this stream, e.g. the agent spawned it after the
          // attach RPC timed out. Only the backend knows that, so it closes it.
          ws.send(JSON.stringify({ type: 'terminal-close', streamId: msg.streamId }));
        }
        return;
      }

      // A browser pane's frames, navigation and exit.
      if (typeof msg.type === 'string' && BROWSER_STREAM_EVENTS.has(msg.type) && msg.streamId) {
        const stream = browserStreams.get(msg.streamId);
        if (stream && stream.agent === agent) {
          if (msg.type === 'browser-exit') browserStreams.delete(msg.streamId);
          stream.onEvent(msg);
        } else if (msg.type !== 'browser-exit') {
          // Nobody here reads this stream (the viewer left while the attach
          // was in flight); only the backend knows that, so it closes it.
          ws.send(JSON.stringify({ type: 'browser-close', streamId: msg.streamId }));
        }
        return;
      }

      const frameListeners = typeof msg.type === 'string' ? boxFrameListeners.get(msg.type) : undefined;
      // agent.conn rather than conn: a warm box claimed while connected is owned without a reconnect.
      const owner = agent.conn;
      if (frameListeners && owner.kind === 'owned-box') {
        for (const listener of frameListeners) {
          try {
            listener({ instance: owner.instance, user: owner.user, msg });
          } catch (err) {
            console.error(`[AGENT] a ${msg.type} listener failed for ${label}:`, (err as Error).message);
          }
        }
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    // The browsers died with this socket; tell their viewers now rather than
    // leaving a frozen last frame until they close the pane. This runs for a
    // replaced socket too: its replacement holds the key by now, but not
    // these browsers, so the guard below must not skip it.
    for (const [streamId, stream] of browserStreams) {
      if (stream.agent !== agent) continue;
      browserStreams.delete(streamId);
      try {
        stream.onEvent({ type: 'browser-exit', streamId, reason: 'agent disconnected' });
      } catch (err) {
        console.error(`[BROWSER-PANE] exit listener failed for ${streamId}:`, (err as Error).message);
      }
    }
    // Only remove if this is still the current agent for the key. Without
    // that guard a replaced socket's close would stamp over the live agent.
    if (targetMap.get(targetKey)?.ws === ws) {
      for (const [, pending] of agent.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Agent disconnected'));
      }
      targetMap.delete(targetKey);
      if (conn.kind !== 'user-agent' && !draining) {
        prisma.instance.update({
          where: { id: conn.instance.id },
          data: { agentDisconnectedAt: new Date() },
        }).catch(err => {
          console.error(`[AGENT] Failed to stamp disconnect for instance ${conn.instance.id}:`, err.message);
        });
      }
      console.log(`[AGENT] Disconnected: ${label}`);
    }
  });

  console.log(`[AGENT] Connected: ${label}`);

  if (conn.kind !== 'user-agent') {
    const box = conn.instance;
    const connectedAt = new Date();
    // Fire-and-forget; the connection is good regardless of whether these DB
    // writes land. Their order is load-bearing at both steps. The guarded
    // readyAt write has to land before the status flip clears its own
    // `provisioning` predicate, and that guard is what keeps the cold baseline
    // honest: it skips boxes that were already ready before the column
    // existed, external boxes whose agent the orchestrator never launched, and
    // pool boxes, whose equivalent measurement is warmedAt. The promotion then
    // has to follow the connect update rather than race it, because
    // connectUpdate's status comes from the row as read at auth time and would
    // write a stale "warming" back over a promotion that already landed. Every
    // write runs after the map insert, so the liveness lookup inside
    // markWarmIfComplete sees this socket.
    prisma.instance.updateMany({
      where: { id: box.id, status: 'provisioning', readyAt: null },
      data: { readyAt: connectedAt },
    }).then(() => prisma.instance.updateMany(connectUpdate(box, connectedAt)))
      .then(applied => {
        if (applied.count === 0) {
          // The status moved under us, so its write was declined. The agent is
          // still connected, and the pool's liveness predicate reads this column
          // against agentDisconnectedAt, so it is recorded either way.
          return prisma.instance.updateMany({
            where: { id: box.id },
            data: { lastConnectedAt: connectedAt },
          });
        }
        if (!clearsPowerErrorOnConnect(box.status)) return undefined;
        return prisma.instance.updateMany({
          where: { id: box.id, status: 'ready' },
          data: { provisioningError: null },
        });
      })
      .then(() => markWarmIfComplete(box.id)).catch(err => {
      console.error(`[AGENT] Failed to record connect for instance ${box.id}:`, err.message);
    });
  }

  switch (conn.kind) {
    case 'user-agent': {
      const owner = conn.user;
      // Legacy per-user: reconstruct tmux sessions after a short delay.
      // Fire-and-forget.
      setTimeout(() => {
        reconstructUserSessions(owner.id, owner.unixUsername).catch(err => {
          console.error(`[AGENT] Session reconstruction failed for ${owner.unixUsername}:`, err.message);
        });
      }, 2000);
      break;
    }
    case 'owned-box': {
      const { user: owner, instance: box } = conn;
      // Reconstruct only this instance's projects so a box-reboot can
      // reattach Claude/cursor/devin sessions without touching projects
      // that live on other agents (e.g. the user's Mac).
      setTimeout(() => {
        reconstructInstanceSessions(box.id, owner.id, owner.unixUsername).catch(err => {
          console.error(`[AGENT] Instance reconstruction failed for ${box.name}:`, err.message);
        });
      }, 2000);
      break;
    }
    case 'warm-box':
      // No owner and no projects yet; reconstruction happens when the claim
      // path assigns an owner.
      break;
    default: {
      const unreachable: never = conn;
      return unreachable;
    }
  }
}

/**
 * Promote a warming box to warm once both halves have landed: its agent is
 * connected and its on-warm run succeeded. Safe to call from either side, in
 * either order, any number of times — the guards live in the where clause.
 */
export async function markWarmIfComplete(instanceId: string): Promise<void> {
  const update = warmCompletionUpdate(instanceId, isInstanceAgentConnected(instanceId), new Date());
  if (!update) return;
  await prisma.instance.updateMany(update);
}

/**
 * Give a connected warm box's agent an owner, in place.
 *
 * A pool box registers as `{kind: 'warm-box'}` with nobody attached, and the
 * claim makes it somebody's. Rewriting the connection here is what lets
 * `sendForProject`, status routing and `getConnectedAgents` work on the box
 * the moment the claim returns, instead of after a reconnect picks the owner
 * up from the token. The registry key does not change: it was already the
 * instance id, which the claim does not touch.
 *
 * Returns an undo, or null when no live agent holds this instance.
 */
export function rebindInstanceOwner(instance: Instance, user: User): (() => void) | null {
  // A warm box claimed while its agent stays connected gets no new hello: the worktime accumulator learns its owner here.
  // The chat gate is not told here. A failed claim undoes this rebind, and a sweep started now would open the gate on an abandoned box.
  rememberBoxOwner(instance.id, user.unixUsername);
  const agent = getInstanceAgent(instance.id);
  if (!agent) return null;
  const previous = agent.conn;
  const owned: AgentConnection = { kind: 'owned-box', user, instance };
  agent.conn = owned;
  // Undo for a claim whose RPC failed: the row goes back to ownerless, so the
  // socket must too, or getConnectedAgents keeps listing the box as the
  // claimer's. A no-op once anything else has rebound or replaced the agent.
  return () => {
    if (instanceAgents.get(instance.id) === agent && agent.conn === owned) agent.conn = previous;
  };
}

// Owned-box connections whose credential delivery has finished, by connection
// object, so a rebind or a redial starts unsettled: the hello marks its own,
// and a claim marks the connection it rebound (settleClaimedOwner).
const settledOwnedConns = new WeakSet<AgentConnection>();

/** Whether the agent holding this instance is owned and its owner's credential delivery has finished. */
export function instanceAgentSettled(instanceId: string): boolean {
  const agent = instanceAgents.get(instanceId);
  return !!agent && agent.conn.kind === 'owned-box' && settledOwnedConns.has(agent.conn);
}

/**
 * A claim's credential delivery has finished on the connection
 * rebindInstanceOwner built for `instance`. A no-op once anything else has
 * rebound or replaced the agent: a redial is settled by its own hello.
 */
export function settleClaimedOwner(instance: Instance): void {
  const agent = instanceAgents.get(instance.id);
  if (agent && agent.conn.kind === 'owned-box' && agent.conn.instance === instance) settledOwnedConns.add(agent.conn);
}

/**
 * A warm box claimed in place gets no second hello. Re-fire the hello
 * listeners with the owner the socket now has, so the chat sweep can open
 * the recover gate. Only after the claim has stuck: see rebindInstanceOwner.
 */
export function notifyInstanceClaimed(instanceId: string): void {
  const agent = getInstanceAgent(instanceId);
  if (!agent || agent.conn.kind !== 'owned-box') return;
  emitAgentHello({
    userId: agent.conn.user.id,
    instanceId,
    capabilities: agent.capabilities,
  }, agent.conn.instance.name);
}

/**
 * Take the owner off whatever agent holds this instance now, as a redial with
 * its now-ownerless token would. For a claim that is abandoned after its row
 * reverted: the rebind's own undo only covers the socket it rebound, and the
 * box may have redialled with the claimer's token while the RPC was in flight.
 */
export function disownInstanceAgent(instanceId: string): void {
  forgetBoxOwner(instanceId);
  const agent = instanceAgents.get(instanceId);
  if (agent && agent.conn.kind === 'owned-box') {
    agent.conn = { kind: 'warm-box', instance: agent.conn.instance };
  }
}

/**
 * Close a box's agent socket from this end. For a hibernating box: a hibernate
 * freezes the agent with its socket, which can come back still established on
 * resume, and an agent that never redials never moves its box from `starting`
 * to `ready`. Closed here, the agent finds it dead on its first heartbeat after
 * waking and dials in again. Nothing pings agents from this side, so without
 * this a hibernated box would also keep reading as connected.
 */
export function dropInstanceAgent(instanceId: string, reason: string): boolean {
  const agent = instanceAgents.get(instanceId);
  if (!agent) return false;
  console.log(`[AGENT] Dropping instance ${instanceId}'s socket: ${reason}`);
  agent.ws.terminate();
  return true;
}

/** Instances whose agent socket this process holds open right now. */
export function connectedInstanceIds(): string[] {
  const ids: string[] = [];
  for (const [id, agent] of instanceAgents) {
    if (agent.ws.readyState === WebSocket.OPEN) ids.push(id);
  }
  return ids;
}

/**
 * Every host that has a live agent socket right now, in ProjectHost shape:
 * owned boxes (their owner's id is what project discovery needs; ownerless
 * warm boxes have nothing to discover yet) and legacy per-user agents as
 * `{instanceId: null}`. Saves callers a project-list query just to find out
 * which hosts even have agents (the review sweep's quiet ticks).
 */
export function connectedProjectHosts(): ProjectHost[] {
  const out: ProjectHost[] = [];
  for (const [id, agent] of instanceAgents) {
    if (agent.ws.readyState === WebSocket.OPEN && agent.conn.kind === 'owned-box') {
      out.push({ userId: agent.conn.user.id, instanceId: id });
    }
  }
  for (const [userId, agent] of userAgents) {
    if (agent.ws.readyState === WebSocket.OPEN) out.push({ userId, instanceId: null });
  }
  return out;
}

export function getAgent(userId: string): ConnectedAgent | null {
  const agent = userAgents.get(userId);
  if (!agent || agent.ws.readyState !== WebSocket.OPEN) return null;
  return agent;
}

export function getInstanceAgent(instanceId: string): ConnectedAgent | null {
  const agent = instanceAgents.get(instanceId);
  if (!agent || agent.ws.readyState !== WebSocket.OPEN) return null;
  return agent;
}

/** The agent holding a stream's PTY or browser: the project's box agent, or the owner's legacy agent. */
function streamAgent(stream: { userId: string; instanceId: string | null }): ConnectedAgent | null {
  return stream.instanceId ? getInstanceAgent(stream.instanceId) : getAgent(stream.userId);
}

/** Who a box's agent is, what it can do, and the commit it runs: for credential delivery, box updates and clones. */
export function instanceAgentTransport(instanceId: string): {
  conn: AgentConnection; capabilities: string[]; agentCommit: string | null; agentCommitAt: Date | null; helloReceived: boolean;
} | null {
  const agent = getInstanceAgent(instanceId);
  return agent
    ? { conn: agent.conn, capabilities: agent.capabilities, agentCommit: agent.agentCommit, agentCommitAt: agent.agentCommitAt, helloReceived: agent.helloReceived }
    : null;
}

/** Every connected agent of a box somebody owns, with what its hello said: for the box-update sweep. */
export function connectedOwnedBoxes(): ConnectedOwnedBox[] {
  const out: ConnectedOwnedBox[] = [];
  for (const a of instanceAgents.values()) {
    if (a.conn.kind !== 'owned-box' || a.ws.readyState !== WebSocket.OPEN) continue;
    out.push({ instance: a.conn.instance, user: a.conn.user, agentCommit: a.agentCommit, capabilities: a.capabilities });
  }
  return out;
}

/** The connected boxes this user owns. */
export function connectedOwnedBoxIds(userId: string): string[] {
  const out: string[] = [];
  for (const [instanceId, a] of instanceAgents) {
    if (a.conn.kind === 'owned-box' && a.conn.user.id === userId && a.ws.readyState === WebSocket.OPEN) out.push(instanceId);
  }
  return out;
}

export function isAgentConnected(userId: string): boolean {
  return getAgent(userId) !== null;
}

export function isInstanceAgentConnected(instanceId: string): boolean {
  return getInstanceAgent(instanceId) !== null;
}

function sendOnAgent(agent: ConnectedAgent, type: string, payload: Record<string, unknown>, timeoutMs: number): Promise<any> {
  const requestId = nextRequestId();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      agent.pendingRequests.delete(requestId);
      reject(new Error(`Agent request timed out: ${type}`));
    }, timeoutMs);

    agent.pendingRequests.set(requestId, { resolve, reject, timer });
    agent.ws.send(JSON.stringify({ requestId, type, ...payload }));
  });
}

/**
 * Send a request to a user's legacy agent.
 */
export function sendToAgent(userId: string, type: string, payload: Record<string, unknown> = {}, timeoutMs: number = 10000): Promise<any> {
  const agent = getAgent(userId);
  if (!agent) return Promise.reject(new Error('Agent not connected'));
  return sendOnAgent(agent, type, payload, timeoutMs);
}

/**
 * Send a request to a specific instance's agent (AWS box).
 */
export function sendToInstanceAgent(instanceId: string, type: string, payload: Record<string, unknown> = {}, timeoutMs: number = 10000): Promise<any> {
  const agent = getInstanceAgent(instanceId);
  if (!agent) return Promise.reject(new Error('Instance agent not connected'));
  return sendOnAgent(agent, type, payload, timeoutMs);
}

/**
 * Project-keyed routing: sends to the project's box if it lives on one,
 * else to the user's legacy agent. The two predicates below pair with it.
 */
export type ProjectHost = { userId: string; instanceId: string | null };

/** What the agent serving a project said it can do in its hello; empty when none is connected. */
export function projectAgentCapabilities(project: ProjectHost): string[] {
  const agent = project.instanceId ? getInstanceAgent(project.instanceId) : getAgent(project.userId);
  return agent?.capabilities ?? [];
}

export function isProjectAgentConnected(project: ProjectHost): boolean {
  return project.instanceId
    ? isInstanceAgentConnected(project.instanceId)
    : isAgentConnected(project.userId);
}

export function sendForProject(
  project: ProjectHost,
  type: string,
  payload: Record<string, unknown> = {},
  timeoutMs: number = 10000,
): Promise<any> {
  return project.instanceId
    ? sendToInstanceAgent(project.instanceId, type, payload, timeoutMs)
    : sendToAgent(project.userId, type, payload, timeoutMs);
}

/**
 * Request a terminal stream from the user's legacy agent.
 */
export async function requestTerminalStream(
  userId: string,
  tmuxSessionName: string,
  cols: number,
  rows: number,
  onData: (msg: any) => void,
): Promise<string> {
  const streamId = `stream_${nextRequestId()}`;
  terminalStreams.set(streamId, { onData, userId, instanceId: null });

  try {
    await sendToAgent(userId, 'terminal-attach', { tmuxSessionName, streamId, cols, rows });
    return streamId;
  } catch (err) {
    terminalStreams.delete(streamId);
    throw err;
  }
}

/**
 * Request a terminal stream from a specific instance's agent.
 */
export async function requestInstanceTerminalStream(
  instanceId: string,
  user: Pick<User, 'id'>,
  tmuxSessionName: string,
  cols: number,
  rows: number,
  onData: (msg: any) => void,
): Promise<string> {
  const streamId = `stream_${nextRequestId()}`;
  terminalStreams.set(streamId, { onData, userId: user.id, instanceId });

  try {
    await sendToInstanceAgent(instanceId, 'terminal-attach', { tmuxSessionName, streamId, cols, rows });
    return streamId;
  } catch (err) {
    terminalStreams.delete(streamId);
    throw err;
  }
}

function sendToStreamAgent(streamId: string, msg: Record<string, unknown>): void {
  const stream = terminalStreams.get(streamId);
  const agent = stream && streamAgent(stream);
  if (!agent) return;
  agent.ws.send(JSON.stringify({ ...msg, streamId }));
}

export function sendTerminalInput(streamId: string, data: string): void {
  if (!isTerminalReport(data)) noteBoxActivity(terminalStreams.get(streamId)?.instanceId);
  sendToStreamAgent(streamId, { type: 'terminal-input', data });
}

export function sendTerminalPasteImage(streamId: string, data: string): void {
  noteBoxActivity(terminalStreams.get(streamId)?.instanceId);
  sendToStreamAgent(streamId, { type: 'terminal-paste-image', data });
}

export function sendTerminalResize(streamId: string, cols: number, rows: number): void {
  sendToStreamAgent(streamId, { type: 'terminal-resize', cols, rows });
}

export function sendTerminalMouse(streamId: string, enabled: boolean): void {
  sendToStreamAgent(streamId, { type: 'terminal-mouse', enabled });
}

export function closeTerminalStream(streamId: string): void {
  sendToStreamAgent(streamId, { type: 'terminal-close' });
  terminalStreams.delete(streamId);
}

/**
 * Ask the project's agent to open a browser pane and
 * subscribe to its frames. Resolves to the stream id once the agent has the
 * browser up (Chromium takes about a second to start, hence the longer wait).
 */
/**
 * What `browser-attach` carries (agent/browser-pane.js attach). A guest pane
 * adds its mode, the share's recipe, the workstream's
 * checkout, the pool size, the share's expiry and the link's `at` path.
 */
export interface BrowserAttachOptions {
  url: string;
  width: number;
  height: number;
  paneKey: string;
  persistProfile?: boolean;
  mode?: 'guest';
  recipe?: unknown;
  cwd?: string;
  maxGuestPanes?: number;
  profileExpiresAt?: string;
  atPath?: string;
  /** An owner's own share link: the share's recipe, which the agent resolves to open `atPath` on the share's app. */
  openRecipe?: unknown;
  /** The viewer's pane can answer a page's alert, confirm or prompt; otherwise the agent answers them, as before. */
  relayDialogs?: boolean;
}

export async function requestBrowserStream(
  host: ProjectHost,
  opts: BrowserAttachOptions,
  onEvent: (msg: any) => void,
): Promise<string> {
  // Bound to the socket that is asked, not to whoever holds the key later.
  const agent = streamAgent(host);
  if (!agent) throw new Error('Agent not connected');
  const streamId = `browser_${nextRequestId()}`;
  browserStreams.set(streamId, { onEvent, agent, instanceId: host.instanceId });
  try {
    await sendOnAgent(agent, 'browser-attach', { streamId, ...opts }, 20000);
    return streamId;
  } catch (err) {
    browserStreams.delete(streamId);
    throw err;
  }
}

/** What a viewer does to the browser that counts as using the box, like typing in a terminal. */
const BROWSER_ACTIVITY: ReadonlySet<unknown> = new Set(['browser-input', 'browser-navigate', 'browser-history', 'browser-dialog-answer']);

/** Relay a viewer's frame (input, navigate, history, resize) to the agent holding the stream. */
export function sendBrowserMessage(streamId: string, msg: Record<string, unknown>): void {
  const stream = browserStreams.get(streamId);
  if (!stream || stream.agent.ws.readyState !== WebSocket.OPEN) return;
  if (BROWSER_ACTIVITY.has(msg.type)) noteBoxActivity(stream.instanceId);
  stream.agent.ws.send(JSON.stringify({ ...msg, streamId }));
}

export function closeBrowserStream(streamId: string): void {
  sendBrowserMessage(streamId, { type: 'browser-close' });
  browserStreams.delete(streamId);
}

/** Ask the project's agent which web apps listen on the box. */
export function requestBrowserSuggestions(host: ProjectHost, cwd: string | null): Promise<unknown> {
  return sendForProject(host, 'browser-suggest', { cwd }, 15000);
}

/**
 * Connected agents — for diagnostics. Includes both legacy and instance-bound.
 *
 * Ownerless warm-pool agents are skipped rather than widening userId to null.
 * The only consumers are the per-user token-usage sampler and the usage route,
 * both of which key everything by user; a warm box has nobody to attribute
 * usage to, and a null would reach `tokenUsageSampler.runUserScan`, which
 * reads `hosts[0].unixUsername` as a path root.
 */
export function getConnectedAgents(): Array<{ userId: string; unixUsername: string; instanceId: string | null }> {
  const out: Array<{ userId: string; unixUsername: string; instanceId: string | null }> = [];
  for (const a of userAgents.values()) {
    if (a.conn.kind !== 'user-agent') continue;
    out.push({ userId: a.conn.user.id, unixUsername: a.conn.user.unixUsername, instanceId: null });
  }
  for (const a of instanceAgents.values()) {
    if (a.conn.kind !== 'owned-box') continue;
    out.push({ userId: a.conn.user.id, unixUsername: a.conn.user.unixUsername, instanceId: a.conn.instance.id });
  }
  return out;
}

/**
 * Every connected agent that has said hello, as a software-inventory host: a box by its instance id, a per-user agent on
 * the orchestrator as `agent:<userId>`.
 */
export interface InventoryHost {
  hostKey: string;
  hostKind: 'box' | 'agent';
  instanceId: string | null;
  userId: string | null;
  capabilities: string[];
  agentCommit: string | null;
  agentCommitAt: Date | null;
}
export function inventoryHosts(): InventoryHost[] {
  const out: InventoryHost[] = [];
  for (const a of userAgents.values()) {
    if (a.conn.kind !== 'user-agent' || !a.helloReceived || a.ws.readyState !== WebSocket.OPEN) continue;
    out.push({ hostKey: `agent:${a.conn.user.id}`, hostKind: 'agent', instanceId: null, userId: a.conn.user.id, capabilities: [...a.capabilities], agentCommit: a.agentCommit, agentCommitAt: a.agentCommitAt });
  }
  for (const [instanceId, a] of instanceAgents) {
    if (!a.helloReceived || a.ws.readyState !== WebSocket.OPEN) continue;
    const userId = a.conn.kind === 'owned-box' ? a.conn.user.id : null;
    out.push({ hostKey: instanceId, hostKind: 'box', instanceId, userId, capabilities: [...a.capabilities], agentCommit: a.agentCommit, agentCommitAt: a.agentCommitAt });
  }
  return out;
}
