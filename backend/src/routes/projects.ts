import { Router, RequestHandler } from 'express';
import { AgentProvider, PrismaClient, WorkflowType } from '@prisma/client';
import { requireAuth } from '../middleware/auth';
import * as tmux from '../services/tmux';
import { isAgentConnected, sendToAgent } from '../services/agentRegistry';
import { deleteStatus, setStatus, notifyStatusChange } from '../services/status';
import { createProjectChannel } from '../slack/channels';
import { rename } from 'fs/promises';
import { ensureAgentSessionsAndLaunch, resolveAgentProvider, stopAgentSessions } from '../services/agentRuntime';

const prisma = new PrismaClient();

export function projectsRouter(): Router {
  const router = Router();

  function normalizeProvider(provider?: AgentProvider | null, fallback?: AgentProvider | null): AgentProvider {
    if (provider === 'claude' || provider === 'codex') return provider;
    return resolveAgentProvider(undefined, fallback);
  }

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
      const { name, description, color, initialAgent } = req.body as {
        name?: string;
        description?: string;
        color?: string;
        initialAgent?: { enabled?: boolean; provider?: AgentProvider };
      };
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
        if (initialAgent?.enabled && !archived.workflows.some(w => w.type === 'agent')) {
          const provider = normalizeProvider(initialAgent.provider, req.user!.defaultAgentProvider);
          await prisma.workflow.create({
            data: { projectId: archived.id, type: 'agent', provider },
          });
          await ensureAgentSessionsAndLaunch({
            userId: req.user!.id,
            unixUsername: req.user!.unixUsername,
            projectName: name,
            provider,
          });
        }

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

      const provider = initialAgent?.enabled
        ? normalizeProvider(initialAgent.provider, req.user!.defaultAgentProvider)
        : null;

      const project = await prisma.project.create({
        data: {
          name,
          description,
          color,
          userId: req.user!.id,
          workflows: initialAgent?.enabled
            ? { create: { type: 'agent', provider: provider! } }
            : undefined,
        },
        include: { workflows: true },
      });

      try {
        if (provider) {
          await ensureAgentSessionsAndLaunch({
            userId: req.user!.id,
            unixUsername: req.user!.unixUsername,
            projectName: name,
            provider,
          });
        }
      } catch (err) {
        await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
        throw err;
      }

      // Create Slack channel (fire-and-forget, non-blocking)
      createProjectChannel(name, req.user!.slackUserId ?? undefined).then(channelId => {
        if (channelId) {
          prisma.project.update({
            where: { id: project.id },
            data: { slackChannelId: channelId },
          }).catch(err => console.error('[PROJECTS] Failed to save channel ID:', err.message));
        }
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
        if (wf.type === 'agent') {
          await stopAgentSessions({
            userId: req.user!.id,
            unixUsername: username,
            projectName: project.name,
            provider: resolveAgentProvider(wf.provider, req.user!.defaultAgentProvider),
          });
        } else {
          await tmux.killSession(tmux.sessionName(username, project.name, 'data'));
          await tmux.killSession(tmux.sessionName(username, project.name, 'data-ctrl'));
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
      const { type, provider: providerInput } = req.body as {
        type: WorkflowType;
        provider?: AgentProvider;
      };
      if (!['agent', 'data'].includes(type)) {
        res.status(400).json({ error: 'type must be agent or data' });
        return;
      }
      if (type === 'data' && providerInput) {
        res.status(400).json({ error: 'provider is only valid for agent workflows' });
        return;
      }

      const project = await prisma.project.findFirst({ where: { id: req.params.id, userId: req.user!.id } });
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }

      const provider = type === 'agent'
        ? normalizeProvider(providerInput, req.user!.defaultAgentProvider)
        : null;

      const workflow = await prisma.workflow.create({
        data: { projectId: project.id, type, provider },
      });

      try {
        if (type === 'agent') {
          await ensureAgentSessionsAndLaunch({
            userId: req.user!.id,
            unixUsername: req.user!.unixUsername,
            projectName: project.name,
            provider: provider!,
          });
        } else {
          const mainSession = tmux.sessionName(req.user!.unixUsername, project.name, 'data');
          const ctrlSession = tmux.sessionName(req.user!.unixUsername, project.name, 'data-ctrl');
          const projDir = tmux.projectDir(req.user!.unixUsername, project.name);

          if (isAgentConnected(req.user!.id)) {
            await sendToAgent(req.user!.id, 'tmux-create', { sessionName: mainSession, cwd: projDir });
            await sendToAgent(req.user!.id, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });
          } else {
            await tmux.ensureProjectDir(req.user!.unixUsername, project.name);
            await tmux.ensureSession(mainSession, projDir);
            await tmux.ensureSession(ctrlSession, projDir);
          }
        }
      } catch (err) {
        await prisma.workflow.delete({ where: { id: workflow.id } }).catch(() => {});
        throw err;
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
      const project = await prisma.project.findFirst({
        where: { id: req.params.id, userId: req.user!.id },
        include: { workflows: true },
      });
      if (!project) { res.status(404).json({ error: 'Project not found' }); return; }
      const workflow = project.workflows.find(w => w.type === type);
      const provider = normalizeProvider(workflow?.provider, req.user!.defaultAgentProvider);

      await prisma.workflow.deleteMany({ where: { projectId: project.id, type } });

      if (type === 'agent') {
        await stopAgentSessions({
          userId: req.user!.id,
          unixUsername: req.user!.unixUsername,
          projectName: project.name,
          provider,
        });
      } else {
        await tmux.killSession(tmux.sessionName(req.user!.unixUsername, project.name, 'data'));
        await tmux.killSession(tmux.sessionName(req.user!.unixUsername, project.name, 'data-ctrl'));
      }

      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to delete workflow' });
    }
  };

  const renameProject: RequestHandler = async (req, res) => {
    try {
      const { name: newName } = req.body;
      if (!newName) { res.status(400).json({ error: 'name required' }); return; }

      if (!/^[a-zA-Z0-9_-]+$/.test(newName)) {
        res.status(400).json({ error: 'name must be alphanumeric with dashes/underscores only' });
        return;
      }

      const project = await prisma.project.findFirst({
        where: { id: req.params.id, userId: req.user!.id },
        include: { workflows: true },
      });
      if (!project) { res.status(404).json({ error: 'Not found' }); return; }

      const oldName = project.name;
      if (oldName === newName) { res.json({ ok: true }); return; }

      const username = req.user!.unixUsername;
      const providerRestarts: Array<{ projectName: string; provider: AgentProvider }> = [];

      // Rename tmux sessions
      for (const wf of project.workflows) {
        const roles: Array<'agent' | 'ctrl' | 'data' | 'data-ctrl'> = wf.type === 'agent'
          ? ['agent', 'ctrl'] : ['data', 'data-ctrl'];
        const provider = resolveAgentProvider(wf.provider, req.user!.defaultAgentProvider);
        if (wf.type === 'agent' && provider === 'codex' && isAgentConnected(req.user!.id)) {
          await sendToAgent(req.user!.id, 'codex-session-stop', {
            sessionName: tmux.sessionName(username, oldName, 'agent'),
          }).catch(() => {});
        }
        for (const role of roles) {
          const oldSession = tmux.sessionName(username, oldName, role);
          const newSession = tmux.sessionName(username, newName, role);
          try {
            await tmux.renameSession(oldSession, newSession);
          } catch { /* session may not exist */ }
          // Migrate status entry
          deleteStatus(oldSession);
          setStatus(newSession, 'idle');
          notifyStatusChange(newSession);
        }
        if (wf.type === 'agent' && isAgentConnected(req.user!.id)) {
          providerRestarts.push({
            projectName: newName,
            provider,
          });
        }
      }

      // Rename project directory
      const oldDir = tmux.projectDir(username, oldName);
      const newDir = tmux.projectDir(username, newName);
      try {
        await rename(oldDir, newDir);
      } catch { /* dir may not exist yet */ }

      // Update DB
      await prisma.project.update({
        where: { id: project.id },
        data: { name: newName },
      });

      const updated = await prisma.project.findUnique({
        where: { id: project.id },
        include: { workflows: true },
      });
      for (const restart of providerRestarts) {
        if (restart.provider === 'codex') {
          await ensureAgentSessionsAndLaunch({
            userId: req.user!.id,
            unixUsername: username,
            projectName: restart.projectName,
            provider: restart.provider,
          }).catch(() => {});
        }
      }
      res.json(updated);
    } catch (err: unknown) {
      if ((err as { code?: string }).code === 'P2002') {
        res.status(409).json({ error: 'A project with that name already exists' });
        return;
      }
      res.status(500).json({ error: 'Failed to rename project' });
    }
  };

  router.get('/', requireAuth, list);
  router.post('/', requireAuth, create);
  router.put('/:id', requireAuth, update);
  router.post('/:id/rename', requireAuth, renameProject);
  router.post('/:id/archive', requireAuth, archive);
  router.post('/:id/workflows', requireAuth, addWorkflow);
  router.delete('/:id/workflows/:type', requireAuth, removeWorkflow);

  return router;
}
