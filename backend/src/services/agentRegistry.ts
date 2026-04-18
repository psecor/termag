/**
 * Agent Registry
 *
 * Tracks connected user-agents. Each user can have one active agent.
 * The agent handles tmux, mkdir, git, and PTY operations on behalf of the user.
 */

import { WebSocket } from 'ws';
import { User } from '@prisma/client';

interface ConnectedAgent {
  ws: WebSocket;
  user: User;
  pendingRequests: Map<string, {
    resolve: (data: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }>;
}

// userId → connected agent
const agents = new Map<string, ConnectedAgent>();

// Terminal data subscribers: streamId → { callback, userId }
const terminalStreams = new Map<string, { onData: (msg: any) => void; userId: string }>();

let requestCounter = 0;

function nextRequestId(): string {
  return `req_${++requestCounter}_${Date.now()}`;
}

export function registerAgent(user: User, ws: WebSocket): void {
  // Close existing agent for this user if any
  const existing = agents.get(user.id);
  if (existing && existing.ws.readyState === WebSocket.OPEN) {
    existing.ws.close(1000, 'replaced by new agent');
  }

  const agent: ConnectedAgent = { ws, user, pendingRequests: new Map() };
  agents.set(user.id, agent);

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
    // Only remove if this is still the current agent for this user
    if (agents.get(user.id)?.ws === ws) {
      // Reject all pending requests
      for (const [, pending] of agent.pendingRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Agent disconnected'));
      }
      agents.delete(user.id);
      console.log(`[AGENT] Disconnected: ${user.unixUsername}`);
    }
  });

  console.log(`[AGENT] Connected: ${user.unixUsername}`);
}

export function getAgent(userId: string): ConnectedAgent | null {
  const agent = agents.get(userId);
  if (!agent || agent.ws.readyState !== WebSocket.OPEN) return null;
  return agent;
}

export function isAgentConnected(userId: string): boolean {
  return getAgent(userId) !== null;
}

/**
 * Send a request to a user's agent and wait for a response.
 */
export function sendToAgent(userId: string, type: string, payload: Record<string, unknown> = {}, timeoutMs: number = 10000): Promise<any> {
  const agent = getAgent(userId);
  if (!agent) return Promise.reject(new Error('Agent not connected'));

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
 * Request the agent to create a terminal stream (PTY attached to tmux).
 * Returns a streamId that the agent will use to send terminal data.
 */
export async function requestTerminalStream(
  userId: string,
  tmuxSessionName: string,
  cols: number,
  rows: number,
  onData: (msg: any) => void,
): Promise<string> {
  const streamId = `stream_${nextRequestId()}`;
  terminalStreams.set(streamId, { onData, userId });

  try {
    await sendToAgent(userId, 'terminal-attach', { tmuxSessionName, streamId, cols, rows });
    return streamId;
  } catch (err) {
    terminalStreams.delete(streamId);
    throw err;
  }
}

/**
 * Send input to a terminal stream on the agent.
 */
export function sendTerminalInput(userId: string, streamId: string, data: string): void {
  const agent = getAgent(userId);
  if (!agent) return;
  agent.ws.send(JSON.stringify({ type: 'terminal-input', streamId, data }));
}

/**
 * Send a resize to a terminal stream on the agent.
 */
export function sendTerminalResize(userId: string, streamId: string, cols: number, rows: number): void {
  const agent = getAgent(userId);
  if (!agent) return;
  agent.ws.send(JSON.stringify({ type: 'terminal-resize', streamId, cols, rows }));
}

/**
 * Send a mouse toggle to a terminal stream on the agent.
 */
export function sendTerminalMouse(userId: string, streamId: string, enabled: boolean): void {
  const agent = getAgent(userId);
  if (!agent) return;
  agent.ws.send(JSON.stringify({ type: 'terminal-mouse', streamId, enabled }));
}

/**
 * Close a terminal stream — removes the handler and tells the agent to kill the PTY.
 */
export function closeTerminalStream(streamId: string): void {
  const stream = terminalStreams.get(streamId);
  terminalStreams.delete(streamId);

  if (stream) {
    const agent = getAgent(stream.userId);
    if (agent) {
      agent.ws.send(JSON.stringify({ type: 'terminal-close', streamId }));
    }
  }
}

/**
 * Get status of all connected agents.
 */
export function getConnectedAgents(): Array<{ userId: string; unixUsername: string }> {
  return Array.from(agents.values()).map(a => ({
    userId: a.user.id,
    unixUsername: a.user.unixUsername,
  }));
}
