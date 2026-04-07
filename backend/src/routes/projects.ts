import { Router, RequestHandler } from 'express';
import { PrismaClient, WorkflowType } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import * as tmux from '../services/tmux';
import { isAgentConnected, sendToAgent } from '../services/agentRegistry';

const prisma = new PrismaClient();

export function projectsRouter(): Router {
  const router = Router();

  const list: RequestHandler = async (req, res) => {
    try {
      const projects = await prisma.project.findMany({
        where: { userId: req.user!.id, archived: false },
        include: { workflows: true },
        orderBy: { name: 'asc' },
      });
      res.json(projects);
    } catch {
      res.status(500).json({ error: 'Failed to list projects' });
    }
  };

  const create: RequestHandler = async (req, res) => {
    try {
      const { name, description, color } = req.body;
      if (!name) { res.status(400).json({ error: 'name required' }); return; }

      // Validate project name — safe for filesystem and tmux
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        res.status(400).json({ error: 'name must be alphanumeric with dashes/underscores only' });
        return;
      }

      // Check for archived project with same name — unarchive instead
      const archived = await prisma.project.findFirst({
        where: { userId: req.user!.id, name, archived: true },
        include: { workflows: true },
      });
      if (archived) {
        await prisma.project.update({
          where: { id: archived.id },
          data: { archived: false, description, color },
        });
        const restored = await prisma.project.findUnique({
          where: { id: archived.id },
          include: { workflows: true },
        });
        res.status(200).json({ ...restored, restored: true });
        return;
      }

      // Create project directory — via agent if connected, else direct
      if (isAgentConnected(req.user!.id)) {
        await sendToAgent(req.user!.id, 'mkdir', { dir: tmux.projectDir(req.user!.unixUsername, name) });
      } else {
        await tmux.ensureProjectDir(req.user!.unixUsername, name);
      }

      const project = await prisma.project.create({
        data: { name, description, color, userId: req.user!.id },
        include: { workflows: true },
      });
      res.status(201).json(project);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'P2002') {
        res.status(409).json({ error: 'Project name already exists' });
        return;
      }
      res.status(500).json({ error: 'Failed to create project' });
    }
  };

  const update: RequestHandler = async (req, res) => {
    try {
      const { name, description, color, archived } = req.body;
      const project = await prisma.project.updateMany({
        where: { id: req.params.id, userId: req.user!.id },
        data: { name, description, color, archived },
      });
      if (project.count === 0) { res.status(404).json({ error: 'Not found' }); return; }
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to update project' });
    }
  };

  // Archive a project: kill all tmux sessions, delete workflows, keep directory and DB record
  const archive: RequestHandler = async (req, res) => {
    try {
      const project = await prisma.project.findFirst({
        where: { id: req.params.id, userId: req.user!.id },
        include: { workflows: true },
      });
      if (!project) { res.status(404).json({ error: 'Not found' }); return; }

      const username = req.user!.unixUsername;

      // Kill all tmux sessions for this project — via agent if connected
      for (const wf of project.workflows) {
        const mainRole = wf.type === 'agent' ? 'agent' as const : 'data' as const;
        const ctrlRole = wf.type === 'agent' ? 'ctrl' as const : 'data-ctrl' as const;
        const mainSession = tmux.sessionName(username, project.name, mainRole);
        const ctrlSession = tmux.sessionName(username, project.name, ctrlRole);

        if (isAgentConnected(req.user!.id)) {
          await sendToAgent(req.user!.id, 'tmux-kill', { sessionName: mainSession }).catch(() => {});
          await sendToAgent(req.user!.id, 'tmux-kill', { sessionName: ctrlSession }).catch(() => {});
        } else {
          await tmux.killSession(mainSession);
          await tmux.killSession(ctrlSession);
        }
      }

      // Delete workflows from DB
      await prisma.workflow.deleteMany({ where: { projectId: project.id } });

      // Mark as archived (keep record + directory + browser tabs)
      await prisma.project.update({
        where: { id: project.id },
        data: { archived: true },
      });

      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to archive project' });
    }
  };

  const addWorkflow: RequestHandler = async (req, res) => {
    try {
      const { type } = req.body as { type: WorkflowType };
      if (!['agent', 'data'].includes(type)) {
        res.status(400).json({ error: 'type must be agent or data' });
        return;
      }

      const project = await prisma.project.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

      const workflow = await prisma.workflow.create({
        data: { projectId: project.id, type },
      });

      const mainRole = type === 'agent' ? 'agent' as const : 'data' as const;
      const ctrlRole = type === 'agent' ? 'ctrl' as const : 'data-ctrl' as const;
      const mainSession = tmux.sessionName(req.user!.unixUsername, project.name, mainRole);
      const ctrlSession = tmux.sessionName(req.user!.unixUsername, project.name, ctrlRole);

      // Ensure project directory exists and (re)create tmux sessions there
      // Ensure project directory and tmux sessions — via agent if connected, else direct
      const projDir = tmux.projectDir(req.user!.unixUsername, project.name);

      if (isAgentConnected(req.user!.id)) {
        await sendToAgent(req.user!.id, 'tmux-create', { sessionName: mainSession, cwd: projDir });
        await sendToAgent(req.user!.id, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });
        if (type === 'agent') {
          await new Promise(resolve => setTimeout(resolve, 500));
          await sendToAgent(req.user!.id, 'tmux-send-keys', { sessionName: mainSession, keys: 'claude', withEnter: true });
        }
      } else {
        // Fallback: direct execution (backwards compat when no agent)
        await tmux.ensureProjectDir(req.user!.unixUsername, project.name);
        const mainCreated = await tmux.ensureSession(mainSession, projDir);
        await tmux.ensureSession(ctrlSession, projDir);
        if (type === 'agent' && mainCreated) {
          await new Promise(resolve => setTimeout(resolve, 500));
          await tmux.sendKeys(mainSession, 'claude');
        }
      }

      res.status(201).json(workflow);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'P2002') {
        res.status(409).json({ error: 'Workflow type already exists for this project' });
        return;
      }
      res.status(500).json({ error: 'Failed to create workflow' });
    }
  };

  const removeWorkflow: RequestHandler = async (req, res) => {
    try {
      const type = req.params.type as WorkflowType;
      const project = await prisma.project.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

      await prisma.workflow.deleteMany({ where: { projectId: project.id, type } });

      const mainRole = type === 'agent' ? 'agent' as const : 'data' as const;
      const ctrlRole = type === 'agent' ? 'ctrl' as const : 'data-ctrl' as const;
      await tmux.killSession(tmux.sessionName(req.user!.unixUsername, project.name, mainRole));
      await tmux.killSession(tmux.sessionName(req.user!.unixUsername, project.name, ctrlRole));

      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to delete workflow' });
    }
  };

  router.get('/', requireAuth, list);
  router.post('/', requireAuth, create);
  router.put('/:id', requireAuth, update);
  router.post('/:id/archive', requireAuth, archive);
  router.post('/:id/workflows', requireAuth, addWorkflow);
  router.delete('/:id/workflows/:type', requireAuth, removeWorkflow);

  return router;
}
