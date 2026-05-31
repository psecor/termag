import { Router, RequestHandler } from 'express';
import { PrismaClient, WorkflowType } from '@prisma/client';
import { PROVIDER_IDS } from '../providers/registry';
import { requireAuth, requireAuthOrAgentToken } from '../middleware/auth';
import * as tmux from '../services/tmux';
import {
  isAgentConnected,
  isProjectAgentConnected,
  sendForProject,
  sendToAgent,
} from '../services/agentRegistry';
import { deleteStatus, setStatus, notifyStatusChange } from '../services/status';
import { createProjectChannel } from '../slack/channels';
import { rename } from 'fs/promises';
import { ensureAgentSessionsAndLaunch, resolveAgentProvider, stopAgentSessions } from '../services/agentRuntime';

const prisma = new PrismaClient();

const VALID_CAPTURE_ROLES = ['agent', 'ctrl', 'data', 'data-ctrl'] as const;
type CaptureRole = typeof VALID_CAPTURE_ROLES[number];
const CAPTURE_MIN_INTERVAL_MS = 1000;
const captureRateLimits = new Map<string, number>();

export function projectsRouter(): Router {
  const router = Router();

  function normalizeProvider(provider?: string | null, fallback?: string | null): string {
    if (provider && PROVIDER_IDS.includes(provider)) return provider;
    return resolveAgentProvider(undefined, fallback);
  }

  const list: RequestHandler = async (req, res) => {
    try {
      // Owned projects: pinned first, then by most recently active
      const owned = await prisma.project.findMany({
        where: { userId: req.user!.id, archived: false },
        include: { workflows: true, user: { select: { unixUsername: true } } },
        orderBy: [{ pinned: 'desc' }, { name: 'asc' }],
      });

      // Shared projects (via ProjectShare)
      const shares = await prisma.projectShare.findMany({
        where: { userId: req.user!.id },
        include: {
          project: {
            include: { workflows: true, user: { select: { unixUsername: true } } },
          },
        },
      });

      const result = [
        ...owned.map(p => ({
          id: p.id, name: p.name, description: p.description, color: p.color,
          archived: p.archived, pinned: p.pinned, lastActiveAt: p.lastActiveAt,
          createdAt: p.createdAt, updatedAt: p.updatedAt,
          userId: p.userId, workflows: p.workflows,
          ownerUsername: p.user.unixUsername, role: 'owner' as const,
        })),
        ...shares
          .filter(s => !s.project.archived)
          .map(s => ({
            id: s.project.id, name: s.project.name, description: s.project.description,
            color: s.project.color, archived: s.project.archived,
            pinned: s.project.pinned, lastActiveAt: s.project.lastActiveAt,
            createdAt: s.project.createdAt, updatedAt: s.project.updatedAt,
            userId: s.project.userId, workflows: s.project.workflows,
            ownerUsername: s.project.user.unixUsername, role: 'collaborator' as const,
          })),
      ];

      res.json(result);
    } catch {
      res.status(500).json({ error: 'Failed to list projects' });
    }
  };

  const create: RequestHandler = async (req, res) => {
    try {
      const { name, description, color, initialAgent, instanceId } = req.body as {
        name?: string;
        description?: string;
        color?: string;
        initialAgent?: { enabled?: boolean; provider?: string };
        instanceId?: string | null;
      };
      if (!name) { res.status(400).json({ error: 'name required' }); return; }

      // Validate project name — safe for filesystem and tmux
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        res.status(400).json({ error: 'name must be alphanumeric with dashes/underscores only' });
        return;
      }

      // If a box was specified, confirm the caller owns it and it's live.
      // null/undefined means a legacy project (lives on the user's
      // legacy agent).
      if (instanceId) {
        const instance = await prisma.instance.findFirst({
          where: { id: instanceId, userId: req.user!.id },
        });
        if (!instance) {
          res.status(400).json({ error: 'instanceId not found or not owned by you' });
          return;
        }
        if (instance.status === 'terminated') {
          res.status(400).json({ error: 'cannot create a project on a terminated box' });
          return;
        }
      }
      const projectInstanceId = instanceId ?? null;

      // Check for archived project with same name — unarchive instead
      const archived = await prisma.project.findFirst({
        where: { userId: req.user!.id, name, archived: true },
        include: { workflows: true },
      });
      if (archived) {
        await prisma.project.update({
          where: { id: archived.id },
          data: { archived: false, description, color, instanceId: projectInstanceId },
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
            instanceId: projectInstanceId,
          });
        }

        const restored = await prisma.project.findUnique({
          where: { id: archived.id },
          include: { workflows: true },
        });
        res.status(200).json({ ...restored, restored: true });
        return;
      }

      // Create project directory + seed AGENTS.md — via the project's agent
      // (its box if pinned, else the user's legacy agent), else direct.
      const projDir = tmux.projectDir(req.user!.unixUsername, name);
      const projectHost = { userId: req.user!.id, instanceId: projectInstanceId };
      if (isProjectAgentConnected(projectHost)) {
        await sendForProject(projectHost, 'mkdir', { dir: projDir });
        // Fire-and-forget: seed wiki files (agent handles idempotency)
        sendForProject(projectHost, 'init-wiki', {
          dir: projDir, slug: name, username: req.user!.unixUsername,
        }).catch(() => {});
      } else if (!projectInstanceId) {
        // Legacy path: orchestrator host's own filesystem
        await tmux.ensureProjectDir(req.user!.unixUsername, name);
      } else {
        // Box-pinned project but the box's agent isn't connected. Fail loud.
        res.status(503).json({ error: 'Box agent is not connected' });
        return;
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
          instanceId: projectInstanceId,
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
            instanceId: projectInstanceId,
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
      console.error('[PROJECTS create]', err);
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

      // Kill all tmux sessions for this project — via the project's agent.
      for (const wf of project.workflows) {
        if (wf.type === 'agent') {
          await stopAgentSessions({
            userId: req.user!.id,
            unixUsername: username,
            projectName: project.name,
            provider: resolveAgentProvider(wf.provider, req.user!.defaultAgentProvider),
            instanceId: project.instanceId,
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
        provider?: string;
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
            instanceId: project.instanceId,
          });
        } else {
          const mainSession = tmux.sessionName(req.user!.unixUsername, project.name, 'data');
          const ctrlSession = tmux.sessionName(req.user!.unixUsername, project.name, 'data-ctrl');
          const projDir = tmux.projectDir(req.user!.unixUsername, project.name);
          const projectHost = { userId: req.user!.id, instanceId: project.instanceId };

          if (isProjectAgentConnected(projectHost)) {
            await sendForProject(projectHost, 'tmux-create', { sessionName: mainSession, cwd: projDir });
            await sendForProject(projectHost, 'tmux-create', { sessionName: ctrlSession, cwd: projDir });
          } else if (!project.instanceId) {
            await tmux.ensureProjectDir(req.user!.unixUsername, project.name);
            await tmux.ensureSession(mainSession, projDir);
            await tmux.ensureSession(ctrlSession, projDir);
          } else {
            throw new Error('Box agent not connected');
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
          instanceId: project.instanceId,
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
      const projectHost = { userId: req.user!.id, instanceId: project.instanceId };
      const providerRestarts: Array<{ projectName: string; provider: string }> = [];

      // Rename tmux sessions
      for (const wf of project.workflows) {
        const roles: Array<'agent' | 'ctrl' | 'data' | 'data-ctrl'> = wf.type === 'agent'
          ? ['agent', 'ctrl'] : ['data', 'data-ctrl'];
        const provider = resolveAgentProvider(wf.provider, req.user!.defaultAgentProvider);
        if (wf.type === 'agent' && provider === 'codex' && isProjectAgentConnected(projectHost)) {
          await sendForProject(projectHost, 'codex-session-stop', {
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
        if (wf.type === 'agent' && isProjectAgentConnected(projectHost)) {
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
            instanceId: project.instanceId,
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

  const togglePin: RequestHandler = async (req, res) => {
    try {
      const project = await prisma.project.findFirst({
        where: { id: req.params.id, userId: req.user!.id },
      });
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const updated = await prisma.project.update({
        where: { id: project.id },
        data: { pinned: !project.pinned },
      });
      res.json({ pinned: updated.pinned });
    } catch {
      res.status(500).json({ error: 'Failed to toggle pin' });
    }
  };

  // Capture pane content for a project session — works for projects you own
  // OR projects shared with you. Routes through the owner's agent so the
  // requester sees what's actually on screen for the owner's tmux.
  // Auth: session cookie OR Bearer agent token (so an agent on a user's box
  // can curl this directly).
  const capture: RequestHandler = async (req, res) => {
    const role = req.params.role as CaptureRole;
    if (!VALID_CAPTURE_ROLES.includes(role)) {
      res.status(400).json({ error: `role must be one of: ${VALID_CAPTURE_ROLES.join(', ')}` });
      return;
    }

    const requestedLines = parseInt(req.query.lines as string, 10);
    const lines = Number.isFinite(requestedLines)
      ? Math.max(1, Math.min(1000, requestedLines))
      : 200;

    const project = await prisma.project.findUnique({
      where: { id: req.params.id },
      include: { user: { select: { id: true, unixUsername: true } } },
    });
    if (!project || project.archived) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const requesterId = req.user!.id;
    const isOwner = project.userId === requesterId;
    if (!isOwner) {
      const share = await prisma.projectShare.findUnique({
        where: { projectId_userId: { projectId: project.id, userId: requesterId } },
      });
      if (!share) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
    }

    const sessionName = tmux.sessionName(project.user.unixUsername, project.name, role);

    const rateKey = `${requesterId}:${sessionName}`;
    const now = Date.now();
    const last = captureRateLimits.get(rateKey) ?? 0;
    if (now - last < CAPTURE_MIN_INTERVAL_MS) {
      res.status(429).json({ error: 'Rate limited (max 1 capture/sec per session)' });
      return;
    }
    captureRateLimits.set(rateKey, now);

    const ownerHost = { userId: project.userId, instanceId: project.instanceId };
    if (!isProjectAgentConnected(ownerHost)) {
      res.status(503).json({ error: "Owner's agent is offline" });
      return;
    }

    try {
      const result = await sendForProject(ownerHost, 'tmux-capture', { sessionName, lines });
      res.json({ session: sessionName, content: result.content ?? '' });
    } catch (err) {
      res.status(503).json({ error: `Capture failed: ${(err as Error).message}` });
    }
  };

  router.get('/', requireAuth, list);
  router.post('/', requireAuth, create);
  router.put('/:id', requireAuth, update);
  router.post('/:id/rename', requireAuth, renameProject);
  router.post('/:id/pin', requireAuth, togglePin);
  router.post('/:id/archive', requireAuth, archive);
  router.post('/:id/workflows', requireAuth, addWorkflow);
  router.delete('/:id/workflows/:type', requireAuth, removeWorkflow);
  router.get('/:id/sessions/:role/capture', requireAuthOrAgentToken, capture);

  return router;
}
