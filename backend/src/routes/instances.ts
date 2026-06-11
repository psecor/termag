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
 * When box provisioning isn't configured (local dev, or a deploy that hasn't
 * surfaced the IAM-grant outputs into the secret yet), POST falls back to the
 * legacy manual-terraform path: it returns the raw token so the user can run
 * `terraform apply` themselves.
 */

import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { randomBytes, createHash } from 'crypto';
import { requireAuth } from '../middleware/auth';
import { provisionBox, terminateBox, isBoxProvisioningConfigured } from '../services/boxProvisioner';

const prisma = new PrismaClient();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(): string {
  return 'tmag_' + randomBytes(32).toString('hex');
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

  // Create a new box: row + per-instance agent token, atomically.
  // The raw token is returned once.
  const create: RequestHandler = async (req, res) => {
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    const trimmed = name.trim();

    // Uniqueness per user. The DB has a unique index but we surface a 409
    // here rather than letting the user see a raw Prisma error.
    const existing = await prisma.instance.findFirst({
      where: { userId: req.user!.id, name: trimmed, status: { not: 'terminated' } },
    });
    if (existing) {
      res.status(409).json({ error: `A box named "${trimmed}" already exists` });
      return;
    }

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const tokenPrefix = rawToken.substring(0, 13) + '...';

    const { instance } = await prisma.$transaction(async (tx) => {
      const instance = await tx.instance.create({
        data: {
          userId: req.user!.id,
          name: trimmed,
          status: 'provisioning',
        },
      });
      await tx.agentToken.create({
        data: {
          userId: req.user!.id,
          instanceId: instance.id,
          name: `box: ${trimmed}`,
          tokenHash,
          tokenPrefix,
        },
      });
      return { instance };
    });

    if (isBoxProvisioningConfigured()) {
      // V2: provision the EC2 ourselves. Fire-and-forget — the box flips to
      // `ready` when its agent dials in, or `failed` on a provisioning error.
      // The raw token rides along in user_data, so it never leaves the server.
      void provisionBox({
        instance,
        boxName: trimmed,
        owner: req.user!.googleEmail,
        token: rawToken,
        remoteUnixUser: req.user!.unixUsername,
        gitUserEmail: req.user!.googleEmail,
        gitUserName: req.user!.displayName,
      });
      res.status(201).json({ instance });
      return;
    }

    // Legacy fallback: provisioning not configured. Return the raw token once
    // so the user can run `terraform apply` in terraform/box/ themselves.
    res.status(201).json({
      instance,
      token: rawToken,
      tokenPrefix,
      hint: 'Box provisioning is not configured; run `terraform apply` in terraform/box/ with this token',
    });
  };

  // Terminate a box: archive its projects, revoke its tokens, mark
  // terminated, and (when provisioning is configured) actually destroy the
  // EC2 + SG + IAM via the SDK. The teardown is fired un-awaited — it can take
  // minutes for the instance to terminate before the SG can be deleted.
  //
  // If the box has live (non-archived) projects, returns 409 with the
  // list. The client must re-send with body { confirmed: true }.
  const terminate: RequestHandler = async (req, res) => {
    const instance = await prisma.instance.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      include: {
        projects: {
          where: { archived: false },
          select: { id: true, name: true },
        },
      },
    });
    if (!instance) { res.status(404).json({ error: 'Box not found' }); return; }
    if (instance.status === 'terminated') { res.json({ ok: true, alreadyTerminated: true }); return; }

    const confirmed = (req.body as { confirmed?: boolean })?.confirmed === true;
    if (instance.projects.length > 0 && !confirmed) {
      res.status(409).json({
        error: 'Box has live projects',
        projects: instance.projects,
        hint: 'Re-send with body { "confirmed": true } to archive all projects and terminate the box',
      });
      return;
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

    if (isBoxProvisioningConfigured()) {
      // Tear down the EC2 + SG + IAM. Fire-and-forget; cleanup is idempotent
      // and tolerates a partially-provisioned box.
      void terminateBox(instance);
      res.json({ ok: true, archivedProjects: instance.projects.length });
      return;
    }

    res.json({
      ok: true,
      archivedProjects: instance.projects.length,
      hint: 'Run `terraform destroy` in terraform/box/ to remove the EC2',
    });
  };

  router.get('/', requireAuth, list);
  router.get('/:id', requireAuth, getOne);
  router.post('/', requireAuth, create);
  router.delete('/:id', requireAuth, terminate);

  return router;
}
