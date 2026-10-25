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
 * `claimed: false`. A user whose `box-image` flag names an image other than
 * the published one (services/boxImage.ts) never claims: pool boxes run the
 * published image. Nor does one whose `box-hibernation-enabled` value differs
 * from the pool's (services/boxHibernationFlag.ts): EC2 fixes hibernation at
 * launch, so a pool box can't be given the owner's.
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
import { recordProductEvent } from '../services/productEvents';
import { PowerRequestConflict, requestPower } from '../services/boxPower';
import { lifecycleViewFor, recentAutoTerminations, setBoxLifecycle } from '../services/boxLifecycle';
import { lifecycleSettingsError, parseLifecycleSettings } from '../services/boxLifecyclePolicy';
import { boolVariation } from '../services/featureFlags';
import { boxImageSelectionFor, isPublished, PUBLISHED_IMAGE } from '../services/boxImage';
import { ownerHibernationEnabled, poolHibernationEnabled } from '../services/boxHibernationFlag';
import { poolSpecHashOrNull, reconcileWarmPool } from '../services/warmPool';
import { isInstanceAgentConnected, sendToInstanceAgent } from '../services/agentRegistry';
import { revokeChats } from '../services/chatRevoke';
import {
  claimWarmBox,
  isNameConflict,
  prismaClaimEffects,
  WARM_POOL_ENABLED_FLAG,
} from '../services/warmPoolClaim';
import { BOX_NAME_ERROR, isValidBoxName } from '../services/boxNames';
import { boxRenameEnabled, boxTokenName, checkBoxRename, RENAME_DISABLED_CODE } from '../services/boxRename';
import { boxCreationRefusal, readBoxCreationFacts } from '../services/boxCreationGate';
import { RouteResult, sendResult } from './routeResult';
import { parseClaimTiming } from '../services/repoCreate';
import { notifyOnSuccess } from '../services/workspaceEvents';


function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return 'tmag_' + randomBytes(32).toString('hex');
}

/** Whether the owner's box-hibernation-enabled value is the pool's, so a pool box is what they would have launched. */
async function hibernationMatchesPool(user: Express.User, hibernation: boolean): Promise<boolean> {
  const pool = await poolHibernationEnabled();
  if (hibernation === pool) return true;
  console.log(`[POOL] claim skipped for ${user.unixUsername}: box-hibernation-enabled is ${hibernation}, the pool's is ${pool}`);
  return false;
}

/** A same-named box a new launch replaces: an EC2 box whose launch failed. */
function retiresOnRelaunch(existing: { kind: string; status: string }, kind: string): boolean {
  return kind === 'ec2' && existing.kind === 'ec2' && existing.status === 'failed';
}

/** Terminate a failed box; false when it left `failed` meanwhile. */
async function retireFailedBox(box: { id: string }): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.instance.updateMany({
    where: { id: box.id, status: 'failed' },
    data: { status: 'terminated', terminatedAt: now },
  });
  if (count === 0) return false;
  await prisma.agentToken.updateMany({ where: { instanceId: box.id, revokedAt: null }, data: { revokedAt: now } });
  if (isBoxProvisioningConfigured()) {
    const row = await prisma.instance.findUnique({ where: { id: box.id } });
    if (row) void terminateBox(row);
  }
  return true;
}

// Create a new box: row + per-instance agent token, atomically.
// The raw token is returned once.
//
// input.kind:
//   "ec2"      (default) — orchestrator-provisioned EC2 box (or the legacy
//                          manual-terraform fallback when AWS isn't wired).
//   "external"           — self-managed host; no AWS, token returned for the
//                          user to run the agent themselves.
//
// opts.parentInstanceId: the box whose own credentials asked for this one
// (the CLI on a box), recorded on the row whether it is claimed or launched.
export async function createBox(
  user: Express.User,
  input: { name?: unknown; kind?: unknown },
  opts: { requestHost?: string; parentInstanceId?: string | null } = {},
): Promise<RouteResult> {
  return notifyOnSuccess(await createBoxRow(user, input, opts), user.id, 'boxes');
}

