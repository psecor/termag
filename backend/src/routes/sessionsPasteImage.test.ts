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
const noteBoxActivity = vi.fn();
vi.mock('../services/boxActivity', () => ({ noteBoxActivity: (...a: unknown[]) => noteBoxActivity(...a) }));

const { pasteImageFor, sessionsRouter, PASTE_IMAGE_MAX_BYTES } = await import('./sessions');
const { sessionName } = await import('../services/tmux');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pixels')]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

// A distinct clock per test, so the 2s per-caller budget never leaks between them.
let clock = 1_000_000;
const tick = () => (clock += 10_000);

beforeEach(() => {
  sendForProject.mockReset().mockResolvedValue({ ok: true });
  isProjectAgentConnected.mockReset().mockReturnValue(true);
  noteBoxActivity.mockReset();
});

describe('pasteImageFor', () => {
  it("forwards the PNG as base64 to the owner's agent over clipboard-paste-image", async () => {
    const r = await pasteImageFor('owner', 'p1', 'agent', 'ws2', PNG, 'browser', tick());
    expect(r).toEqual({ status: 200, body: { ok: true } });
    expect(sendForProject).toHaveBeenCalledTimes(1);
    const [host, type, payload, timeout] = sendForProject.mock.calls[0];
    expect(host).toEqual({ userId: 'owner', instanceId: 'box-1' });
    expect(type).toBe('clipboard-paste-image');
    expect(payload).toEqual({ sessionName: sessionName('ada', 'proj', 'agent', 'ws2'), data: PNG.toString('base64') });
    expect(timeout).toBeGreaterThan(10_000);
    // Human input, like send-keys: it keeps the box awake.
    expect(noteBoxActivity).toHaveBeenCalledWith('box-1');
  });

  it('defaults to the main workstream and takes a collaborator and the ctrl / review panes', async () => {
    const now = tick();
    expect((await pasteImageFor('collab', 'p1', 'ctrl', undefined, PNG, 'browser', now)).status).toBe(200);
    expect(sendForProject.mock.calls[0][2].sessionName).toBe(sessionName('ada', 'proj', 'ctrl', 'main'));
    expect((await pasteImageFor('collab', 'p1', 'review', '', PNG, 'browser', now)).status).toBe(200);
    expect(sendForProject.mock.calls[1][2].sessionName).toBe(sessionName('ada', 'proj', 'review', 'main'));
  });

  it('denies like send-keys: 404 for a stranger, an unknown project or workstream; 400 for a bad role', async () => {
    const now = tick();
    expect(await pasteImageFor('mallory', 'p1', 'agent', 'main', PNG, 'browser', now))
      .toEqual({ status: 404, body: { error: 'Project not found' } });
    expect((await pasteImageFor('owner', 'nope', 'agent', 'main', PNG, 'browser', now)).status).toBe(404);
    expect(await pasteImageFor('owner', 'p1', 'agent', 'gone', PNG, 'browser', now))
      .toEqual({ status: 404, body: { error: 'Workstream not found' } });
    expect((await pasteImageFor('owner', 'p1', 'shell', 'main', PNG, 'browser', now)).status).toBe(400);
    expect(sendForProject).not.toHaveBeenCalled();
    expect(noteBoxActivity).not.toHaveBeenCalled();
  });

  it('validates the body before anything else: 400 for none or not a PNG, 413 over 20 MiB', async () => {
    const now = tick();
    for (const body of [{}, undefined, Buffer.alloc(0), JPEG, PNG.subarray(0, 4)]) {
      expect((await pasteImageFor('owner', 'p1', 'agent', 'main', body, 'browser', now)).status).toBe(400);
    }
    const big = Buffer.concat([PNG, Buffer.alloc(PASTE_IMAGE_MAX_BYTES)]);
    expect(await pasteImageFor('owner', 'p1', 'agent', 'main', big, 'browser', now))
      .toEqual({ status: 413, body: { error: 'Image too large (max 20 MiB)' } });
    // Exactly at the limit is fine.
    const atLimit = Buffer.concat([PNG, Buffer.alloc(PASTE_IMAGE_MAX_BYTES - PNG.length)]);
    expect((await pasteImageFor('owner', 'p1', 'agent', 'main', atLimit, 'browser', now)).status).toBe(200);
  });

  it('answers 501 when the agent predates the RPC', async () => {
    sendForProject.mockRejectedValueOnce(new Error('Unknown command: clipboard-paste-image'));
    expect(await pasteImageFor('owner', 'p1', 'agent', 'main', PNG, 'browser', tick()))
      .toEqual({ status: 501, body: { error: 'This box needs an update to take images' } });
  });

  it('answers 503 when the agent is offline or the paste fails on the box', async () => {
    isProjectAgentConnected.mockReturnValueOnce(false);
    expect(await pasteImageFor('owner', 'p1', 'agent', 'main', PNG, 'browser', tick()))
      .toEqual({ status: 503, body: { error: "Owner's agent is offline" } });
    expect(sendForProject).not.toHaveBeenCalled();
    sendForProject.mockRejectedValueOnce(new Error("can't find session: =ada-proj-agent"));
    expect(await pasteImageFor('owner', 'p1', 'agent', 'main', PNG, 'browser', tick()))
      .toEqual({ status: 503, body: { error: "paste-image failed: can't find session: =ada-proj-agent" } });
  });

  it('rate-limits one image per 2s per caller and session', async () => {
    const now = tick();
    expect((await pasteImageFor('owner', 'p1', 'agent', 'main', PNG, 'browser', now)).status).toBe(200);
    expect((await pasteImageFor('owner', 'p1', 'agent', 'main', PNG, 'browser', now + 1_500)).status).toBe(429);
    // Another pane, and another caller (a box token), have their own budget.
    expect((await pasteImageFor('owner', 'p1', 'ctrl', 'main', PNG, 'browser', now + 1_500)).status).toBe(200);
    expect((await pasteImageFor('owner', 'p1', 'agent', 'main', PNG, 'box-1', now + 1_500)).status).toBe(200);
    expect((await pasteImageFor('owner', 'p1', 'agent', 'main', PNG, 'browser', now + 2_000)).status).toBe(200);
  });
});

