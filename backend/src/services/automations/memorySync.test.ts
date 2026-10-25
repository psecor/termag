import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ prisma: {
  user: { findUnique: vi.fn() },
  projectShare: { findMany: vi.fn(async () => []) },
  automation: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })), findMany: vi.fn(async () => []) },
} }));
vi.mock('../agentRegistry', () => ({ isProjectAgentConnected: vi.fn(() => true), projectAgentCapabilities: vi.fn(() => []), sendForProject: vi.fn() }));
vi.mock('../spaces/spacesRuntime', () => ({
  spaceStore: {
    findSpace: vi.fn(async () => ({ id: 's1', deletedAt: null, readOnlyAt: null })),
    memberRoles: vi.fn(async () => new Map([['u1', 'owner']])),
    grantedBoxIds: vi.fn(async () => new Set(['box1'])),
    addGrant: vi.fn(),
    removeGrant: vi.fn(async () => true),
    lastPutAt: vi.fn(async () => null),
  },
  spacesEnabledFor: vi.fn(async () => true),
}));

import { MEMORY_MAX_BYTES, recheckMirror, unwindMirror, pulledMarkerPath, pullPath, remoteMemoryPath, shareesWithoutWrite, spaceSyncDecision, syncCommand, syncInFlight, syncMemory, syncSessionName } from './memorySync';
import { prisma } from '../../db';
import { projectAgentCapabilities, sendForProject } from '../agentRegistry';
import { spaceStore } from '../spaces/spacesRuntime';
import { RUNNER_AGENT_CAPABILITY } from '../claudeRunnerSpawn';

