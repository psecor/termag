// PATCH /api/user-projects/:id and its archive plan:
// the body's rules, each box's fate, and the archive taking each checkout the way it is archived today.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  // The transaction sees the same project rows as the client, so a test's queued reads run in order.
  const project = { findMany: vi.fn(async (): Promise<unknown[]> => []), groupBy: vi.fn(async (): Promise<unknown[]> => []) };
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    userProject: { findFirst: vi.fn(async (): Promise<unknown> => null), update: vi.fn(async () => ({})) },
    project,
  };
  return {
    tx,
    prisma: {
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
      userProject: { findFirst: vi.fn(async (): Promise<unknown> => null), update: vi.fn(async () => ({})) },
      project,
    },
  };
});
vi.mock('../db', () => ({ prisma: db.prisma }));
const archives = vi.hoisted(() => ({
  archiveChatFor: vi.fn(async (): Promise<{ status: number; body: unknown }> => ({ status: 200, body: { archived: true, box: { action: null, reason: 'other projects still use this box' } } })),
  archiveOwnedProject: vi.fn(async (): Promise<{ status: number; body: unknown }> => ({ status: 200, body: { ok: true } })),
}));
vi.mock('./chats', () => ({ archiveChatFor: archives.archiveChatFor }));
vi.mock('./projects', () => ({ archiveOwnedProject: archives.archiveOwnedProject }));
const views = vi.hoisted(() => ({ userProjectViewFor: vi.fn(async (_u: string, id: string): Promise<unknown> => ({ id, name: 'termag' })) }));
vi.mock('../services/userProjectViews', () => views);

const { archivePlanFor, boxFates, checkoutKind, patchUserProjectFor, planPatch } = await import('./userProjectWrites');

const user = { id: 'u1', unixUsername: 'pat' } as Express.User;
const box = (id: string, over: Partial<{ kind: string; status: string }> = {}) => ({ id, name: id, kind: 'ec2', status: 'ready', ...over });
const chatWf = [{ type: 'agent', provider: 'claude-chat' }];
const labWf = [{ type: 'agent', provider: 'claude' }];
const checkoutRow = (id: string, workflows: typeof chatWf, instance: ReturnType<typeof box> | null, sessions = 1) =>
  ({ id, name: id, instance, workflows, _count: { workstreams: sessions } });

beforeEach(() => {
  vi.clearAllMocks();
  db.prisma.userProject.findFirst.mockResolvedValue({ id: 'up1', name: 'termag', nameKey: 'termag', archivedAt: null });
  db.tx.userProject.findFirst.mockResolvedValue(null);
  db.prisma.project.findMany.mockResolvedValue([]);
  db.prisma.project.groupBy.mockResolvedValue([]);
  archives.archiveChatFor.mockReset().mockResolvedValue({ status: 200, body: { archived: true, box: { action: null, reason: 'other projects still use this box' } } });
  archives.archiveOwnedProject.mockReset().mockResolvedValue({ status: 200, body: { ok: true } });
});

describe('planPatch', () => {
  it('takes a trimmed name, archived, or both', () => {
    expect(planPatch({ name: '  Termag web ' })).toEqual({ ok: true, name: { name: 'Termag web', nameKey: 'termag web' } });
    expect(planPatch({ archived: true })).toEqual({ ok: true, archived: true });
    expect(planPatch({ name: 'x', archived: false })).toEqual({ ok: true, name: { name: 'x', nameKey: 'x' }, archived: false });
  });

  it('refuses an empty, long or non-text name, a non-boolean archived, and nothing to change', () => {
    expect(planPatch({ name: '   ' })).toMatchObject({ ok: false, field: 'name' });
    expect(planPatch({ name: 'x'.repeat(61) })).toMatchObject({ ok: false, field: 'name' });
    expect(planPatch({ name: 'x'.repeat(60) }).ok).toBe(true);
    expect(planPatch({ name: 3 })).toMatchObject({ ok: false, field: 'name' });
    expect(planPatch({ archived: 'yes' })).toMatchObject({ ok: false, field: 'archived' });
    expect(planPatch({ filesSpace: ' ana-notes ' })).toEqual({ ok: true, filesSpace: 'ana-notes' });
    expect(planPatch({ filesSpace: '' })).toMatchObject({ ok: false, field: 'filesSpace' });
    expect(planPatch({ filesSpace: 7 })).toMatchObject({ ok: false, field: 'filesSpace' });
    // On its own, so a refused rename can't leave the files changed.
    expect(planPatch({ name: 'Beta', filesSpace: 'ana-notes' })).toMatchObject({ ok: false, field: 'filesSpace' });
    expect(planPatch({ archived: true, filesSpace: 'ana-notes' })).toMatchObject({ ok: false, field: 'filesSpace' });
    expect(planPatch({})).toMatchObject({ ok: false });
    expect(planPatch(null)).toMatchObject({ ok: false });
  });
});

