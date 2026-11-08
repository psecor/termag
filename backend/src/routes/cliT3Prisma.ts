/**
 * CliT3 (routes/cliT3.ts) over the database, the agent registry and the
 * tunnel registry (services/agentTunnels.ts): who may reach which box, and the
 * agent RPCs behind each route (agent/t3-bridge.js).
 */
import { posix } from 'path';
import { prisma } from '../db';
import { instanceAgentTransport, sendToInstanceAgent } from '../services/agentRegistry';
import { PARKED_STATUSES } from '../services/boxPowerPolicy';
import type { CliUser } from '../services/cliStore';
import { prismaCliStore } from '../services/cliStorePrisma';
import { T3_CAPABILITY } from '../services/desktopAppFlag';
import { fireworksModelsForBox } from '../services/fireworksFlag';
import { FIREWORKS_CAPABILITY, getFireworksGatewayConfig, type FireworksModels } from '../services/fireworksGateway';
import { TunnelError, type AgentTunnels } from '../services/agentTunnels';
import type { CliT3, T3Access } from './cliT3';

/** `t3-revoke`, and a labeled `t3-pair` revoking what an earlier pair of its label left. */
export const T3_REVOKE_CAPABILITY = 't3-revoke-v1';
/** `t3-update`: only where the box's agent runs termag's installed t3 server. */
export const T3_UPDATE_CAPABILITY = 't3-update-v1';
const ENSURE_TIMEOUT_MS = 30_000;
// The agent's installer bound (5 min, a ~100 MB release download through the
// GitHub broker), its --version check and the restart's wait.
const UPDATE_TIMEOUT_MS = 7 * 60_000;
// A labeled pair reads the box's t3 sessions beside the create, then revokes
// the stale ones: a few t3 CLI runs, each some seconds.
const PAIR_TIMEOUT_MS = 120_000;
const REVOKE_TIMEOUT_MS = 120_000;
const PATHS_TIMEOUT_MS = 10_000;
/** `space-sync`: the box runs `termag space sync` (agent/space-sync.js). */
export const SPACE_SYNC_CAPABILITY = 'space-sync-v1';
// A first copy of a large space downloads every file; later ones only what changed.
const SPACE_SYNC_TIMEOUT_MS = 180_000;

const NOT_FOUND: T3Access = { ok: false, status: 404, error: 'No such box', code: 'not_found' };

interface T3CliDeps {
  tunnels: AgentTunnels;
  /** Overridable for tests. */
  send?: typeof sendToInstanceAgent;
  transport?: typeof instanceAgentTransport;
  /** The Fireworks models a box's owner may call on it (services/fireworksFlag.ts). */
  fireworks?: (userId: string, boxId: string) => Promise<FireworksModels | null>;
  /** Whether this orchestrator routes Fireworks (FIREWORKS_GATEWAY_URL). */
  fireworksGateway?: () => boolean;
}

function failure(status: number, code: string, error: string) {
  return { status, body: { error, code } };
}

