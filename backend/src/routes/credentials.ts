import { Router } from 'express';
import { prisma } from '../db';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { getClaudeGatewayConfig } from '../services/claudeGateway';
import { deleteCredentials, getCredentialStoreConfig, githubStoreDeps, readGithubOrgAccess } from '../services/credentialStore';
import { deliverToUserBoxes } from '../services/credentialDelivery';
import { connectGithub, CredentialInputError, recheckGithub } from '../services/githubCredential';
import { boxGateState, readBoxCreationFacts } from '../services/boxCreationGate';
import { getFireworksGatewayConfig } from '../services/fireworksGateway';
import {
  connectFireworksKey, FIREWORKS_PROVIDER, fireworksStoreDeps, readFireworksKeyStatus, revalidateFireworksKey,
  type FireworksKeyStatus,
} from '../services/fireworksKey';
import { boolVariation } from '../services/featureFlags';

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
    const fireworksAvailable = cfg !== null && getFireworksGatewayConfig() !== null;
    let fireworksKey: FireworksKeyStatus | null = null;
    let fireworksUnreadable = false;
    if (fireworksAvailable && cfg && user.credentials.some(c => c.provider === FIREWORKS_PROVIDER)) {
      try {
        fireworksKey = await readFireworksKeyStatus(cfg, req.user!.id);
        fireworksUnreadable = fireworksKey === null;
        // So a key Fireworks stopped accepting shows as invalid on a later load.
        if (fireworksKey && !fireworksKey.invalid) void revalidateFireworksKey(req.user!.id);
      } catch {
        console.warn('[CRED] could not read the stored Fireworks key');
        fireworksUnreadable = true;
      }
    }
    res.json({
      claudeGateway: { available: getClaudeGatewayConfig() !== null, enabled: user.claudeGatewayEnabled },
      github: {
        available: cfg !== null,
        connected: github ? { label: github.label, updatedAt: github.updatedAt, orgs } : null,
        boxGate: boxGateState(await readBoxCreationFacts(req.user!)),
      },
      fireworks: {
        available: fireworksAvailable,
        required: fireworksAvailable && await boolVariation('fireworks-own-key-required-enabled', req.user!, false),
        key: fireworksKey,
        unreadable: fireworksUnreadable,
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

  router.put('/fireworks', asyncHandler(async (req, res) => {
    const cfg = getCredentialStoreConfig();
    if (!cfg) {
      res.status(503).json({ error: STORE_OFF });
      return;
    }
    if (!getFireworksGatewayConfig()) {
      res.status(503).json({ error: 'Fireworks is not set up on this orchestrator.' });
      return;
    }
    try {
      const stored = await connectFireworksKey(req.body?.key, fireworksStoreDeps(cfg, req.user!.id));
      res.json({ owner: stored.owner, account: stored.accountName ?? stored.accountId, expireTime: stored.expireTime });
    } catch (err) {
      if (err instanceof CredentialInputError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  }));

  // Deletes termag's copy only: the key keeps working in Fireworks until it is deleted there.
  router.delete('/fireworks', asyncHandler(async (req, res) => {
    await deleteCredentials(req.user!.id, [FIREWORKS_PROVIDER]);
    res.status(204).end();
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
