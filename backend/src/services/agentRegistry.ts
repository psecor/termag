/**
 * Agent Registry
 *
 * Tracks connected user-agents. Two coexisting maps:
 *
 *   userAgents     — keyed by userId. Holds legacy per-user agents (the
 *                    user's Mac running launchd, the secorp.net host's
 *                    systemd-user agent). One per user; new connect kicks
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
import { Instance, PrismaClient, User } from '@prisma/client';
import { reconstructUserSessions } from './agentRuntime';

const prisma = new PrismaClient();

interface ConnectedAgent {
  ws: WebSocket;
  user: User;
  instanceId: string | null;
  pendingRequests: Map<string, {
    resolve: (data: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>;
}

const userAgents = new Map<string, ConnectedAgent>();      // userId → agent (legacy)
const instanceAgents = new Map<string, ConnectedAgent>();  // instanceId → agent (V1+)

// Terminal data subscribers: streamId → { callback, userId, instanceId }
const terminalStreams = new Map<string, { onData: (msg: any) => void; userId: string; instanceId: string | null }>();

let requestCounter = 0;

function nextRequestId(): string {
  return `req_${++requestCounter}_${Date.now()}`;
}

export function registerAgent(user: User, ws: WebSocket, instance: Instance | null): void {
  const targetMap = instance ? instanceAgents : userAgents;
  const targetKey = instance ? instance.id : user.id;
  const label = instance ? `instance ${instance.name}` : user.unixUsername;

  // Replace any existing agent for the SAME key. Other agents (e.g. the
  // user's Mac while we're connecting an instance) stay put.
  const existing = targetMap.get(targetKey);
  if (existing && existing.ws.readyState === WebSocket.OPEN) {
    existing.ws.close(1000, 'replaced by new agent');
  }

  const agent: ConnectedAgent = {
    ws,
    user,
    instanceId: instance?.id ?? null,
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

      // Streaming terminal data from agent
      if (msg.type === 'terminal-data' && msg.streamId) {
        const stream = terminalStreams.get(msg.streamId);
        if (stream) stream.onData(msg);
        return;
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close', () => {
    // Only remove if this is still the current agent for the key.
    if (targetMap.get(targetKey)?.ws === ws) {
      for (const [, pending] of agent.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Agent disconnected'));
      }
      targetMap.delete(targetKey);
      console.log(`[AGENT] Disconnected: ${label}`);
    }
  });

  console.log(`[AGENT] Connected: ${label}`);

  if (instance) {
    // Mark Instance ready + bump lastConnectedAt. Fire-and-forget; the
    // connection is good regardless of whether this DB write lands.
    prisma.instance.update({
      where: { id: instance.id },
      data: { status: 'ready', lastConnectedAt: new Date() },
    }).catch(err => {
      console.error(`[AGENT] Failed to mark instance ${instance.id} ready:`, err.message);
    });
    // Reconstruction-on-reconnect for instance-bound agents is a Task E
    // follow-up — needs to filter projects by instanceId.
  } else {
    // Legacy per-user: reconstruct tmux sessions after a short delay.
    // Fire-and-forget.
    setTimeout(() => {
      reconstructUserSessions(user.id, user.unixUsername).catch(err => {
        console.error(`[AGENT] Session reconstruction failed for ${user.unixUsername}:`, err.message);
      });
    }, 2000);
  }
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
 * Send a request to a user's legacy agent (Mac / secorp.net).
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
  user: User,
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

export function sendTerminalInput(userId: string, streamId: string, data: string): void {
  const stream = terminalStreams.get(streamId);
  if (!stream) return;
  const agent = stream.instanceId ? getInstanceAgent(stream.instanceId) : getAgent(userId);
  if (!agent) return;
  agent.ws.send(JSON.stringify({ type: 'terminal-input', streamId, data }));
}

export function sendTerminalResize(userId: string, streamId: string, cols: number, rows: number): void {
  const stream = terminalStreams.get(streamId);
  if (!stream) return;
  const agent = stream.instanceId ? getInstanceAgent(stream.instanceId) : getAgent(userId);
  if (!agent) return;
  agent.ws.send(JSON.stringify({ type: 'terminal-resize', streamId, cols, rows }));
}

export function sendTerminalMouse(userId: string, streamId: string, enabled: boolean): void {
  const stream = terminalStreams.get(streamId);
  if (!stream) return;
  const agent = stream.instanceId ? getInstanceAgent(stream.instanceId) : getAgent(userId);
  if (!agent) return;
  agent.ws.send(JSON.stringify({ type: 'terminal-mouse', streamId, enabled }));
}

export function closeTerminalStream(streamId: string): void {
  const stream = terminalStreams.get(streamId);
  terminalStreams.delete(streamId);
  if (!stream) return;

  const agent = stream.instanceId ? getInstanceAgent(stream.instanceId) : getAgent(stream.userId);
  if (agent) {
    agent.ws.send(JSON.stringify({ type: 'terminal-close', streamId }));
  }
}

/**
 * Connected agents — for diagnostics. Includes both legacy and instance-bound.
 */
export function getConnectedAgents(): Array<{ userId: string; unixUsername: string; instanceId: string | null }> {
  const out: Array<{ userId: string; unixUsername: string; instanceId: string | null }> = [];
  for (const a of userAgents.values()) {
    out.push({ userId: a.user.id, unixUsername: a.user.unixUsername, instanceId: null });
  }
  for (const a of instanceAgents.values()) {
    out.push({ userId: a.user.id, unixUsername: a.user.unixUsername, instanceId: a.instanceId });
  }
  return out;
}
