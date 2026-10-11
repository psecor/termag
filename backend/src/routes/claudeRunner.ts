/**
 * POST /internal/claude-runner/spawn — start a one-shot Claude Code self-hosted
 * runner on the session owner's box.
 *
 * Caller: deploy/claude-spawn-runner, run by the Claude Code orchestrator
 * on this host, against the backend's own port (the nginx gateway 404s every
 * /termag/internal/ path, deliberately). Trust: loopback peer (isLocalPeer,
 * same as status writes) AND a bearer token cloud-init
 * generates under /srv/termag/secrets and hands to both sides. Mounted only
 * when CLAUDE_RUNNER_SPAWN_TOKEN is set, so a host without the orchestrator
 * 404s the path.
 *
 * Responses map onto the hook's exit-code contract:
 *   202  started (or 200: this order is already running; idempotent on orderId)
 *   400  malformed body                         -> hook exit 2 (non-retryable)
 *   404  email is not a termag user             -> hook exit 2; the body carries
 *        code OWNER_NOT_FOUND so the hook can tell it from an unmounted route
 *        (a plain 404, retried like a 401: configuration, not the session)
 *   503  owner has not connected GitHub (broker hosts), has no ready box whose
 *        agent can run a runner, or every such box already runs
 *        MAX_RUNNERS_PER_BOX sessions, or this process is draining for a
 *        deploy (its box agents are leaving)    -> hook exit 1 (retryable)
 *   502  a box agent failed an RPC             -> hook exit 1
 *
 * Every outcome is logged once, as `[CLAUDE-RUNNER] order <id> for
 * <unixUsername> ...`: once the termag.service journal is shipped to a log
 * store, who starts sessions and how often they are refused is
 * a query over these lines. The owner's username, never the email; the hook's
 * own stderr names neither, since it lands in the session's Activity tab.
 *
 * Each session gets a slot (DEV_INSTANCE 2..) that names its checkout and tmux
 * session on the box. The runner is that session's only process, so the box's
 * live tmux sessions are the truth about which slots are taken, after a
 * backend restart too (services/claudeRunnerSpawn.ts).
 */
import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { isLocalPeer } from '../auth/peerAddress';
import { asyncHandler } from '../middleware/errors';
import { instanceAgentTransport, isInstanceAgentConnected, sendToInstanceAgent } from '../services/agentRegistry';
import { getCredentialStoreConfig, githubStoreDeps } from '../services/credentialStore';
import { getGithubBrokerUrl } from '../services/githubBroker';
import { findUserByEmail } from '../services/userByEmail';
import { otlpDestinationFromEnv } from '../config/env';
import { discardRunnerStart, recordRunnerStart } from '../services/claudeRunnerSessions';
import { recordSessionEvent, type SessionEventKind } from '../services/claudeSessionEvents';
import {
  MAX_RUNNERS_PER_BOX,
  REFUSAL_TEXTS,
  RUNNER_AGENT_CAPABILITY,
  bearerToken,
  githubGate,
  ownerPlacementKey,
  parseRunnerSessions,
  parseSpawnBody,
  placeRunner,
  runnerBoxes,
  runnerLaunch,
  serializeByKey,
  tokensEqual,
} from '../services/claudeRunnerSpawn';

/** In the 404 body for an owner who is not a termag user; deploy/claude-spawn-runner matches it. */
export const OWNER_NOT_FOUND = 'owner-not-found';

export const DRAINING_ERROR = 'this orchestrator is draining for a deploy; retried on the serving one';

/**
 * `isServing` is the drain's (services/orchestratorDrain.ts): a displaced
 * process answers every spawn 503 at once, before it looks for a box, because
 * the boxes' agents are moving to the serving process.
 */
