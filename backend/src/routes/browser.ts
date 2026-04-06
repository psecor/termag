import { Router, RequestHandler } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { requireAuth, requireRelayToken } from '../middleware/auth';
import { ChromeWindow } from '../types/index';

const prisma = new PrismaClient();

export function browserRouter(): Router {
  const router = Router();

  // Called by the local relay script — pushes Chrome tab snapshot
  const sync: RequestHandler = async (req, res) => {
    try {
      const { windows } = req.body as { windows: ChromeWindow[] };
      if (!Array.isArray(windows)) {
        res.status(400).json({ error: 'windows array required' });
        return;
      }

      const token = process.env.RELAY_TOKEN ?? '';
      await prisma.relaySnapshot.upsert({
        where: { relayToken: token },
        update: { windows: windows as unknown as Prisma.InputJsonValue, snapshotAt: new Date() },
        create: { relayToken: token, windows: windows as unknown as Prisma.InputJsonValue },
      });

      res.json({ ok: true, windowCount: windows.length });
    } catch {
      res.status(500).json({ error: 'Failed to save snapshot' });
    }
  };

  // Get the latest relay snapshot (used by frontend to pick tabs for a project)
  const getSnapshot: RequestHandler = async (_req, res) => {
    try {
      const snapshot = await prisma.relaySnapshot.findUnique({
        where: { relayToken: process.env.RELAY_TOKEN ?? '' },
      });
      if (!snapshot) {
        res.json({ windows: [], snapshotAt: null });
        return;
      }
      res.json({ windows: snapshot.windows, snapshotAt: snapshot.snapshotAt });
    } catch {
      res.status(500).json({ error: 'Failed to get snapshot' });
    }
  };

  // Get saved tabs for a project
  const getTabs: RequestHandler = async (req, res) => {
    try {
      const project = await prisma.project.findFirst({
        where: { id: req.params.projectId, userId: req.user!.id },
      });
      if (!project) { res.status(404).json({ error: 'Not found' }); return; }

      const tabs = await prisma.browserTab.findMany({
        where: { projectId: project.id },
        orderBy: { addedAt: 'desc' },
      });
      res.json(tabs);
    } catch {
      res.status(500).json({ error: 'Failed to get tabs' });
    }
  };

  // Save tabs to a project (from snapshot selection in the UI)
  const saveTabs: RequestHandler = async (req, res) => {
    try {
      const project = await prisma.project.findFirst({
        where: { id: req.params.projectId, userId: req.user!.id },
      });
      if (!project) { res.status(404).json({ error: 'Not found' }); return; }

      const { tabs } = req.body as { tabs: Array<{ url: string; title: string; favIcon?: string; windowId?: number }> };
      if (!Array.isArray(tabs)) { res.status(400).json({ error: 'tabs array required' }); return; }

      await prisma.$transaction([
        prisma.browserTab.deleteMany({ where: { projectId: project.id } }),
        prisma.browserTab.createMany({
          data: tabs.map(t => ({
            projectId: project.id,
            url: t.url,
            title: t.title,
            favIcon: t.favIcon,
            windowId: t.windowId,
          })),
        }),
      ]);

      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to save tabs' });
    }
  };

  // Delete a single tab from a project
  const deleteTab: RequestHandler = async (req, res) => {
    try {
      const project = await prisma.project.findFirst({
        where: { id: req.params.projectId, userId: req.user!.id },
      });
      if (!project) { res.status(404).json({ error: 'Not found' }); return; }

      await prisma.browserTab.deleteMany({
        where: { id: req.params.tabId, projectId: project.id },
      });
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to delete tab' });
    }
  };

  router.post('/sync', requireRelayToken, sync);
  router.get('/snapshot', requireAuth, getSnapshot);
  router.get('/projects/:projectId/tabs', requireAuth, getTabs);
  router.post('/projects/:projectId/tabs', requireAuth, saveTabs);
  router.delete('/projects/:projectId/tabs/:tabId', requireAuth, deleteTab);

  return router;
}
