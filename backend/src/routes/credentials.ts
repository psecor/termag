import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { getClaudeGatewayConfig } from '../services/claudeGateway';
import { deleteCredentials, getCredentialStoreConfig, githubStoreDeps, readGithubOrgAccess } from '../services/credentialStore';
import { deliverToUserBoxes } from '../services/credentialDelivery';
import { connectGithub, CredentialInputError, recheckGithub } from '../services/githubCredential';
import { boxGateState, readBoxCreationFacts } from '../services/boxCreationGate';

const STORE_OFF = 'The credential store is not configured on this orchestrator.';

// Settings page API for box credentials. No route returns a credential value.
export function credentialsRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.user!.id },
      select: { claudeGatewayEnabled: true, credentials: { select: { provider: true, label: true, updatedAt: true } } },
    });
    const github = user.credentials.find(c => c.provider === 'github') ?? null;
    const cfg = getCredentialStoreConfig();
    const orgs = github && cfg ? (await readGithubOrgAccess(req.user!.id)) ?? {} : {};
    res.json({
      claudeGateway: { available: getClaudeGatewayConfig() !== null, enabled: user.claudeGatewayEnabled },
      github: {
        available: cfg !== null,
        connected: github ? { label: github.label, updatedAt: github.updatedAt, orgs } : null,
        boxGate: boxGateState(await readBoxCreationFacts(req.user!)),
      },
    });
  }));

  router.put('/claude-gateway', asyncHandler(async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be true or false' });
      return;
    }
    const userId = req.user!.id;
    await prisma.user.update({ where: { id: userId }, data: { claudeGatewayEnabled: req.body.enabled } });
    void deliverToUserBoxes(userId);
    res.json({ enabled: req.body.enabled });
  }));

  router.put('/github', asyncHandler(async (req, res) => {
    const cfg = getCredentialStoreConfig();
    if (!cfg) {
      res.status(503).json({ error: STORE_OFF });
      return;
    }
    const user = req.user!;
    try {
      const connected = await connectGithub(req.body?.token, githubStoreDeps(cfg, user.id));
      void deliverToUserBoxes(user.id);
      res.json({ label: connected.label });
    } catch (err) {
      if (err instanceof CredentialInputError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  }));

  router.post('/github/recheck', asyncHandler(async (req, res) => {
    const cfg = getCredentialStoreConfig();
    if (!cfg) {
      res.status(503).json({ error: STORE_OFF });
      return;
    }
    try {
      await recheckGithub(githubStoreDeps(cfg, req.user!.id));
      res.status(204).end();
    } catch (err) {
      if (err instanceof CredentialInputError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  }));

  // A row delete: no KMS call, so it works with the store unconfigured.
  router.delete('/github', asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    await deleteCredentials(userId, ['github']);
    void deliverToUserBoxes(userId);
    res.status(204).end();
  }));

  return router;
}