export function claudeRunnerRouter(spawnToken: string, isServing: () => boolean = () => true): Router {
  const router = Router();
  // Where a session's own OpenTelemetry goes, handed to the box script as
  // flags (services/claudeRunnerSpawn.ts, runnerLaunch); null ships nothing.
  const telemetry = otlpDestinationFromEnv(process.env);

  const authorize: RequestHandler = (req, res, next) => {
    const presented = bearerToken(req.headers.authorization);
    if (!isLocalPeer(req) || !presented || !tokensEqual(presented, spawnToken)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  const spawn: RequestHandler = async (req, res) => {
    // The hook stops waiting after curl's --max-time, and the orchestrator then
    // backs off and re-offers the session. A launch queued behind the owner's
    // lock past that point would start a runner nobody is waiting for.
    let callerGone = false;
    res.on('close', () => { if (!res.writableFinished) callerGone = true; });

    const parsed = parseSpawnBody(req.body);
    if ('error' in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { orderId, sessionId, accountEmail, workOrder } = parsed;
    if (!isServing()) {
      console.log(`[CLAUDE-RUNNER] order ${orderId}: 503 draining`);
      res.status(503).json({ error: DRAINING_ERROR });
      return;
    }

    // Same match as sign-in: the insensitive query only narrows, an exact
    // compare decides (`_`/`%` are ILIKE wildcards on Postgres).
    const user = await findUserByEmail(accountEmail);
    if (!user) {
      // Deliberately not the email, in the line or the response: the hook's
      // stderr lands in the Activity tab, and the journal is read project-wide.
      console.log(`[CLAUDE-RUNNER] order ${orderId}: 404 the session owner is not a termag user`);
      res.status(404).json({ error: 'the session owner is not a termag user; sign in to termag once, then retry from the Activity tab', code: OWNER_NOT_FOUND });
      return;
    }
    // One line per outcome, owner named (see the header), refusals included:
    // how often an owner is queued or refused is answerable from the journal.
    const who = user.unixUsername;
    const outcomeLine = (status: number, text: string) => console.log(`[CLAUDE-RUNNER] order ${orderId} for ${who}: ${status} ${text}`);
    // The session's event log (services/claudeSessionEvents.ts): one event per
    // outcome, a refusal's reason included, so the owner's UI shows a queued
    // session and why. Best effort; never changes the hook's answer.
    const event = (kind: SessionEventKind, detail: string | null = null, instanceId: string | null = null) =>
      recordSessionEvent({ owner: { id: user.id, unixUsername: who }, sessionId, orderId, instanceId, kind, detail });
    const refuse = async (status: number, error: string) => {
      outcomeLine(status, error);
      await event(status === 502 ? 'agent-failed' : 'queued', error);
      res.status(status).json({ error });
    };
    try {

      // Per-engineer gate 2: on a broker host the box clones with the owner's
      // stored gh token, so an owner who never connected GitHub would get a
      // runner that fails at checkout. Say so now, retryably.
      const store = getCredentialStoreConfig();
      const brokerConfigured = !!(store && getGithubBrokerUrl());
      let credential: 'present' | 'absent' | 'unknown' = 'unknown';
      if (store && brokerConfigured) {
        try {
          credential = (await githubStoreDeps(store, user.id).read()) ? 'present' : 'absent';
        } catch (err) {
          console.warn(`[CLAUDE-RUNNER] order ${orderId}: GitHub credential read failed, not holding it against the owner:`, err instanceof Error ? err.message : String(err));
        }
      }
      const gate = githubGate({ brokerConfigured, credential });
      if (!gate.ok) {
        await refuse(503, gate.error);
        return;
      }

      const rows = await prisma.instance.findMany({
        where: { userId: user.id, kind: 'ec2', status: 'ready' },
        select: { id: true, kind: true, status: true, hostHome: true, hostUnixUser: true, lastConnectedAt: true, name: true },
      });
      const candidates = rows.map(b => ({
        ...b,
        connected: isInstanceAgentConnected(b.id),
        capable: instanceAgentTransport(b.id)?.capabilities.includes(RUNNER_AGENT_CAPABILITY) ?? false,
      }));
      const boxes = runnerBoxes(candidates);
      if (boxes.length === 0) {
        const outdated = runnerBoxes(candidates.map(b => ({ ...b, capable: true }))).length > 0;
        await refuse(503, outdated ? REFUSAL_TEXTS.agentTooOld : REFUSAL_TEXTS.noBox);
        return;
      }

      // One placement at a time per owner: it reads every box's tmux sessions
      // and then creates one, and the orchestrator runs several hooks at once (a
      // retry can also race its own first attempt).
      type Outcome = { status: number; body: Record<string, unknown> };
      const outcome: Outcome = await serializeByKey<Outcome>(ownerPlacementKey(user.id), async () => {
        let listed;
        try {
          listed = await Promise.all(boxes.map(async box => {
            const reply = await sendToInstanceAgent(box.id, 'tmux-list', {});
            const names: string[] = Array.isArray(reply?.sessions) ? reply.sessions : [];
            return { box, sessions: parseRunnerSessions(names, box.hostUnixUser!) };
          }));
        } catch (err) {
          // Not knowing one box's sessions could start a second runner for an
          // order already running there; retry instead.
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[CLAUDE-RUNNER] order ${orderId}: listing the owner's boxes failed: ${msg}`);
          return { status: 502, body: { error: `a box agent did not list its sessions: ${msg}` } };
        }

        const placement = placeRunner(listed, orderId, MAX_RUNNERS_PER_BOX);
        if (placement.kind === 'existing') {
          const { box, slot } = placement;
          return { status: 200, body: { ok: true, instanceId: box.id, boxName: box.name, sessionName: runnerLaunch(box.hostHome!, box.hostUnixUser!, orderId, slot).sessionName, slot, alreadyRunning: true } };
        }
        if (placement.kind === 'full') {
          return { status: 503, body: { error: REFUSAL_TEXTS.boxesFull(placement.boxes, placement.max) } };
        }
        if (callerGone) {
          console.warn(`[CLAUDE-RUNNER] order ${orderId}: the spawn hook stopped waiting; not launching (the session is re-offered)`);
          return { status: 503, body: { error: REFUSAL_TEXTS.hookGaveUp } };
        }

        const { box, slot } = placement;
        const launch = runnerLaunch(box.hostHome!, box.hostUnixUser!, orderId, slot, telemetry, { user: user.id, box: box.id });
        const rpc = (type: string, payload: Record<string, unknown>) => sendToInstanceAgent(box.id, type, payload);
        // The session record, before the launch: a runner that exits at once
        // reports its end within a second, and the report needs the row
        // (services/claudeRunnerSessions.ts); startedAt is the launch time, not
        // the insert's. Best effort: a failed write is logged and the launch
        // goes ahead. A relaunch of an order whose runner vanished moves the
        // row to this box and slot.
        let recorded = false;
        try {
          await recordRunnerStart({ orderId, sessionId, userId: user.id, instanceId: box.id, slot, startedAt: new Date() });
          recorded = true;
        } catch (err) {
          console.error(`[CLAUDE-RUNNER] order ${orderId}: recording the start failed:`, err instanceof Error ? err.message : String(err));
        }
        try {
          // The JWT is in `content` only; sendToInstanceAgent logs nothing.
          await rpc('write-file', { path: launch.workOrderPath, content: `${workOrder}\n`, mode: launch.workOrderMode });
          const created = await rpc('tmux-create', { sessionName: launch.sessionName, cwd: launch.cwd, gitInit: launch.gitInit, command: launch.command });
          if (created?.created === false) {
            // The name is unique to this order and was absent a moment ago, under
            // the owner's lock: only a launch of this same order made it. The
            // row now names that launch's box and slot, which are these.
            return { status: 200, body: { ok: true, instanceId: box.id, boxName: box.name, sessionName: launch.sessionName, slot, alreadyRunning: true } };
          }
        } catch (err) {
          // Best effort: drop the session if it got that far (tmux-create may
          // have timed out after creating it), then empty the work order (the
          // box script refuses an empty one), and take the record back: no
          // runner ran.
          await rpc('tmux-kill', { sessionName: launch.sessionName, exact: true }).catch(() => {});
          await rpc('write-file', { path: launch.workOrderPath, content: '' }).catch(() => {});
          if (recorded) await discardRunnerStart(orderId).catch(e => console.error(`[CLAUDE-RUNNER] order ${orderId}: discarding the start failed:`, e instanceof Error ? e.message : String(e)));
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[CLAUDE-RUNNER] order ${orderId}: launch on ${box.name} (${box.id}) failed: ${msg}`);
          return { status: 502, body: { error: `the box agent refused the launch: ${msg}` } };
        }
        return { status: 202, body: { ok: true, instanceId: box.id, boxName: box.name, sessionName: launch.sessionName, slot } };
      });

      if (outcome.status === 202) {
        console.log(`[CLAUDE-RUNNER] order ${orderId} for ${who} started on ${outcome.body.boxName} (${outcome.body.instanceId}) as ${outcome.body.sessionName} (slot ${outcome.body.slot})`);
        await event('placed', `${outcome.body.boxName} slot ${outcome.body.slot}`, String(outcome.body.instanceId));
      } else if (outcome.status === 200) {
        console.log(`[CLAUDE-RUNNER] order ${orderId} for ${who} already running on ${outcome.body.boxName} (${outcome.body.instanceId}) slot ${outcome.body.slot}`);
        await event('already-running', `${outcome.body.boxName} slot ${outcome.body.slot}`, String(outcome.body.instanceId));
      } else {
        outcomeLine(outcome.status, String(outcome.body.error));
        await event(outcome.status === 502 ? 'agent-failed' : 'queued', String(outcome.body.error));
      }
      res.status(outcome.status).json(outcome.body);
    } catch (err) {
      // A throw past this point (the instance query, the lock) answers 500
      // through apiErrorHandler, which logs the stack; the owner's outcome
      // line is logged here so the count of failed orders stays complete.
      outcomeLine(500, err instanceof Error ? err.message : String(err));
      await event('agent-failed', 'internal error');
      throw err;
    }
  };

  router.post('/spawn', authorize, asyncHandler(spawn));
  return router;
}
