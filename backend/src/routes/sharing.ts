import { Router, RequestHandler } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth';

const prisma = new PrismaClient();

export function sharingRouter(): Router {
  const router = Router();

  // POST /api/projects/:id/invite — owner invites a user by email
  const invite: RequestHandler = async (req, res) => {
    const { id } = req.params;
    const { inviteeEmail } = req.body;
    if (!inviteeEmail || typeof inviteeEmail !== 'string') {
      res.status(400).json({ error: 'inviteeEmail is required' });
      return;
    }

    // Verify ownership
    const project = await prisma.project.findFirst({
      where: { id, userId: req.user!.id },
    });
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    // Find invitee
    const invitee = await prisma.user.findUnique({
      where: { googleEmail: inviteeEmail.trim().toLowerCase() },
    });
    if (!invitee) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    if (invitee.id === req.user!.id) {
      res.status(400).json({ error: 'Cannot invite yourself' });
      return;
    }

    // Check if already shared
    const existingShare = await prisma.projectShare.findUnique({
      where: { projectId_userId: { projectId: id, userId: invitee.id } },
    });
    if (existingShare) {
      res.status(409).json({ error: 'Already shared with this user' });
      return;
    }

    // Upsert invite (re-invite if previously declined)
    const invite = await prisma.projectInvite.upsert({
      where: { projectId_inviteeId: { projectId: id, inviteeId: invitee.id } },
      update: { status: 'pending', inviterId: req.user!.id },
      create: {
        projectId: id,
        inviterId: req.user!.id,
        inviteeId: invitee.id,
      },
    });

    res.status(201).json(invite);
  };

  // GET /api/invites — list pending invites for logged-in user
  const listInvites: RequestHandler = async (req, res) => {
    const invites = await prisma.projectInvite.findMany({
      where: { inviteeId: req.user!.id, status: 'pending' },
      include: {
        project: { select: { name: true } },
        inviter: { select: { displayName: true, unixUsername: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(invites.map(i => ({
      id: i.id,
      projectName: i.project.name,
      inviterName: i.inviter.displayName,
      inviterUsername: i.inviter.unixUsername,
      createdAt: i.createdAt.toISOString(),
    })));
  };

  // POST /api/invites/:id/accept
  const acceptInvite: RequestHandler = async (req, res) => {
    const invite = await prisma.projectInvite.findFirst({
      where: { id: req.params.id, inviteeId: req.user!.id, status: 'pending' },
    });
    if (!invite) {
      res.status(404).json({ error: 'Invite not found' });
      return;
    }

    await prisma.$transaction([
      prisma.projectInvite.update({
        where: { id: invite.id },
        data: { status: 'accepted' },
      }),
      prisma.projectShare.create({
        data: { projectId: invite.projectId, userId: req.user!.id },
      }),
    ]);

    res.json({ ok: true });
  };

  // POST /api/invites/:id/decline
  const declineInvite: RequestHandler = async (req, res) => {
    const invite = await prisma.projectInvite.findFirst({
      where: { id: req.params.id, inviteeId: req.user!.id, status: 'pending' },
    });
    if (!invite) {
      res.status(404).json({ error: 'Invite not found' });
      return;
    }

    await prisma.projectInvite.update({
      where: { id: invite.id },
      data: { status: 'declined' },
    });

    res.json({ ok: true });
  };

  // GET /api/projects/:id/shares — list active shares (owner only)
  const listShares: RequestHandler = async (req, res) => {
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const shares = await prisma.projectShare.findMany({
      where: { projectId: req.params.id },
      include: { user: { select: { displayName: true, unixUsername: true, googleEmail: true } } },
    });

    res.json(shares.map(s => ({
      id: s.id,
      userName: s.user.displayName,
      userEmail: s.user.googleEmail,
      unixUsername: s.user.unixUsername,
      createdAt: s.createdAt.toISOString(),
    })));
  };

  // DELETE /api/projects/:id/shares/:shareId — owner revokes a share
  const revokeShare: RequestHandler = async (req, res) => {
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    await prisma.projectShare.delete({
      where: { id: req.params.shareId },
    }).catch(() => {});

    res.json({ ok: true });
  };

  // DELETE /api/projects/:id/leave — collaborator leaves a shared project
  const leaveProject: RequestHandler = async (req, res) => {
    await prisma.projectShare.deleteMany({
      where: { projectId: req.params.id, userId: req.user!.id },
    });
    res.json({ ok: true });
  };

  // Mount routes
  router.post('/projects/:id/invite', requireAuth, invite);
  router.get('/invites', requireAuth, listInvites);
  router.post('/invites/:id/accept', requireAuth, acceptInvite);
  router.post('/invites/:id/decline', requireAuth, declineInvite);
  router.get('/projects/:id/shares', requireAuth, listShares);
  router.delete('/projects/:id/shares/:shareId', requireAuth, revokeShare);
  router.delete('/projects/:id/leave', requireAuth, leaveProject);

  return router;
}