async function createBoxRow(
  user: Express.User,
  input: { name?: unknown; kind?: unknown },
  opts: { requestHost?: string; parentInstanceId?: string | null },
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
  // A launch that failed is retried under its own name, so the failed box is
  // retired here rather than left behind beside its replacement.
  const retiring = existing && retiresOnRelaunch(existing, kind) ? existing : null;
  if (existing && !retiring) {
    return { status: 409, body: { error: `A box named "${trimmed}" already exists` } };
  }
  // Projects waiting on it are moved to the new box by their own Retry
  // (relaunchBoxFor), which retires the box itself; retiring it here would
  // strand them on a terminated box.
  if (retiring && await prisma.project.count({ where: { instanceId: retiring.id, archived: false } }) > 0) {
    return { status: 409, body: { error: `"${trimmed}" failed to launch; use Retry on its project to launch it again` } };
  }

  if (kind === 'ec2') {
    const refusal = boxCreationRefusal(await readBoxCreationFacts(user));
    if (refusal) return refusal;
  }
  if (retiring && !await retireFailedBox(retiring)) {
    return { status: 409, body: { error: `A box named "${trimmed}" already exists` } };
  }

  try {
    // The owner's box-image and box-hibernation-enabled flags, read once so
    // the claim decision and the launch agree. Pool boxes run the published
    // image with the pool's hibernation value, so a user whose flags say
    // otherwise always takes the cold path.
    const provisioned = kind === 'ec2' && isBoxProvisioningConfigured();
    const image = provisioned ? await boxImageSelectionFor(user) : PUBLISHED_IMAGE;
    const hibernation = provisioned ? await ownerHibernationEnabled(user) : false;

    // The warm path, when there is a pool to ask and this user is in the
    // flag's audience. Anything else, including a drained pool and three
    // boxes whose agents will not answer, falls through to the cold path
    // below untouched.
    if (provisioned
      && isPublished(image)
      && await boolVariation(WARM_POOL_ENABLED_FLAG, user, false)
      && await hibernationMatchesPool(user, hibernation)) {
      const currentHash = await poolSpecHashOrNull();
      if (currentHash) {
        const startedAt = Date.now();
        const outcome = await claimWarmBox(
          { owner: user, boxName: trimmed, currentHash, parentInstanceId: opts.parentInstanceId ?? null },
          prismaClaimEffects,
        );
        if (outcome.claimed) {
          console.log(`[POOL] claim ${outcome.instance.id} by ${user.unixUsername} in ${Date.now() - startedAt}ms`);
          // Un-awaited so the refill is under way before the browser has
          // rendered the row, and never on this request's critical path.
          void reconcileWarmPool();
          recordProductEvent('box.provisioned', { user: user.id, box: outcome.instance.id }, {
            boxKind: 'ec2', warmClaimed: true, claimMs: Date.now() - startedAt, child: !!opts.parentInstanceId,
          });
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
          parentInstanceId: opts.parentInstanceId ?? null,
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
          name: boxTokenName(trimmed),
          tokenHash,
          tokenPrefix,
        },
      });
      return created;
    });

    // "Provisioned" as in asked for: the row exists and the launch is under
    // way (or, external, the owner's own agent is awaited). The ready
    // transition is the agent's hello, which the box telemetry covers.
    recordProductEvent('box.provisioned', { user: user.id, box: instance.id }, {
      boxKind: kind, warmClaimed: false, child: !!opts.parentInstanceId,
      provisioning: kind === 'external' ? 'external' : isBoxProvisioningConfigured() ? 'orchestrator' : 'manual',
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
        image,
        hibernation,
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
  // Its live projects are archived with it, so both lists change.
  return notifyOnSuccess(await terminateBoxRow(user, id, confirmed), user.id, ['boxes', 'projects']);
}

async function terminateBoxRow(user: Express.User, id: string, confirmed: boolean): Promise<RouteResult> {
  const instance = await prisma.instance.findFirst({
    where: { id, userId: user.id },
    include: {
      projects: {
        where: { archived: false },
        select: { id: true, name: true, workstreams: { select: { id: true } } },
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
        projects: instance.projects.map(p => ({ id: p.id, name: p.name })),
        hint: 'Re-send with body { "confirmed": true } to archive all projects and terminate the box',
      },
    };
  }

  // A host this request will not destroy (an external box, or one with no EC2
  // teardown) must not have its token revoked while a chat turn is still in
  // tmux: the socket closing does not kill that session. An EC2 terminate
  // while the agent is offline may proceed, because the instance is destroyed.
  if (instance.projects.length > 0) {
    const destroysHost = instance.kind !== 'external' && isBoxProvisioningConfigured();
    const connected = isInstanceAgentConnected(instance.id);
    for (const project of instance.projects) {
      const blocked = await revokeChats(
        (type, payload) => sendToInstanceAgent(instance.id, type, payload),
        connected,
        project.id,
        project.workstreams.map(w => w.id),
        { offlineBlocks: !destroysHost },
      );
      if (blocked) return { status: 409, body: { error: blocked } };
    }
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
  return notifyOnSuccess(await powerBoxRow(user, id, action), user.id, 'boxes');
}

async function powerBoxRow(user: Express.User, id: string, action: PowerAction): Promise<RouteResult> {
  const instance = await prisma.instance.findUnique({ where: { id } });
  const refused = powerRequestError(instance, user.id, action, isBoxProvisioningConfigured());
  if (refused) return { status: refused.status, body: { error: refused.error } };
  try {
    const status = await requestPower(instance!, action, { markInUse: action === 'start', byOwner: true });
    return { status: 202, body: { ok: true, status } };
  } catch (err) {
    if (err instanceof PowerRequestConflict) return { status: 409, body: { error: err.message } };
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[BOX] ${action} ${instance!.name} failed:`, message);
    return { status: 502, body: { error: `EC2 refused the ${action}: ${message}` } };
  }
}

// Change a box's automatic lifecycle settings.
// Owner only; another user's box answers 404 like a missing one. Answers the
// settings as stored; a box that can't hibernate takes them too, and the
// answer's `lifecycle.warning` says auto-park will do nothing there.
export async function setOwnedBoxLifecycle(user: Express.User, id: string, body: unknown): Promise<RouteResult> {
  const parsed = parseLifecycleSettings(body);
  if ('error' in parsed) return { status: 400, body: { error: parsed.error } };
  const instance = await prisma.instance.findFirst({ where: { id, userId: user.id } });
  if (!instance) return { status: 404, body: { error: 'Box not found' } };
  const refused = lifecycleSettingsError(instance, parsed.settings);
  if (refused) return { status: 409, body: { error: refused } };
  await setBoxLifecycle(instance.id, parsed.settings);
  const row = await prisma.instance.findUniqueOrThrow({ where: { id: instance.id } });
  return { status: 200, body: { lifecycle: await lifecycleViewFor(user, row) } };
}

// Rename a box (services/boxRename.ts). Owner only; another user's box answers
// 404 like a missing one. Its agent token's label follows when it still
// carries the old name. Project lists show box names, so both lists change.
export async function renameOwnedBox(user: Express.User, id: string, newName: unknown): Promise<RouteResult> {
  return notifyOnSuccess(await renameBoxRow(user, id, newName), user.id, ['boxes', 'projects']);
}

async function renameBoxRow(user: Express.User, id: string, newName: unknown): Promise<RouteResult> {
  if (!await boxRenameEnabled(user)) {
    return { status: 403, body: { error: 'Renaming boxes is not enabled for you', code: RENAME_DISABLED_CODE } };
  }
  const instance = await prisma.instance.findFirst({ where: { id, userId: user.id } });
  const check = checkBoxRename(instance, newName);
  if (!check.ok) return { status: check.status, body: { error: check.error } };
  if (check.unchanged) return { status: 200, body: { instance } };

  const conflict = { status: 409, body: { error: `A box named "${check.name}" already exists` } };
  const taken = await prisma.instance.findFirst({
    where: { userId: user.id, name: check.name, status: { not: 'terminated' }, id: { not: id } },
    select: { id: true },
  });
  if (taken) return conflict;

  try {
    const [renamed] = await prisma.$transaction([
      prisma.instance.update({ where: { id }, data: { name: check.name } }),
      prisma.agentToken.updateMany({
        where: { instanceId: id, name: boxTokenName(instance!.name) },
        data: { name: boxTokenName(check.name) },
      }),
    ]);
    console.log(`[BOX] ${user.unixUsername} renamed box ${id} from "${instance!.name}" to "${check.name}"`);
    return { status: 200, body: { instance: renamed } };
  } catch (err) {
    if (isNameConflict(err)) return conflict;
    throw err;
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
    res.json(await Promise.all(instances.map(async i => ({ ...i, lifecycle: await lifecycleViewFor(req.user!, i) }))));
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
  // Boxes the lifecycle sweep terminated in the last week; terminated boxes
  // are otherwise left out of the list. Before /:id so it isn't taken as one.
  router.get('/auto-terminated', requireAuth, asyncHandler(async (req, res) => {
    res.json(await recentAutoTerminations(req.user!.id));
  }));
  router.get('/:id', requireAuth, asyncHandler(getOne));
  router.post('/', requireAuth, asyncHandler(create));
  router.post('/:id/claim-timing', requireAuth, asyncHandler(claimTiming));
  router.post('/:id/repo-prompt-dismiss', requireAuth, asyncHandler(dismissRepoPrompt));
  router.get('/:id/on-claim-log', requireAuth, asyncHandler(onClaimLog));
  router.delete('/:id', requireAuth, asyncHandler(terminate));
  router.post('/:id/stop', requireAuth, asyncHandler(power('stop')));
  router.post('/:id/start', requireAuth, asyncHandler(power('start')));
  router.post('/:id/hibernate', requireAuth, asyncHandler(power('hibernate')));
  router.post('/:id/rename', requireAuth, asyncHandler(async (req, res) => {
    sendResult(res, await renameOwnedBox(req.user!, req.params.id, req.body?.name));
  }));
  router.patch('/:id/lifecycle', requireAuth, asyncHandler(async (req, res) => {
    sendResult(res, await setOwnedBoxLifecycle(req.user!, req.params.id, req.body));
  }));

  return router;
}
