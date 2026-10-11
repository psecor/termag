/**
 * Instances (boxes) — CRUD for per-user compute boxes.
 *
 * V2 design: orchestrator-driven provisioning. POST creates the Instance row +
 * a per-box bearer token, then kicks off async EC2 provisioning via the AWS SDK
 * (boxProvisioner) and returns immediately with `status: provisioning`. The box
 * boots, cloud-init starts the agent, the agent dials the WS, and
 * agentRegistry.registerAgent flips the Instance to `ready`. DELETE actually
 * tears the EC2 (+ SG + IAM) down via the SDK.
 *
 * Warm pool: for `kind: "ec2"` with `warm-pool-enabled` on, POST first tries to
 * claim a box the pool already booted (services/warmPoolClaim.ts). That answers
 * `{instance, claimed: true}` with the row already `ready`. Everything below is
 * the cold path, which every other request still takes and which now says
 * `claimed: false`.
 *
 * When box provisioning isn't configured (local dev, or a deploy that hasn't
 * surfaced the IAM-grant outputs into the secret yet), POST falls back to the
 * legacy manual-terraform path: it returns the raw token so the user can run
 * `terraform apply` themselves.
 *
 * External (self-managed) boxes: POST with { kind: "external" } skips AWS
 * entirely. It creates the Instance row + an instance-bound token and returns
 * the raw token (once) for the user to drop into agent.config.json on their own
 * machine (laptop, devbox, anything). Because the token is keyed by instanceId,
 * the agent gets its own registry slot — so one user can run several machines
 * at once, unlike a plain per-user token which only ever holds a single slot.
 */

import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { randomBytes, createHash } from 'crypto';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { provisionBox, terminateBox, isBoxProvisioningConfigured } from '../services/boxProvisioner';
import { PowerAction, powerRequestError } from '../services/boxPowerPolicy';
import { PowerRequestConflict, requestPower } from '../services/boxPower';
import { warmPoolConfigFromEnv } from '../config/env';
import { boolVariation } from '../services/featureFlags';
import { currentPoolSpecHash, reconcileWarmPool } from '../services/warmPool';
import { sendToInstanceAgent } from '../services/agentRegistry';
import {
  claimWarmBox,
  isNameConflict,
  prismaClaimEffects,
  WARM_POOL_ENABLED_FLAG,
} from '../services/warmPoolClaim';
import { BOX_NAME_ERROR, isValidBoxName } from '../services/boxNames';
import { boxCreationRefusal, readBoxCreationFacts } from '../services/boxCreationGate';
import { RouteResult, sendResult } from './routeResult';
import { parseClaimTiming } from '../services/repoCreate';


function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return 'tmag_' + randomBytes(32).toString('hex');
}

/**
 * The hash the claim statement filters on, or null when there is no point
 * asking for one.
 *
 * Deriving it costs a DescribeImages call, so two indexed reads come first: a
 * target of 0 means the pool should not exist and every claim takes the cold
 * path (WP-2), and an empty pool has nothing for the statement to match. Both
 * are the common case on a deployment that has not opted in, and neither
 * should make a user's click wait on AWS. The cache in #104 is what makes the
 * call itself cheap once it is warranted.
 *
 * Failing soft matters more than the call: an AWS hiccup should cost the user
 * a cold box, not an error.
 */