describe('checkoutKind', () => {
  it("is a chat when its agent runs in the chat runner, else Lab's", () => {
    expect(checkoutKind(chatWf)).toBe('chat');
    expect(checkoutKind(labWf)).toBe('lab');
    expect(checkoutKind([])).toBe('lab');
  });
});

describe('boxFates', () => {
  const c = (projectId: string, kind: 'chat' | 'lab', b: ReturnType<typeof box> | null) => ({ projectId, name: projectId, kind, sessions: 1, box: b });

  it('stops a box nothing else runs on, keeps one other sessions use, and keeps a Lab session\'s', () => {
    const fates = boxFates([
      c('t1', 'chat', box('box-a')), c('t2', 'chat', box('box-a')),
      c('t3', 'chat', box('box-b')),
      c('t4', 'chat', box('box-c')), c('t5', 'lab', box('box-c')),
      c('t6', 'chat', null),
    ], id => (id === 'box-b' ? 2 : 0));
    expect(fates).toEqual([
      { boxId: 'box-a', boxName: 'box-a', fate: 'stops', why: 'nothing-else' },
      { boxId: 'box-b', boxName: 'box-b', fate: 'keeps', why: 'other-sessions' },
      { boxId: 'box-c', boxName: 'box-c', fate: 'keeps', why: 'lab-session' },
    ]);
  });

  it("keeps, saying why, a box the chat archive wouldn't power", () => {
    expect(boxFates([c('t1', 'chat', box('box-a', { status: 'stopped' }))], () => 0))
      .toEqual([{ boxId: 'box-a', boxName: 'box-a', fate: 'keeps', why: 'not-powered', detail: 'the box is already stopped' }]);
    expect(boxFates([c('t1', 'chat', box('host', { kind: 'manual' }))], () => 0)[0]).toMatchObject({ fate: 'keeps', why: 'not-powered' });
  });
});

describe('archivePlanFor', () => {
  it('lists the live checkouts, chats first, with their sessions and each box\'s fate', async () => {
    db.prisma.project.findMany.mockResolvedValue([
      checkoutRow('lab-1', labWf, box('box-c'), 2), checkoutRow('chat-1', chatWf, box('box-a'), 3), checkoutRow('chat-2', chatWf, box('box-b')),
    ]);
    db.prisma.project.groupBy.mockResolvedValue([{ instanceId: 'box-b', _count: 1 }]);
    const res = await archivePlanFor(user, 'up1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: 'up1', name: 'termag', archived: false, sessions: 6,
      checkouts: [
        { projectId: 'chat-1', kind: 'chat', sessions: 3, boxName: 'box-a' },
        { projectId: 'chat-2', kind: 'chat', sessions: 1, boxName: 'box-b' },
        { projectId: 'lab-1', kind: 'lab', sessions: 2, boxName: 'box-c' },
      ],
      boxes: [
        { boxName: 'box-a', fate: 'stops' }, { boxName: 'box-b', fate: 'keeps', why: 'other-sessions' }, { boxName: 'box-c', fate: 'keeps', why: 'lab-session' },
      ],
    });
    // Only the caller's own checkouts, and the others on those boxes leave the project's out.
    expect(db.prisma.project.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1', userProjectId: 'up1', archived: false } }));
    expect(db.prisma.project.groupBy).toHaveBeenCalledWith(expect.objectContaining({
      where: { instanceId: { in: ['box-a', 'box-b', 'box-c'] }, archived: false, id: { notIn: ['chat-1', 'chat-2', 'lab-1'] } },
    }));
  });

  it("answers 404 for someone else's project", async () => {
    db.prisma.userProject.findFirst.mockResolvedValue(null);
    expect((await archivePlanFor(user, 'up1')).status).toBe(404);
    expect(db.prisma.userProject.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'up1', userId: 'u1' } }));
  });
});