describe('memory sync helpers', () => {
  it('names the remote path and the CLI commands as argument lists', () => {
    // The project id, not its name: a renamed automation keeps its notes.
    expect(remoteMemoryPath('p1')).toBe('automations/p1/memory/MEMORY.md');
    // A get downloads beside the notes, and the box checks the size and renames it in: no bytes cross the socket.
    const dir = '/home/me/.termag/automations/p1/memory';
    const get = syncCommand('/home/me/', 'get', 'team', 'automations/p1/memory/MEMORY.md', dir);
    expect(get.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(get[2]).toContain('rm -f -- "$0" "$3"');
    expect(get[2]).toContain('[ "$(wc -c < "$0")" -le "$5" ]');
    expect(get[2]).toContain('mv -f -- "$0" "$4"');
    expect(get.slice(3)).toEqual([pullPath(dir), '/home/me/.local/bin/termag', 'team:automations/p1/memory/MEMORY.md', pulledMarkerPath(dir), `${dir}/MEMORY.md`, String(MEMORY_MAX_BYTES)]);
    const put = syncCommand('/home/me', 'put', 'team', 'a/b.md', '/l');
    expect(put[2]).toContain('-le "$3" ] && exec "$1" space put "$0" "$2"');
    expect(put.slice(3)).toEqual(['/l/MEMORY.md', '/home/me/.local/bin/termag', 'team:a/b.md', String(MEMORY_MAX_BYTES)]);
    expect(syncSessionName('first.last', 'run1', 'put')).toBe('first_dlast-automation-sync-run1-put-r');
  });

  it('decides who may mirror', () => {
    const space = { deletedAt: null, readOnlyAt: null };
    expect(spaceSyncDecision({ flagOn: false, space, role: 'owner' })).toBe('spaces_off');
    expect(spaceSyncDecision({ flagOn: true, space: null, role: undefined })).toBe('space_not_found');
    expect(spaceSyncDecision({ flagOn: true, space: { ...space, deletedAt: new Date() }, role: 'owner' })).toBe('space_not_found');
    expect(spaceSyncDecision({ flagOn: true, space, role: 'viewer' })).toBe('space_forbidden');
    // A non-member learns nothing: the answer is the one a missing space gets.
    expect(spaceSyncDecision({ flagOn: true, space, role: undefined })).toBe('space_not_found');
    expect(spaceSyncDecision({ flagOn: true, space: { ...space, readOnlyAt: new Date() }, role: 'editor' })).toBe('space_read_only');
    expect(spaceSyncDecision({ flagOn: true, space, role: 'editor' })).toBeNull();
    expect(spaceSyncDecision({ flagOn: true, space, role: 'owner', shareesWithoutWrite: 1 })).toBe('shared_outside_space');
    expect(spaceSyncDecision({ flagOn: true, space, role: 'owner', shareesWithoutWrite: 0 })).toBeNull();
  });

  it('counts the sharees who cannot write the space', () => {
    const roles = new Map([['u1', 'owner'], ['ed', 'editor'], ['view', 'viewer']] as const);
    expect(shareesWithoutWrite(['ed'], roles)).toBe(0);
    expect(shareesWithoutWrite(['ed', 'view', 'stranger'], roles)).toBe(2);
    expect(shareesWithoutWrite([], roles)).toBe(0);
  });
});

describe('syncMemory with a sharee outside the space', () => {
  beforeEach(() => { vi.mocked(projectAgentCapabilities).mockReturnValue([RUNNER_AGENT_CAPABILITY]); });
  afterEach(() => { vi.clearAllMocks(); });
  it('moves nothing in either direction while the project is shared with a non-member', async () => {
    vi.mocked(prisma.projectShare.findMany).mockResolvedValue([{ userId: 'stranger' }] as never);
    const target = { runId: 'rs', userId: 'u1', projectId: 'p1', projectName: 'triage', spaceName: 'team', host: { userId: 'u1', instanceId: 'box1' }, box: { id: 'box1', hostHome: '/home/me', hostUnixUser: 'me' }, memoryDir: '/home/me/.termag/automations/p1/memory' };
    expect(await syncMemory(target, 'get')).toBe('skipped');
    expect(await syncMemory({ ...target, runId: 'rs2' }, 'put')).toBe('skipped');
    expect(vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create')).toHaveLength(0);
    vi.mocked(prisma.projectShare.findMany).mockResolvedValue([]);
  });
});

describe('syncMemory', () => {
  beforeEach(() => { vi.mocked(projectAgentCapabilities).mockReturnValue([RUNNER_AGENT_CAPABILITY]); });
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  const target = (runId: string) => ({
    runId, userId: 'u1', projectId: 'p1', projectName: 'triage', spaceName: 'team',
    host: { userId: 'u1', instanceId: 'box1' }, box: { id: 'box1', hostHome: '/home/me', hostUnixUser: 'me' },
    memoryDir: '/home/me/.termag/automations/p1/memory',
  });

  it("runs one transfer at a time per mirrored file: the next run's pull waits for the previous run's push", async () => {
    vi.useFakeTimers();
    // The put's session stays alive until we say so; everything else answers at once.
    let putLive = true;
    vi.mocked(sendForProject).mockImplementation(async (_h, type, payload) => {
      if (type === 'tmux-has-session') {
        const name = (payload as { sessionName: string }).sessionName;
        return { exists: name.includes('-put-') ? putLive : false };
      }
      return { ok: true };
    });
    const put = syncMemory(target('r1'), 'put');
    const get = syncMemory(target('r2'), 'get');
    expect(syncInFlight('team', 'p1')).toBe(true);
    await vi.advanceTimersByTimeAsync(2500);
    const creates = () => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create').map(c => (c[2] as { sessionName: string }).sessionName);
    expect(creates()).toEqual(['me-automation-sync-r1-put-r']);
    putLive = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await put).toBe('done');
    await vi.advanceTimersByTimeAsync(1500);
    expect(creates()).toEqual(['me-automation-sync-r1-put-r', 'me-automation-sync-r2-get-r']);
    expect(await get).toBe('done');
    expect(syncInFlight('team', 'p1')).toBe(false);
  });

  it('replaces the notes file only with pulled bytes, and skips the push of a run whose pull failed while the space held notes', async () => {
    vi.useFakeTimers();
    let pulledContent: string | null = null;
    vi.mocked(sendForProject).mockImplementation(async (_h, type, payload) => {
      if (type === 'tmux-has-session') return { exists: false };
      if (type === 'read-file') return pulledContent === null ? { ok: false } : { content: pulledContent };
      return { ok: true };
    });
    const dir = '/home/me/.termag/automations/p1/memory';
    // A pull the box installed: it wrote the marker.
    pulledContent = 'ok';
    const good = syncMemory(target('r1'), 'get');
    await vi.advanceTimersByTimeAsync(1500);
    expect(await good).toBe('done');
    const creates = vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create').map(c => (c[2] as { command: string[] }).command);
    expect(creates[0][3]).toBe(pullPath(dir));
    // Only the marker is read; the notes' bytes are never read or written through the socket.
    const reads = vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'read-file').map(c => (c[2] as { path: string }).path);
    expect(reads.every(p => p === pulledMarkerPath(dir))).toBe(true);
    expect(vi.mocked(sendForProject).mock.calls.some(c => c[1] === 'write-file')).toBe(false);
    // Nothing pulled and the space never held the file: the first run, fine.
    pulledContent = null;
    const first = syncMemory(target('r2'), 'get');
    await vi.advanceTimersByTimeAsync(1500);
    expect(await first).toBe('done');
    // Nothing pulled while the space holds notes: failed, and this run's push is skipped.
    vi.mocked(spaceStore.lastPutAt).mockResolvedValueOnce(new Date());
    const failed = syncMemory(target('r3'), 'get');
    await vi.advanceTimersByTimeAsync(1500);
    expect(await failed).toBe('failed');
    const before = vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create').length;
    expect(await syncMemory(target('r3'), 'put')).toBe('skipped');
    expect(vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create')).toHaveLength(before);
    const other = syncMemory(target('r2'), 'put');
    await vi.advanceTimersByTimeAsync(1500);
    expect(await other).toBe('done');
  });

  it('decides a put from the box and the space when the process has forgotten the pull (a restart)', async () => {
    vi.useFakeTimers();
    let pullFile: string | null = null;
    vi.mocked(sendForProject).mockImplementation(async (_h, type) => {
      if (type === 'tmux-has-session') return { exists: false };
      if (type === 'read-file') return pullFile === null ? { ok: true, content: null } : { content: pullFile };
      return { ok: true };
    });
    const creates = () => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create').length;
    // The space holds notes and the box has no pull file: nothing is pushed.
    vi.mocked(spaceStore.lastPutAt).mockResolvedValue(new Date());
    expect(await syncMemory(target('r7'), 'put')).toBe('skipped');
    expect(creates()).toBe(0);
    // The pull file is there: the push goes.
    pullFile = 'ok';
    const put = syncMemory(target('r8'), 'put');
    await vi.advanceTimersByTimeAsync(1500);
    expect(await put).toBe('done');
    expect(creates()).toBe(1);
    // No pull file, but the space never held the file: the first run's push goes.
    pullFile = null;
    vi.mocked(spaceStore.lastPutAt).mockResolvedValue(null);
    const first = syncMemory(target('r9'), 'put');
    await vi.advanceTimersByTimeAsync(1500);
    expect(await first).toBe('done');
    expect(creates()).toBe(2);
  });

  it("queues a delayed push at once, so a pull asked for during the delay waits behind it", async () => {
    vi.useFakeTimers();
    vi.mocked(sendForProject).mockImplementation(async (_h, type) => (type === 'tmux-has-session' ? { exists: false } : type === 'read-file' ? { content: 'ok' } : { ok: true }));
    const put = syncMemory(target('r1'), 'put', { delayMs: 5000 });
    const get = syncMemory(target('r2'), 'get');
    const creates = () => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create').map(c => (c[2] as { sessionName: string }).sessionName);
    await vi.advanceTimersByTimeAsync(4000);
    expect(creates()).toEqual([]);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await put).toBe('done');
    expect(await get).toBe('done');
    expect(creates()).toEqual(['me-automation-sync-r1-put-r', 'me-automation-sync-r2-get-r']);
  });

  it('does not hold a later transfer behind one that gave up', async () => {
    vi.useFakeTimers();
    vi.mocked(sendForProject).mockImplementation(async (_h, type) => (type === 'tmux-has-session' ? { exists: true } : { ok: true }));
    const first = syncMemory(target('r1'), 'put', { waitMs: 2000 });
    const second = syncMemory(target('r2'), 'get', { waitMs: 2000 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(await first).toBe('timeout');
    await vi.advanceTimersByTimeAsync(2500);
    expect(await second).toBe('timeout');
    expect(vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create')).toHaveLength(2);
  });
});

describe('unwindMirror', () => {
  const row = (mirrorGrantBoxId: string | null) => ({
    id: 'a1', spaceName: 'team', mirrorGrantBoxId,
    project: { name: 'triage', userId: 'u1', instanceId: 'box1', instance: { hostHome: '/home/me' }, user: { unixUsername: 'me' } },
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('removes the grant the mirror added and blanks the pulled notes and marker on the box', async () => {
    vi.mocked(prisma.automation.findUnique).mockResolvedValueOnce(row('box1') as never);
    await unwindMirror('p1', 'shared_outside_space');
    expect(spaceStore.removeGrant).toHaveBeenCalledWith('s1', 'box1');
    expect(prisma.automation.update).toHaveBeenCalledWith({ where: { id: 'a1' }, data: { mirrorGrantBoxId: null } });
    const dir = '/home/me/.termag/automations/p1/memory';
    const writes = vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'write-file').map(c => c[2]);
    expect(writes).toEqual([{ path: `${dir}/MEMORY.md`, content: '', mode: 0o600 }, { path: pulledMarkerPath(dir), content: '', mode: 0o600 }]);
  });

  it('leaves a grant the owner made by hand', async () => {
    vi.mocked(prisma.automation.findUnique).mockResolvedValueOnce(row(null) as never);
    await unwindMirror('p1', 'shared_outside_space');
    expect(spaceStore.removeGrant).not.toHaveBeenCalled();
    expect(vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'write-file')).toHaveLength(2);
  });

  it('recheckMirror unwinds when a sharee cannot write the space, and does nothing otherwise', async () => {
    vi.mocked(prisma.automation.findUnique).mockResolvedValue({ spaceName: 'team', userId: 'u1', ...row('box1') } as never);
    vi.mocked(prisma.projectShare.findMany).mockResolvedValueOnce([{ userId: 'stranger' }] as never);
    await recheckMirror('p1');
    expect(spaceStore.removeGrant).toHaveBeenCalledWith('s1', 'box1');
    vi.clearAllMocks();
    vi.mocked(prisma.automation.findUnique).mockResolvedValue({ spaceName: 'team', userId: 'u1', ...row('box1') } as never);
    vi.mocked(prisma.projectShare.findMany).mockResolvedValueOnce([]);
    await recheckMirror('p1');
    expect(spaceStore.removeGrant).not.toHaveBeenCalled();
    vi.mocked(prisma.automation.findUnique).mockResolvedValue(null);
  });
});
