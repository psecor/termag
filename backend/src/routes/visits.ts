import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';

const prisma = new PrismaClient();

export function visitsRouter(): Router {
  const router = Router();

  const record: RequestHandler = async (req, res) => {
    const { projectId, previousProjectId, sessionTag } = req.body as {
      projectId?: string | null;
      previousProjectId?: string | null;
      sessionTag?: string;
    };

    // Both ids may be null (e.g. switching to "no project"), but if present
    // must be strings. Reject obvious garbage.
    if (projectId !== null && projectId !== undefined && typeof projectId !== 'string') {
      res.status(400).json({ error: 'projectId must be string or null' });
      return;
    }
    if (previousProjectId !== null && previousProjectId !== undefined && typeof previousProjectId !== 'string') {
      res.status(400).json({ error: 'previousProjectId must be string or null' });
      return;
    }
    if (sessionTag !== undefined && typeof sessionTag !== 'string') {
      res.status(400).json({ error: 'sessionTag must be string' });
      return;
    }

    // If projectId is set, confirm the viewer can see the project (owner or
    // collaborator). This stops a hostile client from logging visits to
    // arbitrary project ids it doesn't have access to.
    if (projectId) {
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) {
        res.status(404).json({ error: 'project not found' });
        return;
      }
      if (project.userId !== req.user!.id) {
        const share = await prisma.projectShare.findUnique({
          where: { projectId_userId: { projectId, userId: req.user!.id } },
        });
        if (!share) {
          res.status(403).json({ error: 'no access to project' });
          return;
        }
      }
    }

    await prisma.projectVisit.create({
      data: {
        userId: req.user!.id,
        projectId: projectId ?? null,
        previousProjectId: previousProjectId ?? null,
        sessionTag: sessionTag ?? null,
      },
    });

    res.json({ ok: true });
  };

  router.post('/', requireAuth, record);

  return router;
}
