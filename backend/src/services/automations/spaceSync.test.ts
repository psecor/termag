import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ prisma: {
  user: { findUnique: vi.fn() },
  projectShare: { findMany: vi.fn(async () => []) },
  automation: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({ count: 1 })), findMany: vi.fn(async () => []) },
  automationRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
  instance: { findUnique: vi.fn(async () => ({ userId: 'u1', status: 'running' })) },
} }));
vi.mock('../featureFlags', () => ({ boolVariation: vi.fn(async () => true) }));
vi.mock('../agentRegistry', () => ({ isProjectAgentConnected: vi.fn(() => true), projectAgentCapabilities: vi.fn(() => []), sendForProject: vi.fn() }));
vi.mock('../spaces/spacesRuntime', () => ({
  spaceStore: {
    findSpace: vi.fn(async () => ({ id: 's1', deletedAt: null, readOnlyAt: null })),
    memberRoles: vi.fn(async () => new Map([['u1', 'owner']])),
    grantedBoxIds: vi.fn(async () => new Set(['box1'])),
    addGrant: vi.fn(),
    removeGrant: vi.fn(async () => true),
    lastPutAt: vi.fn(async () => null),
    ldUser: vi.fn(async () => ({ id: 'u1' })),
  },
}));

import {
  LOG_MAX_BYTES, MEMORY_MAX_BYTES, memoryFile, previousRunFile, publishReadme, pullForRun, pulledMarkerPath, pullPath, pushAfterRun, pushRunLog, readmeFile,
  recheckMirror, remoteMemoryPath, runLogFile, shareesWithoutWrite, spaceSyncDecision, stateFile, syncCommand, syncErrorOf, syncFile, syncInFlight, syncMemory,
  syncSessionName, unwindMirror,
} from './spaceSync';
import { prisma } from '../../db';
import { projectAgentCapabilities, sendForProject } from '../agentRegistry';
import { spaceStore } from '../spaces/spacesRuntime';
import { RUNNER_AGENT_CAPABILITY } from '../claudeRunnerSpawn';

