import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import * as tmux from '../services/tmux';

const prisma = new PrismaClient();

export function workTerminalsRouter(): Router {
  const router = Router();

  const list: RequestHandler = async (req, res) => {
    const terminals = await prisma.workTerminal.findMany({
      where: { userId: req.user!.id },
      orderBy: { sortOrder: 'asc' },
    });
    res.json(terminals);
  };

  const create: RequestHandler = async (req, res) => {
    try {
      const { name, sortOrder } = req.body;
      if (!name) { res.status(400).json({ error: 'name required' }); return; }

      const terminal = await prisma.workTerminal.create({
        data: { name, userId: req.user!.id, sortOrder: sortOrder ?? 0 },
      });

      await tmux.ensureSession(tmux.workSessionName(req.user!.unixUsername, name));

      res.status(201).json(terminal);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'P2002') {
        res.status(409).json({ error: 'Work terminal name already exists' });
        return;
      }
      res.status(500).json({ error: 'Failed to create work terminal' });
    }
  };

  const remove: RequestHandler = async (req, res) => {
    try {
      const terminal = await prisma.workTerminal.findFirst({
        where: { id: req.params.id, userId: req.user!.id },
      });
      if (!terminal) { res.status(404).json({ error: 'Not found' }); return; }

      await prisma.workTerminal.delete({ where: { id: terminal.id } });
      await tmux.killSession(tmux.workSessionName(req.user!.unixUsername, terminal.name));

      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to delete work terminal' });
    }
  };

  router.get('/', requireAuth, list);
  router.post('/', requireAuth, create);
  router.delete('/:id', requireAuth, remove);

  return router;
}
