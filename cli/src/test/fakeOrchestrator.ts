import { createHash, randomBytes } from 'node:crypto';
import { handleAsk, newAskState, type FakeAskState } from './fakeAsk.js';
import { handleHandoff, newHandoffState, type FakeHandoffState } from './fakeHandoff.js';
import { handleDoctor, newDoctorState, type FakeDoctorState } from './fakeDoctor.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { advance, handleLifecycle, newLifecycleState, readJson, type FakeLifecycleState } from './fakeLifecycle.js';

/**
 * Just enough of the orchestrator's CLI surface (backend routes/cliApi.ts and
 * cliAuthorize.ts) to drive the CLI end to end, behind a stand-in for the ALB
 * rule that only lets access tokens through as a bearer. The authorize page
 * approves immediately, as if the person clicked Authorize.
 */
export interface FakeOrchestrator {
  host: string;
  /** Device (refresh) tokens. */
  tokens: Map<string, { deviceName: string; revoked: boolean }>;
  /** Access token → the device token it was minted from. */
  accessTokens: Map<string, string>;
  /** accessTokenExpiresIn for tokens minted from now on. */
  accessTtlS: number;
  boxTokens: Set<string>;
  /** `termag doctor`'s view: SSH keys, GitHub and the Claude gateway (fakeDoctor.ts). */
  doctor: FakeDoctorState;
  requests: Array<{ method: string; path: string; auth: string | null }>;
  /** Overrides for a path, e.g. to simulate an ALB redirect or an old orchestrator. */
  override: Map<string, (res: ServerResponse) => void>;
  lifecycle: FakeLifecycleState;
  ask: FakeAskState;
  handoff: FakeHandoffState;
  close: () => Promise<void>;
}

const USER = { email: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };

export const BOXES = [
  { id: 'i1', name: 'devbox', addressable: true, kind: 'ec2', state: 'running', status: 'ready', agentConnected: true, error: null, projects: [{ id: 'p1', name: 'webapp-fix' }] },
  { id: 'i2', name: 'old box', addressable: false, kind: 'ec2', state: 'stopped', status: 'stopped', agentConnected: false, error: null, projects: [] },
];

export const PROJECTS = [
  { id: 'p1', name: 'webapp-fix', ref: 'devbox/webapp-fix', box: { id: 'i1', name: 'devbox' }, provider: 'claude', status: 'waiting', waitingReason: 'approval', rateLimited: null, workstreams: ['main'] },
  { id: 'p2', name: 'flaky-test', ref: 'devbox/flaky-test', box: { id: 'i1', name: 'devbox' }, provider: 'codex', status: 'not_running', waitingReason: null, rateLimited: null, workstreams: ['main'] },
];