// Over HTTP, behind the app-wide express.json() exactly as index.ts mounts it,
// to pin the body handling: raw image/png reaches the route, anything else does not.
describe('POST /api/projects/:id/sessions/:role/paste-image', () => {
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

  const post = (body: Buffer | string, contentType: string, user = 'owner', ws = 'main') =>
    fetch(`${base}/termag/api/projects/p1/sessions/agent/paste-image?workstream=${ws}`, {
      method: 'POST', headers: { 'content-type': contentType, 'x-test-user': user }, body,
    });

  it('takes a raw image/png body well past the JSON parser’s 100kb default', async () => {
    const img = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024, 7)]);
    const res = await post(img, 'image/png', 'owner', 'ws2');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendForProject.mock.calls[0][2]).toEqual({
      sessionName: sessionName('ada', 'proj', 'agent', 'ws2'), data: img.toString('base64'),
    });
  });

  it('refuses another content type with 400, and a stranger with 404', async () => {
    const jpeg = await post(JPEG, 'image/jpeg', 'owner', 'ws2');
    expect(jpeg.status).toBe(400);
    expect(await jpeg.json()).toEqual({ error: 'Send the image as the request body with Content-Type: image/png' });
    expect((await post('{"data":"x"}', 'application/json', 'owner', 'ws2')).status).toBe(400);
    expect((await post(PNG, 'image/png', 'mallory', 'ws2')).status).toBe(404);
    expect(sendForProject).not.toHaveBeenCalled();
  });

  it('answers 413 as JSON for a body over the parser limit too', async () => {
    const res = await post(Buffer.alloc(22 * 1024 * 1024), 'image/png', 'owner', 'ws2');
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'Image too large (max 20 MiB)' });
  });
});