function agentError(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

export function createPrismaCliT3(deps: T3CliDeps): CliT3 {
  const send = deps.send ?? sendToInstanceAgent;
  const transport = deps.transport ?? instanceAgentTransport;

  async function access(user: CliUser, boxId: string): Promise<T3Access> {
    const box = await prisma.instance.findFirst({
      where: { id: boxId, userId: user.id },
      select: { id: true, name: true, kind: true, status: true },
    });
    if (!box || box.status === 'terminated') return NOT_FOUND;
    if ((PARKED_STATUSES as readonly string[]).includes(box.status)) {
      return { ok: false, status: 409, error: `The box is ${box.status}; start it first`, code: 'box_not_ready', parked: box.status };
    }
    const agent = transport(box.id);
    if (box.status !== 'ready' || !agent || !agent.helloReceived) {
      return { ok: false, status: 409, error: "The box isn't ready or its agent isn't connected", code: 'box_not_ready' };
    }
    if (!agent.capabilities.includes(T3_CAPABILITY)) {
      return { ok: false, status: 501, error: 'This box needs an update (no t3 server on it)', code: 'box_outdated' };
    }
    return { ok: true };
  }

  async function guarded(user: CliUser, boxId: string, run: () => Promise<{ status: number; body: unknown }>) {
    const a = await access(user, boxId);
    if (!a.ok) return failure(a.status, a.code, a.error);
    return run();
  }

  /**
   * t3-ensure's `fireworks` (agent/t3-bridge.js): the models the owner may
   * call on this box, so its t3 server gets a Fireworks instance with all of
   * them, or null to take it away.
   * Nothing where the box can't take Fireworks or the flags are unreadable:
   * the box then keeps what it has.
   */
  async function fireworksFor(userId: string, boxId: string): Promise<{ fireworks?: unknown }> {
    if (!(deps.fireworksGateway ?? (() => getFireworksGatewayConfig() !== null))()) return {};
    if (!transport(boxId)?.capabilities.includes(FIREWORKS_CAPABILITY)) return {};
    try {
      const fw = await (deps.fireworks ?? fireworksModelsForBox)(userId, boxId);
      return { fireworks: fw ? { models: fw.models.map(m => ({ id: m.id, context: m.context })), defaultModel: fw.defaultModel } : null };
    } catch (err) {
      console.warn(`[T3] fireworks flags for box ${boxId} unreadable: ${(err as Error).message}`);
      return {};
    }
  }

  async function ensureOn(boxId: string, userId: string) {
    // The box's name labels its t3 environment in the desktop app.
    const box = await prisma.instance.findUnique({ where: { id: boxId }, select: { name: true } });
    const payload = { ...(box ? { label: box.name } : {}), ...(await fireworksFor(userId, boxId)) };
    return await send(boxId, 't3-ensure', payload, ENSURE_TIMEOUT_MS) as { state: string; port: number; version: string | null; home: string };
  }

  return {
    access,

    ensure: (user, boxId) => guarded(user, boxId, async () => {
      try {
        const r = await ensureOn(boxId, user.id);
        return { status: 200, body: { state: r.state === 'ready' ? 'ready' : 'starting', version: r.version ?? null, home: r.home } };
      } catch (err) {
        return failure(502, 't3_failed', `The box could not start its t3 server: ${agentError(err)}`);
      }
    }),

    update: (user, boxId, version) => guarded(user, boxId, async () => {
      const agent = transport(boxId);
      if (!agent) return failure(409, 'box_not_ready', "The box's agent isn't connected");
      if (!agent.capabilities.includes(T3_UPDATE_CAPABILITY)) {
        return failure(501, 'box_outdated', "This box can't update its t3 server (an older agent, or a t3 of the owner's own)");
      }
      const box = await prisma.instance.findUnique({ where: { id: boxId }, select: { name: true } });
      try {
        const r = await send(boxId, 't3-update', { version, ...(box ? { label: box.name } : {}) }, UPDATE_TIMEOUT_MS) as { state: string; version: string | null; home: string };
        return { status: 200, body: { state: r.state === 'ready' ? 'ready' : 'starting', version: r.version ?? null, home: r.home } };
      } catch (err) {
        return failure(502, 't3_failed', `The box could not update its t3 server: ${agentError(err)}`);
      }
    }),

    pair: (user, boxId, label) => guarded(user, boxId, async () => {
      try {
        const r = await send(boxId, 't3-pair', label === undefined ? {} : { label }, PAIR_TIMEOUT_MS) as { credential: string; expiresAt: string | null };
        return { status: 200, body: { credential: r.credential, expiresAt: r.expiresAt } };
      } catch (err) {
        return failure(502, 't3_failed', `The box could not mint a pairing credential: ${agentError(err)}`);
      }
    }),

    revoke: (user, boxId, label) => guarded(user, boxId, async () => {
      // Read again after access(): the agent may have dropped in between.
      const agent = transport(boxId);
      if (!agent) return failure(409, 'box_not_ready', "The box's agent isn't connected");
      if (!agent.capabilities.includes(T3_REVOKE_CAPABILITY)) {
        return failure(501, 'box_outdated', "This box needs an update to revoke its t3 sessions");
      }
      try {
        const r = await send(boxId, 't3-revoke', { label }, REVOKE_TIMEOUT_MS) as { sessions?: number; pairings?: number } | null;
        return { status: 200, body: { revoked: { sessions: r?.sessions ?? 0, pairings: r?.pairings ?? 0 } } };
      } catch (err) {
        return failure(502, 't3_failed', `The box could not revoke its t3 sessions: ${agentError(err)}`);
      }
    }),

    projects: (user, boxId) => guarded(user, boxId, async () => {
      // An automation's project is the scheduler's, not one to open in t3: a
      // t3 automation's runs are already threads of its T3 task's own project.
      const automations = new Set((await prisma.project.findMany({
        where: { userId: user.id, instanceId: boxId, kind: 'automation' },
        select: { id: true },
      })).map(p => p.id));
      const mine = (await prismaCliStore.listProjects(user.id)).filter(p => p.box.id === boxId && !automations.has(p.id));
      if (mine.length === 0) return { status: 200, body: { projects: [] } };
      let seen: Array<{ path: string | null; exists: boolean }>;
      try {
        seen = await send(boxId, 't3-paths', { paths: mine.map(p => p.directory) }, PATHS_TIMEOUT_MS) as typeof seen;
      } catch (err) {
        return failure(502, 't3_failed', `The box could not resolve its project directories: ${agentError(err)}`);
      }
      return {
        status: 200,
        body: {
          projects: mine.map((p, i) => ({
            id: p.id,
            name: p.name,
            // Normalized: a box's HOME can carry a doubled slash (macOS TMPDIR
            // ends in one), and t3 matches a project by its exact root.
            directory: posix.normalize(seen[i]?.path ?? p.directory),
            exists: seen[i]?.exists ?? false,
            workstreams: p.workstreams,
            // Whether the checkout is done: the
            // directory can be there while a clone is still moving into it.
            clone: p.clone,
          })),
        },
      };
    }),

    spaceSync: (user, boxId, space) => guarded(user, boxId, async () => {
      // Read again after access(): the agent may have dropped in between.
      const agent = transport(boxId);
      if (!agent) return failure(409, 'box_not_ready', "The box's agent isn't connected");
      if (!agent.capabilities.includes(SPACE_SYNC_CAPABILITY)) {
        return failure(501, 'box_outdated', 'This box needs an update to copy its spaces');
      }
      try {
        return { status: 200, body: await send(boxId, 'space-sync', space === undefined ? {} : { space }, SPACE_SYNC_TIMEOUT_MS) };
      } catch (err) {
        return failure(502, 'space_sync_failed', `The box could not copy its spaces: ${agentError(err)}`);
      }
    }),

    async openTunnel(user, boxId) {
      try {
        return await deps.tunnels.openTunnel(boxId, user.id);
      } catch (err) {
        if (!(err instanceof TunnelError) || err.code !== 't3_not_running') throw err;
      }
      // Not running (a box restart, or nobody called ensure yet): start it once and retry.
      let state: string;
      try {
        state = (await ensureOn(boxId, user.id)).state;
      } catch (err) {
        throw new TunnelError(502, 't3_failed', `The box could not start its t3 server: ${agentError(err)}`);
      }
      if (state !== 'ready') throw new TunnelError(503, 't3_starting', "The box's t3 server is starting; try again shortly");
      return deps.tunnels.openTunnel(boxId, user.id);
    },
  };
}