describe('memory sync helpers', () => {
  it('names the remote path and the CLI commands as argument lists', () => {
    // Under the automation's folder; rows from before folders are automations/<projectId>, so their notes stay put.
    expect(remoteMemoryPath('automations/p1')).toBe('automations/p1/memory/MEMORY.md');
    // A get downloads beside the notes, and the box checks the size and renames it in: no bytes cross the socket.
    const dir = '/home/me/.termag/automations/p1/memory';
    const notes = `${dir}/MEMORY.md`;
    const get = syncCommand('/home/me/', 'get', 'team', memoryFile('automations/p1', dir));
    expect(get.slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(get[2]).toContain('rm -f -- "$0" "$3" &&');
    expect(get[2]).toContain('[ "$(wc -c < "$0")" -le "$5" ]');
    expect(get[2]).toContain('mv -f -- "$0" "$4"');
    expect(get.slice(3)).toEqual([pullPath(notes), '/home/me/.local/bin/termag', 'team:automations/p1/memory/MEMORY.md', pulledMarkerPath(notes), notes, String(MEMORY_MAX_BYTES)]);
    // The marker beside the notes file is where the one-file mirror kept it.
    expect(pulledMarkerPath(notes)).toBe(`${dir}/MEMORY.md.pulled`);
    const put = syncCommand('/home/me', 'put', 'team', { ...memoryFile('a', '/l'), remote: 'a/b.md' });
    expect(put[2]).toContain('-le "$3" ] && exec "$1" space put "$0" "$2"');
    expect(put.slice(3)).toEqual(['/l/MEMORY.md', '/home/me/.local/bin/termag', 'team:a/b.md', String(MEMORY_MAX_BYTES)]);
    expect(syncSessionName('first.last', 'run1', 'put')).toBe('first_dlast-automation-sync-run1-memory-put-r');
    expect(syncSessionName('me', 'run1', 'get', 'previous-run')).toBe('me-automation-sync-run1-previous-run-get-r');
  });

  it('lays the folder out: notes and state guarded, logs and README capped small', () => {
    const dir = '/home/me/.termag/automations/p1/memory';
    expect(stateFile('automations/triage', dir)).toEqual({ key: 'state', local: `${dir}/state.json`, remote: 'automations/triage/state.json', maxBytes: MEMORY_MAX_BYTES, guarded: true, fresh: false });
    expect(previousRunFile('automations/triage', dir, 'run-20261020-0900')).toEqual({ key: 'previous-run', local: `${dir}/previous-run.md`, remote: 'automations/triage/runs/run-20261020-0900.md', maxBytes: LOG_MAX_BYTES, guarded: false, fresh: true });
    expect(runLogFile('automations/triage', dir, 'run-x')).toMatchObject({ local: '/home/me/.termag/automations/p1/runs/run-x.md', remote: 'automations/triage/runs/run-x.md', guarded: false });
    expect(readmeFile('automations/triage', dir)).toMatchObject({ local: '/home/me/.termag/automations/p1/README.md', remote: 'automations/triage/README.md' });
    // A fresh get removes the local copy first: a failed pull leaves no older log behind.
    expect(syncCommand('/home/me', 'get', 'team', previousRunFile('f', dir, 'r'))[2]).toMatch(/^rm -f -- "\$0" "\$3" "\$4" &&/);
    expect(syncCommand('/home/me', 'get', 'team', previousRunFile('f', dir, 'r')).at(-1)).toBe(String(LOG_MAX_BYTES));
  });

  it('words a transfer result for the run row', () => {
    expect(syncErrorOf('memory', 'get', { outcome: 'done', reason: null })).toBeNull();
    expect(syncErrorOf('memory', 'get', { outcome: 'skipped', reason: 'space_read_only' })).toBe('space_read_only');
    expect(syncErrorOf('state', 'put', { outcome: 'skipped', reason: 'box_outdated' })).toBe('box_outdated');
    expect(syncErrorOf('state', 'get', { outcome: 'timeout', reason: 'timeout' })).toBe('state get timeout');
    expect(syncErrorOf('memory', 'put', { outcome: 'skipped', reason: 'pull_failed' })).toBe('memory put pull_failed');
  });

  it('decides who may mirror', () => {
    const space = { deletedAt: null, readOnlyAt: null };
    expect(spaceSyncDecision({ space: null, role: undefined })).toBe('space_not_found');
    expect(spaceSyncDecision({ space: { ...space, deletedAt: new Date() }, role: 'owner' })).toBe('space_not_found');
    expect(spaceSyncDecision({ space, role: 'viewer' })).toBe('space_forbidden');
    // A non-member learns nothing: the answer is the one a missing space gets.
    expect(spaceSyncDecision({ space, role: undefined })).toBe('space_not_found');
    expect(spaceSyncDecision({ space: { ...space, readOnlyAt: new Date() }, role: 'editor' })).toBe('space_read_only');
    expect(spaceSyncDecision({ space, role: 'editor' })).toBeNull();
    expect(spaceSyncDecision({ space, role: 'owner', shareesWithoutWrite: 1 })).toBe('shared_outside_space');
    expect(spaceSyncDecision({ space, role: 'owner', shareesWithoutWrite: 0 })).toBeNull();
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
    const target = { runId: 'rs', userId: 'u1', projectId: 'p1', projectName: 'triage', spaceName: 'team', folder: 'automations/p1', host: { userId: 'u1', instanceId: 'box1' }, box: { id: 'box1', hostHome: '/home/me', hostUnixUser: 'me' }, memoryDir: '/home/me/.termag/automations/p1/memory' };
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
    runId, userId: 'u1', projectId: 'p1', projectName: 'triage', spaceName: 'team', folder: 'automations/p1',
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
    expect(syncInFlight('team', 'automations/p1/memory/MEMORY.md')).toBe(true);
    await vi.advanceTimersByTimeAsync(2500);
    const creates = () => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create').map(c => (c[2] as { sessionName: string }).sessionName);
    expect(creates()).toEqual(['me-automation-sync-r1-memory-put-r']);
    putLive = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(await put).toBe('done');
    await vi.advanceTimersByTimeAsync(1500);
    expect(creates()).toEqual(['me-automation-sync-r1-memory-put-r', 'me-automation-sync-r2-memory-get-r']);
    expect(await get).toBe('done');
    expect(syncInFlight('team', 'automations/p1/memory/MEMORY.md')).toBe(false);
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
    expect(creates[0][3]).toBe(pullPath(`${dir}/MEMORY.md`));
    // Only the marker is read; the notes' bytes are never read or written through the socket.
    const reads = vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'read-file').map(c => (c[2] as { path: string }).path);
    expect(reads.every(p => p === pulledMarkerPath(`${dir}/MEMORY.md`))).toBe(true);
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
    expect(creates()).toEqual(['me-automation-sync-r1-memory-put-r', 'me-automation-sync-r2-memory-get-r']);
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
    expect(writes).toEqual([{ path: `${dir}/MEMORY.md`, content: '', mode: 0o600 }, { path: pulledMarkerPath(`${dir}/MEMORY.md`), content: '', mode: 0o600 }]);
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

describe('the folder: pulls, pushes, the run log and the README', () => {
  beforeEach(() => {
    vi.mocked(projectAgentCapabilities).mockReturnValue([RUNNER_AGENT_CAPABILITY]);
    vi.mocked(sendForProject).mockImplementation(async (_h, type) => (type === 'tmux-has-session' ? { exists: false } : type === 'read-file' ? { content: 'ok' } : { ok: true }));
  });
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  const dir = '/home/me/.termag/automations/p1/memory';
  const target = (runId: string) => ({
    runId, userId: 'u1', projectId: 'p1', projectName: 'triage', spaceName: 'team', folder: 'automations/triage',
    host: { userId: 'u1', instanceId: 'box1' }, box: { id: 'box1', hostHome: '/home/me', hostUnixUser: 'me' }, memoryDir: dir,
  });
  const remotes = () => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create').map(c => (c[2] as { command: string[] }).command[5]);
  const sessions = () => vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create').map(c => (c[2] as { sessionName: string }).sessionName);

  it('pulls only the notes with folders off, as the one-file mirror did', async () => {
    vi.useFakeTimers();
    const p = pullForRun(target('r1'), { folders: false, previousLog: 'run-prev', readme: 'x' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toEqual({ error: null, usable: true });
    expect(sessions()).toEqual(['me-automation-sync-r1-memory-get-r']);
  });

  it('pulls the notes, the state and the previous log, and uploads a README that changed', async () => {
    vi.useFakeTimers();
    const p = pullForRun(target('r2'), { folders: true, previousLog: 'run-20261020-0900', readme: '# Automation triage\n' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toEqual({ error: null, usable: true });
    expect(sessions()).toEqual(['me-automation-sync-r2-memory-get-r', 'me-automation-sync-r2-state-get-r', 'me-automation-sync-r2-previous-run-get-r', 'me-automation-sync-r2-readme-put-r']);
    const gets = vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create').map(c => (c[2] as { command: string[] }).command);
    expect(gets[2][5]).toBe('team:automations/triage/runs/run-20261020-0900.md');
    expect(gets[3].slice(3, 6)).toEqual(['/home/me/.termag/automations/p1/README.md', '/home/me/.local/bin/termag', 'team:automations/triage/README.md']);
    expect(vi.mocked(sendForProject).mock.calls.find(c => c[1] === 'write-file')?.[2]).toEqual({ path: '/home/me/.termag/automations/p1/README.md', content: '# Automation triage\n', mode: 0o600 });
    expect(remotes()).toHaveLength(4);
  });

  it('stops at a refusal: the space is not usable, and the row hears the code', async () => {
    vi.mocked(spaceStore.memberRoles).mockResolvedValueOnce(new Map([['u1', 'viewer']]));
    expect(await pullForRun(target('r3'), { folders: true, previousLog: 'run-prev', readme: 'x' })).toEqual({ error: 'space_forbidden', usable: false });
    expect(sessions()).toEqual([]);
  });

  it("refuses a box that is not the owner's or is terminated", async () => {
    vi.mocked(prisma.instance.findUnique).mockResolvedValueOnce({ userId: 'u1', status: 'terminated' } as never);
    expect(await syncFile(target('r4'), stateFile('automations/triage', dir), 'get')).toEqual({ outcome: 'skipped', reason: 'box_unavailable' });
    vi.mocked(prisma.instance.findUnique).mockResolvedValueOnce({ userId: 'someone-else', status: 'running' } as never);
    expect(await syncFile(target('r4'), stateFile('automations/triage', dir), 'get')).toEqual({ outcome: 'skipped', reason: 'box_unavailable' });
    expect(spaceStore.addGrant).not.toHaveBeenCalled();
  });

  it('pushes the state with the notes, both queued at once, and skips a state push whose pull failed', async () => {
    vi.useFakeTimers();
    // r5's state pull fails while the space holds a state file.
    vi.mocked(sendForProject).mockImplementation(async (_h, type, payload) => {
      if (type === 'tmux-has-session') return { exists: false };
      if (type === 'read-file') return { content: (payload as { path: string }).path.includes('state.json') ? null : 'ok' };
      return { ok: true };
    });
    vi.mocked(spaceStore.lastPutAt).mockImplementation(async (_s, path) => (path.endsWith('state.json') ? new Date() : null));
    const pulled = syncFile(target('r5'), stateFile('automations/triage', dir), 'get');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pulled).toEqual({ outcome: 'failed', reason: 'pull_failed' });
    vi.mocked(sendForProject).mockClear();
    const queued = vi.fn();
    const pushed = pushAfterRun(target('r5'), { folders: true, delayMs: 3000, queued });
    expect(queued).toHaveBeenCalledTimes(1);
    expect(syncInFlight('team', 'automations/triage/memory/MEMORY.md')).toBe(true);
    expect(syncInFlight('team', 'automations/triage/state.json')).toBe(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pushed).toBe('state put pull_failed');
    expect(sessions()).toEqual(['me-automation-sync-r5-memory-put-r']);
    vi.mocked(spaceStore.lastPutAt).mockImplementation(async () => null);
  });

  it('holds the notes push behind its gate, and skips it with no error when the finish was not its own', async () => {
    vi.useFakeTimers();
    let open!: (ours: boolean) => void;
    const gate = new Promise<boolean>(r => { open = r; });
    const pushed = pushAfterRun(target('r9'), { folders: true, gate });
    expect(syncInFlight('team', 'automations/triage/memory/MEMORY.md')).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sessions()).toEqual([]);
    open(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pushed).toBeNull();
    expect(sessions()).toEqual([]);
  });

  it('writes the run log on the box, then uploads it to runs/<name>.md', async () => {
    vi.useFakeTimers();
    const p = pushRunLog(target('r6'), 'run-20261020-0900', '# log\n');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await p).toBeNull();
    const write = vi.mocked(sendForProject).mock.calls.find(c => c[1] === 'write-file');
    expect(write?.[2]).toEqual({ path: '/home/me/.termag/automations/p1/runs/run-20261020-0900.md', content: '# log\n', mode: 0o600 });
    const create = vi.mocked(sendForProject).mock.calls.find(c => c[1] === 'tmux-create')?.[2] as { command: string[] };
    expect(create.command[5]).toBe('team:automations/triage/runs/run-20261020-0900.md');
    expect(vi.mocked(sendForProject).mock.invocationCallOrder[vi.mocked(sendForProject).mock.calls.indexOf(write!)]).toBeLessThan(
      vi.mocked(sendForProject).mock.invocationCallOrder[vi.mocked(sendForProject).mock.calls.findIndex(c => c[1] === 'tmux-create')]);
  });

  it("holds the next run's pull of the previous log behind a queued run-log push, rendered when its turn comes", async () => {
    vi.useFakeTimers();
    const render = vi.fn(async () => '# final log\n');
    const queued = vi.fn();
    const push = pushRunLog(target('r8'), 'run-20261020-0900', render, { delayMs: 5000, queued });
    expect(queued).toHaveBeenCalledTimes(1);
    expect(syncInFlight('team', 'automations/triage/runs/run-20261020-0900.md')).toBe(true);
    // The next run starts at once and asks for that log as its previous-run.md.
    const pull = syncFile(target('r9'), previousRunFile('automations/triage', dir, 'run-20261020-0900'), 'get');
    await vi.advanceTimersByTimeAsync(4000);
    expect(render).not.toHaveBeenCalled();
    expect(sessions()).toEqual([]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await push).toBeNull();
    expect(await pull).toEqual({ outcome: 'done', reason: null });
    expect(render).toHaveBeenCalledTimes(1);
    expect(sessions()).toEqual(['me-automation-sync-r8-run-log-put-r', 'me-automation-sync-r9-previous-run-get-r']);
    expect(vi.mocked(sendForProject).mock.calls.find(c => c[1] === 'write-file')?.[2]).toMatchObject({ content: '# final log\n' });
  });

  it('writes and uploads nothing when the queued render has nothing to say', async () => {
    expect(await pushRunLog(target('r10'), 'run-x', async () => null)).toBeNull();
    expect(vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create' || c[1] === 'write-file')).toHaveLength(0);
  });

  it('leaves a README alone when the box already has the same one', async () => {
    vi.mocked(sendForProject).mockImplementation(async (_h, type) => (type === 'read-file' ? { content: 'same' } : { ok: true }));
    expect(await publishReadme(target('r7'), 'same')).toBeNull();
    expect(vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'tmux-create' || c[1] === 'write-file')).toHaveLength(0);
  });

  it('unwinding blanks a pulled state file and its marker as well as the notes', async () => {
    vi.mocked(prisma.automation.findUnique).mockResolvedValueOnce({
      id: 'a1', spaceName: 'team', spaceFolder: 'automations/triage', mirrorGrantBoxId: null,
      project: { name: 'triage', userId: 'u1', instanceId: 'box1', instance: { hostHome: '/home/me' }, user: { unixUsername: 'me' } },
    } as never);
    vi.mocked(sendForProject).mockImplementation(async (_h, type, payload) => (type === 'read-file' ? { content: (payload as { path: string }).path.endsWith('state.json') ? '{}' : null } : { ok: true }));
    await unwindMirror('p1', 'shared_outside_space');
    const writes = vi.mocked(sendForProject).mock.calls.filter(c => c[1] === 'write-file').map(c => (c[2] as { path: string }).path);
    expect(writes).toEqual([`${dir}/MEMORY.md`, `${dir}/MEMORY.md.pulled`, `${dir}/state.json`, `${dir}/state.json.pulled`]);
  });
});