async function poolSpecHashOrNull(): Promise<string | null> {
  if (warmPoolConfigFromEnv(process.env).targetSize <= 0) return null;
  if (await prisma.instance.count({ where: { userId: null, status: 'warm' } }) === 0) return null;
  try {
    return await currentPoolSpecHash();
  } catch (err) {
    console.warn('[POOL] claim skipped, no pool spec hash:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

// Create a new box: row + per-instance agent token, atomically.
// The raw token is returned once.
//
// input.kind:
//   "ec2"      (default) — orchestrator-provisioned EC2 box (or the legacy
//                          manual-terraform fallback when AWS isn't wired).
//   "external"           — self-managed host; no AWS, token returned for the
//                          user to run the agent themselves.
export async function createBox(
  user: Express.User,
  input: { name?: unknown; kind?: unknown },
  opts: { requestHost?: string } = {},
): Promise<RouteResult> {
  const { name, kind: rawKind } = input;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { status: 400, body: { error: 'name required' } };
  }
  const kind = rawKind === 'external' ? 'external' : 'ec2';
  const trimmed = name.trim();
  if (!isValidBoxName(trimmed)) return { status: 400, body: { error: BOX_NAME_ERROR } };

  // Uniqueness per user. The DB has a unique index but we surface a 409
  // here rather than letting the user see a raw Prisma error.
  const existing = await prisma.instance.findFirst({
    where: { userId: user.id, name: trimmed, status: { not: 'terminated' } },
  });
  if (existing) {
    return { status: 409, body: { error: `A box named "${trimmed}" already exists` } };
  }

  if (kind === 'ec2') {
    const refusal = boxCreationRefusal(await readBoxCreationFacts(user));
    if (refusal) return refusal;
  }

  try {
    // The warm path, when there is a pool to ask and this user is in the
    // flag's audience. Anything else, including a drained pool and three
    // boxes whose agents will not answer, falls through to the cold path
    // below untouched.
    if (kind === 'ec2'
      && isBoxProvisioningConfigured()
      && await boolVariation(WARM_POOL_ENABLED_FLAG, user, false)) {
      const currentHash = await poolSpecHashOrNull();
      if (currentHash) {
        const startedAt = Date.now();
        const outcome = await claimWarmBox(
          { owner: user, boxName: trimmed, currentHash },
          prismaClaimEffects,
        );
        if (outcome.claimed) {
          console.log(`[POOL] claim ${outcome.instance.id} by ${user.unixUsername} in ${Date.now() - startedAt}ms`);
          // Un-awaited so the refill is under way before the browser has
          // rendered the row, and never on this request's critical path.
          void reconcileWarmPool();
          return { status: 201, body: { instance: outcome.instance, claimed: true } };
        }
        console.log(`[POOL] claim fell through for ${user.unixUsername}: ${outcome.reason} after ${outcome.candidatesTried} candidate(s)`);
      }
    }

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const tokenPrefix = rawToken.substring(0, 13) + '...';

    const instance = await prisma.$transaction(async (tx) => {
      const created = await tx.instance.create({
        data: {
          userId: user.id,
          name: trimmed,
          kind,
          // External boxes have no provisioning step — they sit at
          // "awaiting-agent" until the self-run agent dials in and
          // registerAgent flips them to "ready".
          status: kind === 'external' ? 'awaiting-agent' : 'provisioning',
        },
      });
      await tx.agentToken.create({
        data: {
          userId: user.id,
          instanceId: created.id,
          name: `box: ${trimmed}`,
          tokenHash,
          tokenPrefix,
        },
      });
      return created;
    });

    if (kind === 'external') {
      // Self-managed host: no AWS work. Hand back the raw token (once) plus the
      // WS URL so the user can fill in agent.config.json on their own machine.
      const agentWsUrl = process.env.AGENT_WS_URL
        || `wss://${opts.requestHost ?? 'your-orchestrator'}/termag/ws/agent`;
      return {
        status: 201,
        body: {
          instance,
          claimed: false,
          token: rawToken,
          tokenPrefix,
          agentWsUrl,
          hint: 'Self-managed box. Put this token + termag_url into agent.config.json '
            + 'on your machine and start the termag agent. Shown once.',
        },
      };
    }

    if (isBoxProvisioningConfigured()) {
      // V2: provision the EC2 ourselves. Fire-and-forget — the box flips to
      // `ready` when its agent dials in, or `failed` on a provisioning error.
      // The raw token rides along in user_data, so it never leaves the server.
      void provisionBox({
        instance,
        boxName: trimmed,
        owner: user.googleEmail,
        token: rawToken,
        remoteUnixUser: user.unixUsername,
        gitUserEmail: user.googleEmail,
        gitUserName: user.displayName,
      });
      return { status: 201, body: { instance, claimed: false } };
    }

    // Legacy fallback: provisioning not configured. Return the raw token once
    // so the user can run `terraform apply` in terraform/box/ themselves.
    return {
      status: 201,
      body: {
        instance,
        claimed: false,
        token: rawToken,
        tokenPrefix,
        hint: 'Box provisioning is not configured; run `terraform apply` in terraform/box/ with this token',
      },
    };
  } catch (err) {
    // Defense-in-depth for the (userId, name) unique: the pre-check above
    // already 409s on an active duplicate, but a concurrent create could still
    // race into it, from the cold path's insert or from the claim's UPDATE.
    // Surface it as a clean 409 rather than letting it escape as an unhandled
    // rejection (which is what left the UI showing a generic "Failed to
    // create box" with no response).
    if (isNameConflict(err)) {
      return { status: 409, body: { error: `A box named "${trimmed}" already exists` } };
    }
    console.error('[BOX] create failed:', err instanceof Error ? err.message : String(err));
    return { status: 500, body: { error: 'Failed to create box' } };
  }
}

// Terminate a box: archive its projects, revoke its tokens, mark
// terminated, and (when provisioning is configured) actually destroy the
// EC2 + SG + IAM via the SDK. The teardown is fired un-awaited — it can take
// minutes for the instance to terminate before the SG can be deleted.
//
// If the box has live (non-archived) projects, returns 409 with the
// list. The client must re-send with `confirmed`.
export async function terminateOwnedBox(user: Express.User, id: string, confirmed: boolean): Promise<RouteResult> {
  const instance = await prisma.instance.findFirst({
    where: { id, userId: user.id },
    include: {
      projects: {
        where: { archived: false },
        select: { id: true, name: true },
      },
    },
  });
  if (!instance) return { status: 404, body: { error: 'Box not found' } };
  if (instance.status === 'terminated') return { status: 200, body: { ok: true, alreadyTerminated: true } };

  if (instance.projects.length > 0 && !confirmed) {
    return {
      status: 409,
      body: {
        error: 'Box has live projects',
        projects: instance.projects,
        hint: 'Re-send with body { "confirmed": true } to archive all projects and terminate the box',
      },
    };
  }

  await prisma.$transaction([
    prisma.project.updateMany({
      where: { instanceId: instance.id, archived: false },
      data: { archived: true },
    }),
    prisma.agentToken.updateMany({
      where: { instanceId: instance.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.instance.update({
      where: { id: instance.id },
      data: { status: 'terminated', terminatedAt: new Date() },
    }),
  ]);

  if (instance.kind === 'external') {
    // Self-managed host: no AWS to tear down. The token is already revoked
    // above, which disconnects the agent; the user stops it on their machine.
    return {
      status: 200,
      body: {
        ok: true,
        archivedProjects: instance.projects.length,
        hint: 'Token revoked. Stop the termag agent on this machine (it will keep retrying otherwise).',
      },
    };
  }

  if (isBoxProvisioningConfigured()) {
    // Tear down the EC2 + SG + IAM. Fire-and-forget; cleanup is idempotent
    // and tolerates a partially-provisioned box.
    void terminateBox(instance);
    return { status: 200, body: { ok: true, archivedProjects: instance.projects.length } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      archivedProjects: instance.projects.length,
      hint: 'Run `terraform destroy` in terraform/box/ to remove the EC2',
    },
  };
}

// Stop or start the box's EC2 instance. Answers 202 with the transitional
// status; the power sweep settles `stopping` to `stopped`, and the agent's
// connect settles `starting` to `ready`.
export async function powerOwnedBox(user: Express.User, id: string, action: PowerAction): Promise<RouteResult> {
  const instance = await prisma.instance.findUnique({ where: { id } });
  const refused = powerRequestError(instance, user.id, action, isBoxProvisioningConfigured());
  if (refused) return { status: refused.status, body: { error: refused.error } };
  try {
    const status = await requestPower(instance!, action);
    return { status: 202, body: { ok: true, status } };
  } catch (err) {
    if (err instanceof PowerRequestConflict) return { status: 409, body: { error: err.message } };
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[BOX] ${action} ${instance!.name} failed:`, message);
    return { status: 502, body: { error: `EC2 refused the ${action}: ${message}` } };
  }
}

export function instancesRouter(): Router {
  const router = Router();

  // List the caller's non-terminated boxes, including project counts.
  const list: RequestHandler = async (req, res) => {
    const instances = await prisma.instance.findMany({
      where: { userId: req.user!.id, status: { not: 'terminated' } },
      include: { _count: { select: { projects: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(instances);
  };

  // Single box. Includes project list (id+name only) for the delete-confirm UI.
  const getOne: RequestHandler = async (req, res) => {
    const instance = await prisma.instance.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: {
        projects: {
          where: { archived: false },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        },
      },
    });
    if (!instance) { res.status(404).json({ error: 'Box not found' }); return; }
    res.json(instance);
  };

  const create: RequestHandler = async (req, res) => {
    sendResult(res, await createBox(req.user!, req.body ?? {}, { requestHost: req.get('host') }));
  };

  // The browser's own measure of a claim: click to first terminal data, which
  // is the number WC-3's p95 is taken over. Logged rather than stored, because
  // there is no column for it and this PR carries no migration; the samples
  // come back out of the [POOL] log.
  const claimTiming: RequestHandler = async (req, res) => {
    const parsed = parseClaimTiming(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const instance = await prisma.instance.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true },
    });
    if (!instance) { res.status(404).json({ error: 'Box not found' }); return; }

    const pick = parsed.pickMs === null ? '' : ` pick ${Math.round(parsed.pickMs)}ms`;
    console.log(`[POOL] claim-timing ${instance.id} ${Math.round(parsed.ms)}ms${pick}`);
    res.json({ ok: true });
  };

  const dismissRepoPrompt: RequestHandler = async (req, res) => {
    const existing = await prisma.instance.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!existing) { res.status(404).json({ error: 'Box not found' }); return; }
    if (existing.kind !== 'ec2') {
      res.status(400).json({ error: 'Only a managed box can dismiss the repository prompt' });
      return;
    }
    await prisma.instance.updateMany({
      where: { id: existing.id, userId: req.user!.id, repoPromptDismissedAt: null },
      data: { repoPromptDismissedAt: new Date() },
    });
    const instance = await prisma.instance.findFirst({
      where: { id: existing.id, userId: req.user!.id },
    });
    if (!instance) { res.status(404).json({ error: 'Box not found' }); return; }
    res.json(instance);
  };

  const onClaimLog: RequestHandler = async (req, res) => {
    const instance = await prisma.instance.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true, hostHome: true },
    });
    if (!instance) { res.status(404).json({ error: 'Box not found' }); return; }
    try {
      const home = instance.hostHome ?? '/home/termag';
      const reply = await sendToInstanceAgent(
        instance.id,
        'read-file',
        { path: `${home}/.termag/on-claim.log` },
      );
      const content = typeof reply?.content === 'string' ? reply.content.slice(-16 * 1024) : '';
      res.json({ log: content });
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Box agent unavailable' });
    }
  };

  const terminate: RequestHandler = async (req, res) => {
    const confirmed = (req.body as { confirmed?: boolean })?.confirmed === true;
    sendResult(res, await terminateOwnedBox(req.user!, req.params.id, confirmed));
  };

  // Stop, hibernate or start the box's EC2 instance. Answers 202 with the
  // transitional status; the power sweep settles `stopping` to `stopped` and
  // `hibernating` to `hibernated`, and the agent's connect settles `starting`
  // to `ready`. A hibernate EC2 refuses answers `stopping`: it fell back to a
  // plain stop, and the row's provisioningError says so.
  const power = (action: PowerAction): RequestHandler => async (req, res) => {
    sendResult(res, await powerOwnedBox(req.user!, req.params.id, action));
  };

  // asyncHandler: Express 4 drops async rejections on the floor, so a DB error
  // in any of these would otherwise hang the request until the proxy's timeout
  // (that was the 504 on POST before #59 added create's own try/catch). With
  // the wrapper they reach apiErrorHandler and answer with JSON.
  router.get('/', requireAuth, asyncHandler(list));
  router.get('/:id', requireAuth, asyncHandler(getOne));
  router.post('/', requireAuth, asyncHandler(create));
  router.post('/:id/claim-timing', requireAuth, asyncHandler(claimTiming));
  router.post('/:id/repo-prompt-dismiss', requireAuth, asyncHandler(dismissRepoPrompt));
  router.get('/:id/on-claim-log', requireAuth, asyncHandler(onClaimLog));
  router.delete('/:id', requireAuth, asyncHandler(terminate));
  router.post('/:id/stop', requireAuth, asyncHandler(power('stop')));
  router.post('/:id/start', requireAuth, asyncHandler(power('start')));
  router.post('/:id/hibernate', requireAuth, asyncHandler(power('hibernate')));

  return router;
}
