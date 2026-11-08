import { describe, expect, it, vi } from 'vitest';
import { chatNoticesFor } from './chatNotices';
import { assertSessionAccess, SessionAccessError } from '../services/sessionAccess';
import { listChatNotices } from '../services/chatNotices';

vi.mock('../db', () => ({ prisma: { workstream: { findUnique: vi.fn(async ({ where }: any) => (where.projectId_name.name === 'main' ? { id: 'ws-main' } : null)) } } }));
vi.mock('../services/sessionAccess', () => {
  class SessionAccessError extends Error { constructor(public readonly status: 400 | 404, message: string) { super(message); } }
  return { SessionAccessError, assertSessionAccess: vi.fn() };
});
vi.mock('../services/chatNotices', () => ({ listChatNotices: vi.fn(async () => [{ id: 'n1', kind: 'tool-update', pane: 'agent', text: '[termag] x', at: '2026-11-04T03:12:00.000Z' }]) }));

describe('GET /api/projects/:id/chat/notices', () => {
  it('answers the chat\'s notices to anyone who may read its sessions (the owner, or a sharee)', async () => {
    vi.mocked(assertSessionAccess).mockResolvedValueOnce({ isOwner: false } as never);
    const r = await chatNoticesFor('sharee', 'p1', { workstream: 'main' });
    expect(r).toEqual({ status: 200, body: { notices: [{ id: 'n1', kind: 'tool-update', pane: 'agent', text: '[termag] x', at: '2026-11-04T03:12:00.000Z' }] } });
    expect(assertSessionAccess).toHaveBeenLastCalledWith('sharee', 'p1', 'agent', 'main');
    expect(listChatNotices).toHaveBeenCalledWith('ws-main');
  });

  it('is a 404 for anyone else, and reads no notices', async () => {
    vi.mocked(listChatNotices).mockClear();
    vi.mocked(assertSessionAccess).mockRejectedValueOnce(new SessionAccessError(404, 'Project not found'));
    expect(await chatNoticesFor('stranger', 'p1', {})).toEqual({ status: 404, body: { error: 'Project not found' } });
    expect(assertSessionAccess).toHaveBeenLastCalledWith('stranger', 'p1', 'agent', 'main');
    expect(listChatNotices).not.toHaveBeenCalled();
  });

  it('refuses a workstream name too long to be one', async () => {
    expect((await chatNoticesFor('u', 'p1', { workstream: 'x'.repeat(201) })).status).toBe(400);
  });
});