function sendJson(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) { res.writeHead(status).end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export async function startFakeOrchestrator(): Promise<FakeOrchestrator> {
  const codes = new Map<string, { challenge: string; deviceName: string }>();
  const fake = {
    tokens: new Map<string, { deviceName: string; revoked: boolean }>(),
    accessTokens: new Map<string, string>(),
    accessTtlS: 3600,
    boxTokens: new Set<string>(),
    doctor: newDoctorState(),
    requests: [] as FakeOrchestrator['requests'],
    override: new Map<string, (res: ServerResponse) => void>(),
    lifecycle: newLifecycleState(BOXES, PROJECTS),
    ask: newAskState(),
    handoff: newHandoffState(),
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname.replace(/^\/termag/, '');
    const auth = req.headers.authorization ?? null;
    fake.requests.push({ method: req.method ?? '', path, auth });
    const override = fake.override.get(path);
    if (override) { override(res); return; }

    if (path === '/auth/cli/authorize' && req.method === 'GET') {
      const port = url.searchParams.get('port');
      const code = randomBytes(16).toString('base64url');
      codes.set(code, { challenge: url.searchParams.get('code_challenge')!, deviceName: url.searchParams.get('device_name')! });
      res.writeHead(303, { Location: `http://127.0.0.1:${port}/callback?code=${code}&state=${url.searchParams.get('state')}` }).end();
      return;
    }
    if (!path.startsWith('/api/cli/v1/')) { res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html>SPA</html>'); return; }
    const route = `${req.method} ${path.slice('/api/cli/v1'.length)}`;

    const mintAccess = (device: string) => {
      const accessToken = 'eyJfake.' + randomBytes(16).toString('base64url') + '.sig';
      fake.accessTokens.set(accessToken, device);
      return { accessToken, accessTokenExpiresIn: fake.accessTtlS };
    };

    if (route === 'POST /token') {
      const body = await readBody(req);
      if (body.grant_type === 'refresh_token') {
        const device = fake.tokens.get(body.refresh_token as string);
        if (!device || device.revoked) { sendJson(res, 401, { error: 'Sign-in expired; run `termag login`', code: 'auth_required' }); return; }
        sendJson(res, 200, { ...mintAccess(body.refresh_token as string), expiresAt: '2026-10-09T00:00:00.000Z', maxExpiresAt: '2026-11-01T00:00:00.000Z' });
        return;
      }
      const grant = codes.get(body.code as string);
      codes.delete(body.code as string);
      const ok = grant && createHash('sha256').update(body.code_verifier as string).digest('base64url') === grant.challenge;
      if (!ok) { sendJson(res, 400, { error: 'Invalid or expired code', code: 'invalid_grant' }); return; }
      const token = 'tmcli_' + randomBytes(32).toString('hex');
      fake.tokens.set(token, { deviceName: grant.deviceName, revoked: false });
      sendJson(res, 201, {
        token, tokenPrefix: token.slice(0, 14) + '…', ...mintAccess(token), deviceName: grant.deviceName, user: USER,
        expiresAt: '2026-10-09T00:00:00.000Z', maxExpiresAt: '2026-11-01T00:00:00.000Z',
      });
      return;
    }

    const raw = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    // The ALB's jwt-validation action: a device token is not a JWT.
    if (raw.startsWith('tmcli_')) {
      res.writeHead(401, { 'Content-Type': 'text/html' }).end('<html><body><h1>401 Authorization Required</h1></body></html>');
      return;
    }
    const device = fake.tokens.get(fake.accessTokens.get(raw) ?? '');
    const isBox = fake.boxTokens.has(raw);
    if (!(device && !device.revoked) && !isBox) {
      sendJson(res, 401, { error: 'Unknown token; run `termag login`', code: 'auth_required' });
      return;
    }
    if (await handleDoctor(fake.doctor, route, req, !!device, res)) return;
    switch (route) {
      case 'GET /whoami':
        sendJson(res, 200, {
          user: USER,
          credential: device
            ? { kind: 'device', deviceName: device.deviceName, expiresAt: '2026-10-09T00:00:00.000Z', maxExpiresAt: '2026-11-01T00:00:00.000Z' }
            : { kind: 'box', boxId: 'i1' },
        });
        return;
      case 'DELETE /token':
        if (!device) { sendJson(res, 400, { error: 'box', code: 'box_credential' }); return; }
        device.revoked = true;
        sendJson(res, 204);
        return;
      case 'GET /boxes':
        advance(fake.lifecycle);
        sendJson(res, 200, { boxes: fake.lifecycle.boxes });
        return;
      case 'GET /projects':
        sendJson(res, 200, { projects: fake.lifecycle.projects });
        return;
      default: {
        const body = await readJson(req);
        if (handleAsk(fake.ask, route, url.searchParams, body, res)) return;
        if (handleHandoff(fake.handoff, route, body, res)) return;
        if (handleLifecycle(fake.lifecycle, route, body, isBox, res)) return;
        sendJson(res, 404, { error: 'No such CLI endpoint', code: 'not_found' });
      }
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  // The same object the server reads, so a test can change accessTtlS.
  return Object.assign(fake, {
    host: `http://127.0.0.1:${(server.address() as AddressInfo).port}/termag`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  });
}
