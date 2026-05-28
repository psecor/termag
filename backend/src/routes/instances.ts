/**
 * Instances (boxes) — CRUD for per-user compute boxes.
 *
 * V1 design: user-driven Terraform. POST returns an instance ID + a
 * per-instance bearer token; the user runs `terraform apply` from their
 * own machine to actually provision the EC2. The orchestrator just
 * tracks the box's identity and accepts the agent's WS connection when
 * the box dials in with the token.
 *
 * Box becomes `ready` automatically when its agent first connects (see
 * agentRegistry.registerAgent). No state is updated from this router.
 */

import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { randomBytes, createHash } from 'crypto';
import { requireAuth } from '../middleware/auth';

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

    // Raw token shown once. The UI should copy it into the user's terraform
    // invocation. After this response, the orchestrator can't recover it.
    res.status(201).json({
      instance,
      token: rawToken,
      tokenPrefix,
    });
  };

  // Terminate a box: archive its projects, revoke its tokens, mark
  // terminated. Does NOT run `terraform destroy` — the user does that
  // from their own shell.
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