describe('patchUserProjectFor', () => {
  it('renames the project only, under the per-person lock, waiting as long as a backfill may hold it', async () => {
    const res = await patchUserProjectFor(user, 'up1', { name: 'Termag web' });
    expect(res.status).toBe(200);
    expect(db.tx.$executeRaw).toHaveBeenCalled();
    expect(db.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 10_000, timeout: 30_000 });
    expect(db.tx.userProject.update).toHaveBeenCalledWith({ where: { id: 'up1' }, data: { name: 'Termag web', nameKey: 'termag web' } });
    expect(db.prisma.project.findMany).not.toHaveBeenCalled();
    expect(archives.archiveChatFor).not.toHaveBeenCalled();
    expect(archives.archiveOwnedProject).not.toHaveBeenCalled();
  });

  it('says a taken name is taken, archived or not, and lets a change of case through', async () => {
    db.tx.userProject.findFirst.mockResolvedValueOnce({ id: 'up2', name: 'Docs', archivedAt: new Date() });
    const res = await patchUserProjectFor(user, 'up1', { name: 'docs' });
    expect(res).toEqual({ status: 409, body: expect.objectContaining({ code: 'user_project_name_taken', field: 'name', projectId: 'up2', archived: true }) });
    expect(db.tx.userProject.update).not.toHaveBeenCalled();
    expect(db.tx.userProject.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u1', nameKey: 'docs', id: { not: 'up1' } } }));
    expect((await patchUserProjectFor(user, 'up1', { name: 'Termag' })).status).toBe(200);
    expect(db.tx.userProject.update).toHaveBeenLastCalledWith({ where: { id: 'up1' }, data: { name: 'Termag', nameKey: 'termag' } });
  });

  it('answers 400 for a bad body and 404 for someone else\'s project, changing nothing', async () => {
    expect(await patchUserProjectFor(user, 'up1', { name: '' })).toMatchObject({ status: 400, body: { code: 'user_project_invalid', field: 'name' } });
    db.prisma.userProject.findFirst.mockResolvedValue(null);
    expect((await patchUserProjectFor(user, 'up1', { name: 'x' })).status).toBe(404);
    expect(db.tx.userProject.update).not.toHaveBeenCalled();
  });

  it('archives each chat checkout with the chat archive and each Lab one with the project archive, chats first, then the project', async () => {
    db.prisma.project.findMany.mockResolvedValueOnce([checkoutRow('lab-1', labWf, box('box-a')), checkoutRow('chat-1', chatWf, box('box-a')), checkoutRow('chat-2', chatWf, box('box-b'))]);
    const order: string[] = [];
    archives.archiveChatFor.mockImplementation(async (_u: unknown, id: unknown) => { order.push(String(id)); return { status: 200, body: { archived: true, box: { action: null } } }; });
    archives.archiveOwnedProject.mockImplementation(async (_u: unknown, id: unknown) => { order.push(String(id)); return { status: 200, body: { ok: true } }; });
    const res = await patchUserProjectFor(user, 'up1', { archived: true });
    expect(order).toEqual(['chat-1', 'chat-2', 'lab-1']);
    expect(res.status).toBe(200);
    expect((res.body as { archive: { archived: unknown[] } }).archive.archived.map(a => (a as { projectId: string }).projectId)).toEqual(['chat-1', 'chat-2', 'lab-1']);
    expect(db.tx.userProject.update).toHaveBeenCalledWith({ where: { id: 'up1' }, data: { archivedAt: expect.any(Date) } });
  });

  it('reports the boxes the chat archive stopped', async () => {
    db.prisma.project.findMany.mockResolvedValueOnce([checkoutRow('chat-1', chatWf, box('box-a'))]);
    archives.archiveChatFor.mockResolvedValueOnce({ status: 200, body: { archived: true, box: { action: 'stop', status: 'stopping' } } });
    const res = await patchUserProjectFor(user, 'up1', { archived: true });
    expect((res.body as { archive: { boxes: unknown } }).archive.boxes).toEqual([{ boxId: 'box-a', boxName: 'box-a', action: 'stop', status: 'stopping' }]);
  });

  it('keeps the project live when a checkout won\'t archive, and says which and why', async () => {
    db.prisma.project.findMany
      .mockResolvedValueOnce([checkoutRow('chat-1', chatWf, box('box-a')), checkoutRow('chat-2', chatWf, box('box-b'))])
      // chat-1 is still live afterwards.
      .mockResolvedValueOnce([checkoutRow('chat-1', chatWf, box('box-a'))]);
    archives.archiveChatFor
      .mockResolvedValueOnce({ status: 409, body: { error: 'A turn is still running' } })
      .mockResolvedValueOnce({ status: 200, body: { archived: true, box: { action: null } } });
    const res = await patchUserProjectFor(user, 'up1', { archived: true });
    expect(res.status).toBe(409);
    expect(db.tx.$executeRaw).toHaveBeenCalled();
    expect(res.body).toMatchObject({
      code: 'user_project_archive_incomplete',
      archive: { archived: [{ projectId: 'chat-2' }], failed: [{ projectId: 'chat-1', status: 409, error: 'A turn is still running' }] },
    });
    expect(db.tx.userProject.update).not.toHaveBeenCalled();
  });

  it('marks the project archived when another archive at the same moment took the checkout this one was refused', async () => {
    db.prisma.project.findMany.mockResolvedValueOnce([checkoutRow('chat-1', chatWf, box('box-a'))]);
    archives.archiveChatFor.mockResolvedValueOnce({ status: 409, body: { error: 'This chat is archived already' } });
    const res = await patchUserProjectFor(user, 'up1', { archived: true });
    expect(res.status).toBe(200);
    expect(db.tx.userProject.update).toHaveBeenCalledWith({ where: { id: 'up1' }, data: { archivedAt: expect.any(Date) } });
    expect((res.body as { archive: { failed: unknown[] } }).archive.failed).toEqual([]);
  });

  it('keeps the project live, and says why, when a session started on it while it archived', async () => {
    db.prisma.project.findMany
      .mockResolvedValueOnce([checkoutRow('chat-1', chatWf, box('box-a'))])
      .mockResolvedValueOnce([checkoutRow('chat-new', chatWf, box('box-b'))]);
    const res = await patchUserProjectFor(user, 'up1', { archived: true });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ archive: { failed: [{ projectId: 'chat-new', error: 'It started while the project was archiving' }] } });
    expect(db.tx.userProject.update).not.toHaveBeenCalled();
  });

  it("tells the person's other tabs after a change, and answers 503 when the lock can't be had in time", async () => {
    const { setWorkspaceChangeCallback } = await import('../services/workspaceEvents');
    const pushed = vi.fn();
    setWorkspaceChangeCallback(pushed);
    try {
      await patchUserProjectFor(user, 'up1', { name: 'Termag web' });
      expect(pushed).toHaveBeenCalledWith('u1', 'projects');
      pushed.mockClear();
      db.prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('timed out'), { code: 'P2028' }));
      expect(await patchUserProjectFor(user, 'up1', { name: 'Other' })).toMatchObject({ status: 503, body: { code: 'user_projects_unavailable' } });
      expect(pushed).not.toHaveBeenCalled();
    } finally {
      setWorkspaceChangeCallback(null);
    }
  });

  it("answers 503, the project still live, when its mark can't have the lock in time after its checkouts archived", async () => {
    db.prisma.project.findMany.mockResolvedValueOnce([checkoutRow('chat-1', chatWf, box('box-a'))]);
    db.prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('timed out'), { code: 'P2028' }));
    const res = await patchUserProjectFor(user, 'up1', { archived: true });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'user_projects_unavailable', archive: { archived: [{ projectId: 'chat-1' }] } });
    expect(db.tx.userProject.update).not.toHaveBeenCalled();
  });

  it("unarchives the project alone, leaving its checkouts archived", async () => {
    db.prisma.userProject.findFirst.mockResolvedValue({ id: 'up1', name: 'termag', nameKey: 'termag', archivedAt: new Date() });
    const res = await patchUserProjectFor(user, 'up1', { archived: false });
    expect(res.status).toBe(200);
    expect(db.prisma.userProject.update).toHaveBeenCalledWith({ where: { id: 'up1' }, data: { archivedAt: null } });
    expect(db.prisma.project.findMany).not.toHaveBeenCalled();
  });

  it('archives nothing again for a project already archived', async () => {
    db.prisma.userProject.findFirst.mockResolvedValue({ id: 'up1', name: 'termag', nameKey: 'termag', archivedAt: new Date() });
    expect((await patchUserProjectFor(user, 'up1', { archived: true })).status).toBe(200);
    expect(db.prisma.project.findMany).not.toHaveBeenCalled();
    expect(db.prisma.userProject.update).not.toHaveBeenCalled();
    expect(db.tx.userProject.update).not.toHaveBeenCalled();
  });

  it('names the project by its new name when a rename and an archive in one request leave it live', async () => {
    views.userProjectViewFor.mockResolvedValueOnce({ id: 'up1', name: 'Termag web' });
    db.prisma.project.findMany
      .mockResolvedValueOnce([checkoutRow('chat-1', chatWf, box('box-a'))])
      .mockResolvedValueOnce([checkoutRow('chat-1', chatWf, box('box-a'))]);
    archives.archiveChatFor.mockResolvedValueOnce({ status: 409, body: { error: 'A turn is still running' } });
    const res = await patchUserProjectFor(user, 'up1', { name: 'Termag web', archived: true });
    expect((res.body as { error: string }).error).toBe("chat-1 didn't archive, so Termag web stays live");
  });

  it("doesn't archive when the rename in the same request is refused", async () => {
    db.tx.userProject.findFirst.mockResolvedValueOnce({ id: 'up2', name: 'Docs', archivedAt: null });
    expect((await patchUserProjectFor(user, 'up1', { name: 'Docs', archived: true })).status).toBe(409);
    expect(db.prisma.project.findMany).not.toHaveBeenCalled();
  });
});
