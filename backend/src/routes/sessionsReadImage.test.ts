import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';

// One project, owned by `owner`, on box-1, shared with `collab`, with a second
// workstream. Anyone else gets the access helper's 404.
const project = {
  id: 'p1', name: 'proj', userId: 'owner', instanceId: 'box-1', archived: false,
  user: { id: 'owner', unixUsername: 'ada' },
  workstreams: [{ name: 'main' }, { name: 'ws2' }],
};
vi.mock('../db', () => ({
  prisma: {
    project: { findUnique: vi.fn(async ({ where }: any) => (where.id === project.id ? project : null)) },
    projectShare: {
      findUnique: vi.fn(async ({ where }: any) => (where.projectId_userId.userId === 'collab' ? { id: 's1' } : null)),
    },
  },
}));
vi.mock('../middleware/auth', () => ({
  requireAuthOrAgentToken: (req: any, _res: any, next: any) => { req.user = { id: req.headers['x-test-user'] }; next(); },
}));
const sendForProject = vi.fn();
const isProjectAgentConnected = vi.fn();
vi.mock('../services/agentRegistry', () => ({
  sendForProject: (...a: unknown[]) => sendForProject(...a),
  isProjectAgentConnected: (...a: unknown[]) => isProjectAgentConnected(...a),
}));
vi.mock('../services/boxActivity', () => ({ noteBoxActivity: vi.fn() }));

const { readImageFor, sessionsRouter } = await import('./sessions');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
const SHOT = '/tmp/claude-1001/scratchpad/pw/2-palette-b.png';

beforeEach(() => {
  sendForProject.mockReset().mockResolvedValue({ ok: true, mime: 'image/png', data: PNG.toString('base64'), size: PNG.length });
  isProjectAgentConnected.mockReset().mockReturnValue(true);
});

describe('readImageFor', () => {
  it("asks the owner's agent for the file and hands back its bytes", async () => {
    const r = await readImageFor('owner', 'p1', 'ws2', SHOT);
    expect(r).toEqual({ status: 200, mime: 'image/png', image: PNG });
    const [host, type, payload] = sendForProject.mock.calls[0];
    expect(host).toEqual({ userId: 'owner', instanceId: 'box-1' });
    expect(type).toBe('read-image');
    expect(payload).toEqual({ path: SHOT });
  });

  it('lets a collaborator read, and gives a stranger, an unknown project or workstream 404', async () => {
    expect((await readImageFor('collab', 'p1', undefined, SHOT)).status).toBe(200);
    expect((await readImageFor('mallory', 'p1', 'main', SHOT)).status).toBe(404);
    expect((await readImageFor('owner', 'nope', 'main', SHOT)).status).toBe(404);
    expect((await readImageFor('owner', 'p1', 'gone', SHOT)).status).toBe(404);
    expect(sendForProject).toHaveBeenCalledTimes(1);
  });

  it('refuses a missing, relative or overlong path without asking the box', async () => {
    expect((await readImageFor('owner', 'p1', 'main', undefined)).status).toBe(400);
    expect((await readImageFor('owner', 'p1', 'main', ['/a.png', '/b.png'])).status).toBe(400);
    expect(await readImageFor('owner', 'p1', 'main', 'shots/a.png'))
      .toEqual({ status: 400, body: { error: 'path must be absolute' } });
    expect((await readImageFor('owner', 'p1', 'main', `/${'a'.repeat(5000)}.png`)).status).toBe(400);
    expect((await readImageFor('owner', 'p1', 'main', '~/shots/a.png')).status).toBe(200);
    expect(sendForProject).toHaveBeenCalledTimes(1);
  });

  it('maps the agent answers: no file 404, not an image 415, too large 413, old box 501, offline 503', async () => {
    sendForProject.mockResolvedValueOnce({ ok: true, data: null });
    expect((await readImageFor('owner', 'p1', 'main', SHOT)).status).toBe(404);
    sendForProject.mockRejectedValueOnce(new Error('not an image'));
    expect((await readImageFor('owner', 'p1', 'main', SHOT)).status).toBe(415);
    sendForProject.mockRejectedValueOnce(new Error('image too large (limit 10485760 bytes)'));
    expect((await readImageFor('owner', 'p1', 'main', SHOT)).status).toBe(413);
    sendForProject.mockRejectedValueOnce(new Error('Unknown command: read-image'));
    expect(await readImageFor('owner', 'p1', 'main', SHOT))
      .toEqual({ status: 501, body: { error: 'This box needs an update to preview images' } });
    isProjectAgentConnected.mockReturnValueOnce(false);
    expect((await readImageFor('owner', 'p1', 'main', SHOT)).status).toBe(503);
  });

  it('never passes on a type outside the raster allowlist, whatever the agent says', async () => {
    sendForProject.mockResolvedValueOnce({ ok: true, mime: 'image/svg+xml', data: 'PHN2Zz4=' });
    expect((await readImageFor('owner', 'p1', 'main', SHOT)).status).toBe(502);
  });

  it('caps the reads one user has in flight, and frees the slot when each settles', async () => {
    const pending: Array<() => void> = [];
    sendForProject.mockImplementation(() => new Promise(resolve => {
      pending.push(() => resolve({ ok: true, mime: 'image/png', data: PNG.toString('base64') }));
    }));
    const reads = [1, 2, 3, 4].map(() => readImageFor('owner', 'p1', 'main', SHOT));
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    expect((await readImageFor('owner', 'p1', 'main', SHOT)).status).toBe(429);
    // Someone else's budget is their own.
    reads.push(readImageFor('collab', 'p1', 'main', SHOT));
    await vi.waitFor(() => expect(pending).toHaveLength(5));
    pending.forEach(release => release());
    expect((await Promise.all(reads)).map(r => r.status)).toEqual([200, 200, 200, 200, 200]);
    sendForProject.mockResolvedValue({ ok: true, mime: 'image/png', data: PNG.toString('base64') });
    expect((await readImageFor('owner', 'p1', 'main', SHOT)).status).toBe(200);
  });
});

describe('GET /api/projects/:id/image', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/termag/api', sessionsRouter());
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  const get = (p: string, user = 'owner') =>
    fetch(`${base}/termag/api/projects/p1/image?workstream=main&path=${encodeURIComponent(p)}`, {
      headers: { 'x-test-user': user },
    });

  it('serves the bytes with the sniffed type, uncached and locked down', async () => {
    const res = await get(SHOT);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it('answers errors as JSON', async () => {
    const res = await get(SHOT, 'mallory');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Project not found' });
  });
});
