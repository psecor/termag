// The landing page behind albSessionBridge in okta mode, as index.ts mounts
// it (step 1): an Okta
// identity not in ALLOWED_USERS gets the bridge's 403, and no PreviewLinkCode
// is ever written for it (A2, SR18).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { albSessionBridge } from './auth';
import { verifyAlbIdentity } from '../auth/albOidc';
import { previewLandingRouter } from './previewLanding';
import { memoryHostStore } from '../services/previewHostTestStore';

vi.mock('../db', () => ({ prisma: { user: { findMany: vi.fn(async () => []), update: vi.fn(), create: vi.fn() } } }));
vi.mock('../auth/albOidc', () => ({ verifyAlbIdentity: vi.fn(), albVerifierConfigFromEnv: vi.fn() }));
vi.mock('./agentTokens', () => ({ validateAgentToken: vi.fn() }));
vi.mock('../services/hostSetup', () => ({ ensureHostSetup: vi.fn() }));

describe('the landing page in okta mode', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_MODE', 'okta');
    vi.stubEnv('ALLOWED_USERS', 'owner@example.com:owner');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it('gives an identity not in ALLOWED_USERS the bridge\'s 403, and writes no code', async () => {
    const mem = memoryHostStore();
    mem.addLink({ name: 'my-app' });
    vi.mocked(verifyAlbIdentity).mockResolvedValue({ email: 'stranger@example.com', sub: 's', name: 'Stranger' } as never);
    const app = express();
    app.use(albSessionBridge);
    app.use('/termag/previews', previewLandingRouter({
      store: mem.store, domain: () => 'previews.test', cookieSecret: () => Buffer.alloc(32, 1),
      flags: async () => ({ enabled: true, killSwitch: false }), allowed: () => true,
      user: (req) => (req.user ? { id: req.user.id, googleEmail: req.user.googleEmail } : null), boxStatus: async () => 'ready',
    }));
    const server = http.createServer(app);
    const port = await new Promise<number>(r => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)));
    try {
      const status = await new Promise<number>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/termag/previews/my-app', headers: { 'x-amzn-oidc-data': 'stub' } }, (res) => { res.resume(); resolve(res.statusCode!); }).on('error', reject);
      });
      expect(status).toBe(403);
      expect(mem.codes.size).toBe(0);
      expect(mem.events).toHaveLength(0);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
