import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Instance, User } from '@prisma/client';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../services/featureFlags', () => ({ boolVariation: vi.fn(async () => false) }));
vi.mock('../services/boxPower', () => ({ instanceStatus: vi.fn(async () => null) }));
vi.mock('../services/agentRegistry', () => ({
  closeBrowserStream: vi.fn(), isProjectAgentConnected: vi.fn(), projectAgentCapabilities: vi.fn(),
  requestBrowserStream: vi.fn(), sendBrowserMessage: vi.fn(),
}));

import { TERMINAL_BOX_PARKED_CLOSE_CODE } from '../services/boxPowerPolicy';
import { BROWSER_PANE_CAPABILITY, BROWSER_PANE_GUEST_CAPABILITY, BROWSER_PANE_PROFILES_CAPABILITY, BROWSER_PANE_DISABLED_CLOSE_CODE, BROWSER_PANE_RETRY_CLOSE_CODE, BROWSER_PANE_UNSUPPORTED_CLOSE_CODE } from '../services/browserPane';
import { BROWSER_PANE_DISABLED_MESSAGE, BROWSER_PANE_UNSUPPORTED_MESSAGE, handleBrowserPaneSocket, type BrowserPaneProject, type BrowserWsDeps } from './browserWs';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  closed: { code?: number; reason?: string } | null = null;
  /** The real socket's callback fires once the frame has gone out; here that is at once. */
  send(data: string, cb?: (err?: Error) => void) { this.sent.push(JSON.parse(data)); cb?.(); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; this.emit('close'); }
}

const owner = { id: 'u-owner', unixUsername: 'owner' } as User;
const friend = { id: 'u-friend', unixUsername: 'friend' } as User;
const box = { id: 'box-1', name: 'box one', kind: 'ec2', status: 'ready' } as Instance;
const project: BrowserPaneProject = { id: 'p1', name: 'proj', userId: owner.id, ownerUnixUsername: 'owner', instanceId: box.id, setupStatus: 'ready', instance: { ...box, hostHome: '/home/boxuser' } as Instance };

function deps(over: Partial<BrowserWsDeps> = {}): BrowserWsDeps & { log: ReturnType<typeof vi.fn> } {
  return {
    findProject: vi.fn(async (id) => (id === project.id ? project : null)),
    findUser: vi.fn(async (id) => (id === owner.id ? owner : id === friend.id ? friend : null)),
    hasShare: vi.fn(async (_p, userId) => userId === friend.id),
    flagOn: vi.fn(async () => true),
    keptProfilesOn: vi.fn(async () => false),
    boxStatus: vi.fn(async () => 'ready'),
    agentConnected: vi.fn(() => true),
    agentCapabilities: vi.fn(() => ['tmux-create-command-v1', BROWSER_PANE_CAPABILITY]),
    requestStream: vi.fn(async () => 'browser_1'),
    sendToStream: vi.fn(),
    closeStream: vi.fn(),
    suggest: vi.fn(async () => []),
    log: vi.fn(),
    guestContext: vi.fn(async () => null),
    guestFlags: vi.fn(async () => ({ paneOn: true, sharingOn: true, killed: false, maxGuests: 5 })),
    registerGuest: vi.fn(() => () => {}),
    recordShareEvent: vi.fn(async () => {}),
    noteShareOpened: vi.fn(async () => {}),
    now: () => Date.parse('2026-10-20T12:00:00Z'),
    ...over,
  };
}

const url = (q: string) => new URL(`http://localhost/termag/ws/browser?${q}`);

describe('handleBrowserPaneSocket', () => {
  it('needs a login and a project', async () => {
    const ws = new FakeSocket();
    await handleBrowserPaneSocket(ws, url('projectId=p1'), null, deps());
    expect(ws.closed).toEqual({ code: 1008, reason: 'login required' });

    const ws2 = new FakeSocket();
    await handleBrowserPaneSocket(ws2, url('url=http://x/'), owner.id, deps());
    expect(ws2.closed).toEqual({ code: 1008, reason: 'projectId param required' });

    const ws3 = new FakeSocket();
    await handleBrowserPaneSocket(ws3, url('projectId=nope'), owner.id, deps());
    expect(ws3.closed).toEqual({ code: 1008, reason: 'unknown project' });
  });

  it('refuses a stranger and admits a share holder', async () => {
    const d = deps();
    const stranger = new FakeSocket();
    await handleBrowserPaneSocket(stranger, url('projectId=p1'), 'u-stranger', d);
    expect(stranger.closed).toEqual({ code: 1008, reason: 'unknown user' });

    const d2 = deps({ findUser: vi.fn(async () => ({ id: 'u-stranger' } as User)), hasShare: vi.fn(async () => false) });
    const stranger2 = new FakeSocket();
    await handleBrowserPaneSocket(stranger2, url('projectId=p1'), 'u-stranger', d2);
    expect(stranger2.closed).toEqual({ code: 1008, reason: 'project forbidden' });
    expect(d2.requestStream).not.toHaveBeenCalled();

    const shared = new FakeSocket();
    await handleBrowserPaneSocket(shared, url('projectId=p1&url=localhost:3000'), friend.id, d);
    expect(shared.closed).toBeNull();
    expect(d.requestStream).toHaveBeenCalledWith({ userId: owner.id, instanceId: box.id }, { url: 'http://localhost:3000/', width: 1024, height: 768, paneKey: `${friend.id}:p1/main` }, expect.any(Function));
  });

  it('closes 4403 with a message while the flag is off for the viewer and box', async () => {
    const d = deps({ flagOn: vi.fn(async () => false) });
    const ws = new FakeSocket();
    await handleBrowserPaneSocket(ws, url('projectId=p1'), owner.id, d);
    expect(d.flagOn).toHaveBeenCalledWith(owner, project.instance);
    expect(ws.sent).toEqual([{ type: 'exit', reason: BROWSER_PANE_DISABLED_MESSAGE }]);
    expect(ws.closed).toEqual({ code: BROWSER_PANE_DISABLED_CLOSE_CODE, reason: 'browser pane disabled' });
    expect(d.requestStream).not.toHaveBeenCalled();
  });

  it('refuses a parked box with the terminal close code, and an agent that is not connected with a retryable one', async () => {
    const parked = new FakeSocket();
    await handleBrowserPaneSocket(parked, url('projectId=p1'), owner.id, deps({ boxStatus: vi.fn(async () => 'stopped'), agentConnected: vi.fn(() => false) }));
    expect(parked.closed?.code).toBe(TERMINAL_BOX_PARKED_CLOSE_CODE);
    expect(parked.sent[0]?.type).toBe('exit');

    // The agent reconnects by itself and may still hold the viewer's parked browser: the pane should keep trying.
    const offline = new FakeSocket();
    await handleBrowserPaneSocket(offline, url('projectId=p1'), owner.id, deps({ agentConnected: vi.fn(() => false) }));
    expect(offline.sent).toEqual([{ type: 'exit', reason: 'Agent not connected for this box.' }]);
    expect(offline.closed).toEqual({ code: BROWSER_PANE_RETRY_CLOSE_CODE, reason: 'agent not connected' });
    expect(BROWSER_PANE_RETRY_CLOSE_CODE).not.toBe(1008);
  });

  it('refuses a workstream that is not a plain name: it becomes a path on the box', async () => {
    const d = deps();
    const ws = new FakeSocket();
    await handleBrowserPaneSocket(ws, url('projectId=p1&workstream=..%2F..%2Fetc'), owner.id, d);
    expect(ws.closed).toEqual({ code: 1008, reason: 'workstream name invalid' });
    expect(d.requestStream).not.toHaveBeenCalled();
  });

  it('closes 4501 when the agent does not advertise the capability', async () => {
    const d = deps({ agentCapabilities: vi.fn(() => ['tmux-create-command-v1']) });
    const ws = new FakeSocket();
    await handleBrowserPaneSocket(ws, url('projectId=p1'), owner.id, d);
    expect(ws.sent).toEqual([{ type: 'exit', reason: BROWSER_PANE_UNSUPPORTED_MESSAGE }]);
    expect(ws.closed).toEqual({ code: BROWSER_PANE_UNSUPPORTED_CLOSE_CODE, reason: 'browser pane unsupported' });
  });

  it('asks for a kept profile only while the owner\'s flag is on and the agent keeps profiles, for every viewer', async () => {
    const kept = [BROWSER_PANE_CAPABILITY, BROWSER_PANE_PROFILES_CAPABILITY];
    // On, for the owner: asked.
    let d = deps({ keptProfilesOn: vi.fn(async () => true), agentCapabilities: vi.fn(() => kept) });
    await handleBrowserPaneSocket(new FakeSocket(), url('projectId=p1&url=http://127.0.0.2/'), owner.id, d);
    expect(d.requestStream.mock.calls[0][1]).toMatchObject({ persistProfile: true });
    expect(d.keptProfilesOn).toHaveBeenCalledWith(owner, project.instance);
    // A collaborator's pane follows the owner's flag, evaluated for the owner.
    d = deps({ keptProfilesOn: vi.fn(async () => true), agentCapabilities: vi.fn(() => kept) });
    await handleBrowserPaneSocket(new FakeSocket(), url('projectId=p1&url=http://127.0.0.2/'), friend.id, d);
    expect(d.requestStream.mock.calls[0][1]).toMatchObject({ persistProfile: true, paneKey: `${friend.id}:p1/main` });
    expect(d.keptProfilesOn).toHaveBeenCalledWith(owner, project.instance);
    // Off: not asked.
    d = deps({ agentCapabilities: vi.fn(() => kept) });
    await handleBrowserPaneSocket(new FakeSocket(), url('projectId=p1&url=http://127.0.0.2/'), owner.id, d);
    expect(d.requestStream.mock.calls[0][1]).not.toHaveProperty('persistProfile');
    // On, but an agent that predates kept profiles: not asked, and the flag is not even read.
    d = deps({ keptProfilesOn: vi.fn(async () => true) });
    await handleBrowserPaneSocket(new FakeSocket(), url('projectId=p1&url=http://127.0.0.2/'), owner.id, d);
    expect(d.requestStream.mock.calls[0][1]).not.toHaveProperty('persistProfile');
    expect(d.keptProfilesOn).not.toHaveBeenCalled();
  });

  it('closes a pane whose kept browser another tab took over with a final code, so it does not take it back', async () => {
    let onEvent: ((msg: any) => void) | null = null;
    const d = deps({ requestStream: vi.fn(async (_h, _o, cb) => { onEvent = cb; return 'browser_3'; }) });
    const ws = new FakeSocket();
    await handleBrowserPaneSocket(ws, url('projectId=p1&url=http://127.0.0.2/'), owner.id, d);
    onEvent!({ type: 'browser-exit', streamId: 'browser_3', reason: 'This browser opened in another tab.', takenOver: true });
    expect(ws.sent).toContainEqual({ type: 'exit', reason: 'This browser opened in another tab.' });
    expect(ws.closed).toEqual({ code: 1008, reason: 'taken over' });
  });

  it('relays "Reset browser" to an agent that keeps profiles, and to no other', async () => {
    let d = deps({ agentCapabilities: vi.fn(() => [BROWSER_PANE_CAPABILITY, BROWSER_PANE_PROFILES_CAPABILITY]) });
    let ws = new FakeSocket();
    await handleBrowserPaneSocket(ws, url('projectId=p1&url=http://127.0.0.2/'), owner.id, d);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'reset-profile' })));
    expect(d.sendToStream).toHaveBeenCalledWith('browser_1', { type: 'browser-profile-reset' });
    d = deps();
    ws = new FakeSocket();
    await handleBrowserPaneSocket(ws, url('projectId=p1&url=http://127.0.0.2/'), owner.id, d);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'reset-profile' })));
    expect(d.sendToStream).not.toHaveBeenCalledWith('browser_1', { type: 'browser-profile-reset' });
  });

  it('relays a page\'s dialogs to a pane that asked for them, and its answer back', async () => {
    let onEvent: ((msg: any) => void) | null = null;
    const d = deps({ requestStream: vi.fn(async (_h, _o, cb) => { onEvent = cb; return 'browser_7'; }) });
    const ws = new FakeSocket();
    await handleBrowserPaneSocket(ws, url('projectId=p1&url=http://127.0.0.2/&dialogs=1'), owner.id, d);
    expect(d.requestStream.mock.calls[0][1]).toMatchObject({ relayDialogs: true });
    onEvent!({ type: 'browser-dialog', streamId: 'browser_7', id: 1, kind: 'confirm', message: 'Delete?' });
    onEvent!({ type: 'browser-dialog', streamId: 'browser_7', id: 2, kind: 'script', message: 'm'.repeat(3000), defaultPrompt: 'x' });
    onEvent!({ type: 'browser-dialog-closed', streamId: 'browser_7', id: 1 });
    expect(ws.sent.slice(1)).toEqual([
      { type: 'dialog', id: 1, kind: 'confirm', message: 'Delete?' },
      { type: 'dialog', id: 2, kind: 'alert', message: 'm'.repeat(2000), defaultPrompt: 'x' },
      { type: 'dialog-closed', id: 1 },
    ]);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'dialog', id: 1, accept: true })));
    expect(d.sendToStream).toHaveBeenCalledWith('browser_7', { type: 'browser-dialog-answer', id: 1, accept: true });
    // A pane that didn't ask gets the agent's own answers, as before.
    const d2 = deps();
    await handleBrowserPaneSocket(new FakeSocket(), url('projectId=p1&url=http://127.0.0.2/'), owner.id, d2);
    expect(d2.requestStream.mock.calls[0][1]).not.toHaveProperty('relayDialogs');
  });

  it('relays frames, navigation and exit down, and validated input up; closing the pane closes the stream', async () => {
    let onEvent: ((msg: any) => void) | null = null;
    const d = deps({ requestStream: vi.fn(async (_h, _o, cb) => { onEvent = cb; return 'browser_7'; }) });
    const ws = new FakeSocket();
    await handleBrowserPaneSocket(ws, url('projectId=p1&workstream=feat&url=http://127.0.0.2/&width=800&height=600'), owner.id, d);
    expect(ws.closed).toBeNull();
    expect(d.requestStream).toHaveBeenCalledWith({ userId: owner.id, instanceId: box.id }, { url: 'http://127.0.0.2/', width: 800, height: 600, paneKey: `${owner.id}:p1/feat` }, expect.any(Function));

    onEvent!({ type: 'browser-frame', streamId: 'browser_7', data: 'AAAA', width: 800, height: 600 });
    onEvent!({ type: 'browser-nav', streamId: 'browser_7', url: 'http://127.0.0.2/', title: 'Home', canGoBack: false, canGoForward: true });
    onEvent!({ type: 'browser-something-else', streamId: 'browser_7' });
    expect(ws.sent).toEqual([
      { type: 'ready' },
      { type: 'frame', data: 'AAAA', width: 800, height: 600 },
      { type: 'nav', url: 'http://127.0.0.2/', title: 'Home', canGoBack: false, canGoForward: true },
    ]);
    expect(d.sendToStream).toHaveBeenCalledWith('browser_7', { type: 'browser-frame-ack' });
    d.sendToStream.mockClear();

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', event: { kind: 'mouse', type: 'mousePressed', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 1 } })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'navigate', url: 'example.test' })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'history', action: 'reload' })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', width: 640, height: 480 })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'exec', cmd: 'rm -rf /' })));
    ws.emit('message', Buffer.from('garbage'));
    expect(d.sendToStream.mock.calls).toEqual([
      ['browser_7', { type: 'browser-input', event: { kind: 'mouse', type: 'mousePressed', x: 1, y: 2, button: 'left', buttons: 1, clickCount: 1, modifiers: 0 } }],
      ['browser_7', { type: 'browser-navigate', url: 'http://example.test/' }],
      ['browser_7', { type: 'browser-history', action: 'reload' }],
      ['browser_7', { type: 'browser-resize', width: 640, height: 480 }],
    ]);

    onEvent!({ type: 'browser-exit', streamId: 'browser_7', reason: 'browser exited (SIGKILL)' });
    expect(ws.sent[ws.sent.length - 1]).toEqual({ type: 'exit', reason: 'browser exited (SIGKILL)' });
    expect(ws.closed).toEqual({ code: 1000, reason: 'browser exited' });
    // The socket's close tells the agent to drop the browser (a no-op by then, but never skipped).
    expect(d.closeStream).toHaveBeenCalledWith('browser_7');
  });

  it('keeps input sent while the browser starts and relays it once the stream exists, then says ready', async () => {
    let resolveAttach: ((id: string) => void) | null = null;
    const d = deps({ requestStream: vi.fn(() => new Promise<string>((resolve) => { resolveAttach = resolve; })) });
    const ws = new FakeSocket();
    const done = handleBrowserPaneSocket(ws, url('projectId=p1'), owner.id, d);
    await new Promise((r) => setImmediate(r));
    expect(d.requestStream).toHaveBeenCalled();
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', event: { kind: 'text', text: 'early' } })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', width: 640, height: 480 })));
    ws.emit('message', Buffer.from('garbage'));
    expect(d.sendToStream).not.toHaveBeenCalled();
    expect(ws.sent).toEqual([]);
    resolveAttach!('browser_3');
    await done;
    expect(d.sendToStream.mock.calls).toEqual([
      ['browser_3', { type: 'browser-input', event: { kind: 'text', text: 'early' } }],
      ['browser_3', { type: 'browser-resize', width: 640, height: 480 }],
    ]);
    expect(ws.sent).toEqual([{ type: 'ready' }]);
  });

  it('acks a frame that lands before the attach has resolved, by the stream id the frame carries', async () => {
    let onEvent: ((msg: any) => void) | null = null;
    let resolveAttach: ((id: string) => void) | null = null;
    const d = deps({ requestStream: vi.fn((_h, _o, cb) => { onEvent = cb; return new Promise<string>((resolve) => { resolveAttach = resolve; }); }) });
    const ws = new FakeSocket();
    const done = handleBrowserPaneSocket(ws, url('projectId=p1'), owner.id, d);
    await new Promise((r) => setImmediate(r));
    // The agent's first frame (the snapshot on screencast start) often beats its attach reply.
    onEvent!({ type: 'browser-frame', streamId: 'browser_5', data: 'AAAA', width: 1024, height: 768 });
    expect(ws.sent).toEqual([{ type: 'frame', data: 'AAAA', width: 1024, height: 768 }]);
    expect(d.sendToStream).toHaveBeenCalledWith('browser_5', { type: 'browser-frame-ack' });
    resolveAttach!('browser_5');
    await done;
    expect(ws.sent[ws.sent.length - 1]).toEqual({ type: 'ready' });
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'history', action: 'back' })));
    expect(d.sendToStream).toHaveBeenLastCalledWith('browser_5', { type: 'browser-history', action: 'back' });
  });

  it('answers a suggest frame from the agent scan, with the project directory on the box as the hint', async () => {
    const d = deps({ suggest: vi.fn(async () => [{ url: 'http://127.0.0.2/', title: 'Sign in', status: 200 }]) });
    const ws = new FakeSocket();
    await handleBrowserPaneSocket(ws, url('projectId=p1&workstream=feat'), owner.id, d);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'suggest' })));
    await new Promise((r) => setImmediate(r));
    expect(d.suggest).toHaveBeenCalledWith({ userId: owner.id, instanceId: box.id }, '/home/boxuser/termag/projects/proj/.worktrees/feat');
    expect(ws.sent).toEqual([{ type: 'ready' }, { type: 'suggestions', items: [{ url: 'http://127.0.0.2/', title: 'Sign in', status: 200 }] }]);
    // A repeat straight after gets the same answer without another scan of the box.
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'suggest' })));
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'suggest' })));
    await new Promise((r) => setImmediate(r));
    expect(d.suggest).toHaveBeenCalledTimes(1);
    expect(ws.sent.filter((m) => m.type === 'suggestions')).toHaveLength(3);
    expect(d.sendToStream).not.toHaveBeenCalled();

    const failing = deps({ suggest: vi.fn(async () => { throw new Error('agent timed out'); }) });
    const ws2 = new FakeSocket();
    await handleBrowserPaneSocket(ws2, url('projectId=p1'), owner.id, failing);
    ws2.emit('message', Buffer.from(JSON.stringify({ type: 'suggest' })));
    await new Promise((r) => setImmediate(r));
    expect(ws2.sent[ws2.sent.length - 1]).toEqual({ type: 'suggestions', items: [] });
  });

  it('reports an attach failure as 1011 and drops a stream whose viewer left during the attach', async () => {
    const failing = new FakeSocket();
    await handleBrowserPaneSocket(failing, url('projectId=p1'), owner.id, deps({ requestStream: vi.fn(async () => { throw new Error('no Chromium on this box'); }) }));
    expect(failing.sent).toEqual([{ type: 'exit', reason: 'Could not start a browser on the box: no Chromium on this box' }]);
    expect(failing.closed).toEqual({ code: 1011, reason: 'agent error' });

    const gone = new FakeSocket();
    const d = deps({ requestStream: vi.fn(async () => { gone.close(1001, 'going away'); return 'browser_9'; }) });
    await handleBrowserPaneSocket(gone, url('projectId=p1'), owner.id, d);
    expect(d.closeStream).toHaveBeenCalledTimes(1);
    expect(d.closeStream).toHaveBeenCalledWith('browser_9');
    expect(gone.sent).toEqual([]);
  });
});

// ── The guest path ──────────────────────────────────

describe('handleBrowserPaneSocket: a reviewer\'s guest pane', () => {
  const NOW = Date.parse('2026-10-20T12:00:00Z');
  const guestUser = { id: 'u-guest', unixUsername: 'guest', displayName: 'Gus' } as User;
  const stranger = { id: 'u-stranger', unixUsername: 'sam', displayName: 'Sam' } as User;
  const ownerUser = { ...owner, displayName: 'Olive' } as User;
  const share = (over: Record<string, unknown> = {}) => ({
    id: 'cshare0000000001', projectId: 'p1', workstreamId: 'ws1', ownerId: owner.id, audience: 'user', granteeId: guestUser.id,
    originRecipe: { kind: 'webapp-dev-stack' }, expiresAt: new Date(NOW + 3600e3), revokedAt: null, endedAt: null, endedReason: null,
    lastOpenedAt: null, createdAt: new Date(NOW), ...over,
  });
  const ctx = (over: Record<string, unknown> = {}, shareOver: Record<string, unknown> = {}) => ({
    share: share(shareOver), owner: ownerUser, workstream: { name: 'feature-x', archived: false },
    project: { id: 'p1', name: 'proj', userId: owner.id, archived: false, instanceId: box.id, setupStatus: 'ready', ownerUnixUsername: 'owner', instance: { ...box, hostHome: '/home/boxuser' } as Instance },
    ...over,
  });
  const guestCaps = [BROWSER_PANE_CAPABILITY, BROWSER_PANE_GUEST_CAPABILITY, BROWSER_PANE_PROFILES_CAPABILITY];
  const guestDeps = (over: Partial<BrowserWsDeps> = {}) => deps({
    findUser: vi.fn(async (id) => [owner, friend, guestUser, stranger].find(u => u.id === id) ?? null),
    guestContext: vi.fn(async () => ctx() as any),
    agentCapabilities: vi.fn(() => guestCaps),
    ...over,
  });
  const open = async (d: BrowserWsDeps, q: string, as: string) => {
    const ws = new FakeSocket();
    await handleBrowserPaneSocket(ws, url(q), as, d);
    return ws;
  };

  it('opens a guest browser kept to the share: its own key, the share\'s recipe, the checkout, the pool size, the expiry', async () => {
    const d = guestDeps({ keptProfilesOn: vi.fn(async () => true) });
    const ws = await open(d, 'share=cshare0000000001&width=900&height=700&at=%2Fdefault%2Fflags', guestUser.id);
    expect(ws.closed).toBeNull();
    expect(d.requestStream).toHaveBeenCalledWith({ userId: owner.id, instanceId: box.id }, {
      url: 'about:blank', width: 900, height: 700, paneKey: 'guest:cshare0000000001:u-guest', mode: 'guest',
      recipe: { kind: 'webapp-dev-stack' }, cwd: '/home/boxuser/termag/projects/proj/.worktrees/feature-x', maxGuestPanes: 5,
      profileExpiresAt: new Date(NOW + 3600e3).toISOString(), atPath: '/default/flags', persistProfile: true,
    }, expect.any(Function));
    expect(d.noteShareOpened).toHaveBeenCalledWith('cshare0000000001', 'u-guest');
    expect(d.registerGuest).toHaveBeenCalledWith('cshare0000000001', expect.any(Object));
    expect(ws.sent).toContainEqual({ type: 'ready' });
  });

  it('gives anyone the share isn\'t for the same refusal, owner and collaborator included, and records nothing', async () => {
    for (const who of [stranger.id, friend.id, owner.id]) {
      const d = guestDeps();
      const ws = await open(d, 'share=cshare0000000001', who);
      expect(ws.closed).toEqual({ code: 4410, reason: 'not-shared' });
      expect(ws.sent).toEqual([{ type: 'exit', reason: "This preview isn't shared with you." }]);
      expect(d.requestStream).not.toHaveBeenCalled();
      expect(d.recordShareEvent).not.toHaveBeenCalled();
    }
    const unknown = await open(guestDeps({ guestContext: vi.fn(async () => null) }), 'share=cshare0000000001', guestUser.id);
    expect(unknown.closed).toEqual({ code: 4410, reason: 'not-shared' });
    const garbage = await open(guestDeps(), 'share=../x', guestUser.id);
    expect(garbage.closed).toEqual({ code: 4410, reason: 'not-shared' });
  });

  it('tells the grantee why, and records the refusal', async () => {
    const d = guestDeps({ guestContext: vi.fn(async () => ctx({}, { expiresAt: new Date(NOW - 1) }) as any) });
    const ws = await open(d, 'share=cshare0000000001', guestUser.id);
    expect(ws.closed).toEqual({ code: 4410, reason: 'expired' });
    expect(ws.sent[0].reason).toMatch(/expired/);
    expect(d.recordShareEvent).toHaveBeenCalledWith('cshare0000000001', 'refused', { actorId: 'u-guest', reason: 'expired' });
  });

  it('opens an owner\'s own share link on the share\'s app: its recipe and path go to the agent, for this project and workstream only', async () => {
    // The owner's pane, dialed by the link's handoff: the recipe rides the attach.
    let d = guestDeps();
    await open(d, 'projectId=p1&workstream=feature-x&url=http://127.0.0.1:3000/&openShare=cshare0000000001&at=%2Fflags', owner.id);
    expect(d.requestStream.mock.calls[0][1]).toMatchObject({
      paneKey: `${owner.id}:p1/feature-x`, url: 'http://127.0.0.1:3000/', openRecipe: { kind: 'webapp-dev-stack' }, atPath: '/flags', cwd: '/home/boxuser/termag/projects/proj/.worktrees/feature-x',
    });
    expect(d.requestStream.mock.calls[0][1]).not.toHaveProperty('mode');
    // Another workstream's pane, an unsafe path, an unknown share: nothing extra.
    d = guestDeps();
    await open(d, 'projectId=p1&workstream=main&url=about:blank&openShare=cshare0000000001&at=%2Fflags', owner.id);
    expect(d.requestStream.mock.calls[0][1]).not.toHaveProperty('openRecipe');
    d = guestDeps();
    await open(d, 'projectId=p1&workstream=feature-x&url=about:blank&openShare=cshare0000000001&at=%2F%2Fevil', owner.id);
    expect(d.requestStream.mock.calls[0][1]).toMatchObject({ openRecipe: { kind: 'webapp-dev-stack' } });
    expect(d.requestStream.mock.calls[0][1]).not.toHaveProperty('atPath');
    d = guestDeps({ guestContext: vi.fn(async () => null) });
    await open(d, 'projectId=p1&workstream=feature-x&url=about:blank&openShare=cshare0000000001', owner.id);
    expect(d.requestStream.mock.calls[0][1]).not.toHaveProperty('openRecipe');
    // A full collaborator's link opens their own pane on the share's app too.
    d = guestDeps();
    await open(d, 'projectId=p1&workstream=feature-x&url=about:blank&openShare=cshare0000000001&at=%2Fflags', friend.id);
    expect(d.requestStream.mock.calls[0][1]).toMatchObject({ paneKey: `${friend.id}:p1/feature-x`, openRecipe: { kind: 'webapp-dev-stack' }, atPath: '/flags' });
    // A revoked, ended or expired share opens nothing of its own.
    for (const over of [{ revokedAt: new Date(NOW) }, { endedAt: new Date(NOW), endedReason: 'merged' }, { expiresAt: new Date(NOW - 1) }]) {
      d = guestDeps({ guestContext: vi.fn(async () => ctx({}, over) as any) });
      await open(d, 'projectId=p1&workstream=feature-x&url=about:blank&openShare=cshare0000000001&at=%2Fflags', owner.id);
      expect(d.requestStream.mock.calls[0][1], JSON.stringify(over)).not.toHaveProperty('openRecipe');
    }
  });

  it('lets the owner preview a link share as its guest would (no grantee to stand in for), and never relays a reviewer\'s reset', async () => {
    let d = guestDeps({ guestContext: vi.fn(async () => ctx({}, { audience: 'link', granteeId: null }) as any) });
    const ws = await open(d, 'share=cshare0000000001&as=guest&url=about:blank', owner.id);
    expect(d.requestStream).toHaveBeenCalled();
    expect(d.requestStream.mock.calls[0][1]).toMatchObject({ mode: 'guest', paneKey: `guest:cshare0000000001:${owner.id}` });
    // A reviewer's client asking to reset: their kept profile is the share's to forget.
    d = guestDeps();
    const guestWs = await open(d, 'share=cshare0000000001&url=about:blank', guestUser.id);
    guestWs.emit('message', Buffer.from(JSON.stringify({ type: 'reset-profile' })));
    expect(d.sendToStream).not.toHaveBeenCalledWith(expect.anything(), { type: 'browser-profile-reset' });
    void ws;
  });

  it('lets a link share\'s viewer in by their viewer row, under their own name, and nobody without one', async () => {
    const link = (viewerRow: { revokedAt: Date | null } | null) => guestDeps({ guestContext: vi.fn(async () => ({ ...ctx({}, { audience: 'link', granteeId: null }), viewerRow }) as any) });
    let d = link({ revokedAt: null });
    let ws = await open(d, 'share=cshare0000000001&url=about:blank', guestUser.id);
    expect(ws.closed).toBeNull();
    expect(d.guestContext).toHaveBeenCalledWith('cshare0000000001', guestUser.id);
    expect(d.requestStream.mock.calls[0][1]).toMatchObject({ mode: 'guest', paneKey: `guest:cshare0000000001:${guestUser.id}` });
    expect(d.registerGuest).toHaveBeenCalledWith('cshare0000000001', expect.objectContaining({ viewerId: guestUser.id }));
    d = link(null);
    ws = await open(d, 'share=cshare0000000001&url=about:blank', guestUser.id);
    expect(ws.closed).toEqual({ code: 4410, reason: 'not-shared' });
    expect(d.requestStream).not.toHaveBeenCalled();
    d = link({ revokedAt: new Date(NOW) });
    ws = await open(d, 'share=cshare0000000001&url=about:blank', guestUser.id);
    expect(ws.closed).toEqual({ code: 4410, reason: 'viewer-revoked' });
  });

  it('lets the owner preview their own share as its guest would, without counting it as an open', async () => {
    const d = guestDeps();
    const ws = await open(d, 'share=cshare0000000001&as=guest', owner.id);
    expect(ws.closed).toBeNull();
    expect(d.requestStream.mock.calls[0][1]).toMatchObject({ mode: 'guest', paneKey: `guest:cshare0000000001:${owner.id}` });
    expect(d.noteShareOpened).not.toHaveBeenCalled();
  });

  it('refuses while the flags are off or the kill switch is on, a box asleep or not ready, an agent without guests', async () => {
    let ws = await open(guestDeps({ guestFlags: vi.fn(async () => ({ paneOn: true, sharingOn: true, killed: true, maxGuests: 5 })) }), 'share=cshare0000000001', guestUser.id);
    expect(ws.closed).toEqual({ code: BROWSER_PANE_DISABLED_CLOSE_CODE, reason: 'guests off' });
    ws = await open(guestDeps({ guestFlags: vi.fn(async () => ({ paneOn: true, sharingOn: false, killed: false, maxGuests: 5 })) }), 'share=cshare0000000001', guestUser.id);
    expect(ws.closed).toEqual({ code: BROWSER_PANE_DISABLED_CLOSE_CODE, reason: 'preview sharing off' });
    const asleep = guestDeps({ boxStatus: vi.fn(async () => 'hibernated'), agentConnected: vi.fn(() => false) });
    ws = await open(asleep, 'share=cshare0000000001', guestUser.id);
    expect(ws.closed).toEqual({ code: TERMINAL_BOX_PARKED_CLOSE_CODE, reason: 'box asleep' });
    expect(ws.sent[0].reason).toBe("Olive's box is asleep.");
    expect(asleep.recordShareEvent).toHaveBeenCalledWith('cshare0000000001', 'refused', { actorId: 'u-guest', reason: 'box-asleep' });
    ws = await open(guestDeps({ agentConnected: vi.fn(() => false) }), 'share=cshare0000000001', guestUser.id);
    expect(ws.closed).toEqual({ code: BROWSER_PANE_RETRY_CLOSE_CODE, reason: 'agent not connected' });
    ws = await open(guestDeps({ agentCapabilities: vi.fn(() => [BROWSER_PANE_CAPABILITY]) }), 'share=cshare0000000001', guestUser.id);
    expect(ws.closed).toEqual({ code: BROWSER_PANE_UNSUPPORTED_CLOSE_CODE, reason: 'guest pane unsupported' });
  });

  it('maps the agent\'s guest refusals: busy redials, a missing dev stack is final', async () => {
    let ws = await open(guestDeps({ requestStream: vi.fn(async () => { throw new Error('guest-busy: 5 reviewers are already using this preview'); }) }), 'share=cshare0000000001', guestUser.id);
    expect(ws.closed).toEqual({ code: 4429, reason: 'busy' });
    ws = await open(guestDeps({ requestStream: vi.fn(async () => { throw new Error('guest-stack:other-workstream'); }) }), 'share=cshare0000000001', guestUser.id);
    expect(ws.closed).toEqual({ code: 4424, reason: 'agent refused' });
    expect(ws.sent[0].reason).toMatch(/another workstream/);
  });

  it('relays the guest\'s blocked addresses and checkout, records a missing loopback origin once, and never answers suggest', async () => {
    let onEvent: ((msg: any) => void) | null = null;
    const d = guestDeps({ requestStream: vi.fn(async (_h, _o, cb) => { onEvent = cb; return 'browser_9'; }) });
    const ws = await open(d, 'share=cshare0000000001', guestUser.id);
    onEvent!({ type: 'browser-blocked', streamId: 'browser_9', origin: '127.0.0.2:9000', local: true });
    onEvent!({ type: 'browser-blocked', streamId: 'browser_9', origin: '127.0.0.2:9000', local: true });
    onEvent!({ type: 'browser-blocked', streamId: 'browser_9', origin: 'sentry.io:443', local: false });
    onEvent!({ type: 'browser-checkout', streamId: 'browser_9', branch: 'feature-x', head: 'abc123', dirty: 2 });
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'suggest' })));
    expect(ws.sent).toContainEqual({ type: 'blocked', origin: '127.0.0.2:9000', local: true });
    expect(ws.sent).toContainEqual({ type: 'blocked', origin: 'sentry.io:443', local: false });
    expect(ws.sent).toContainEqual({ type: 'checkout', branch: 'feature-x', head: 'abc123', dirty: 2 });
    expect(ws.sent.some((m) => m.type === 'suggestions')).toBe(false);
    expect(d.suggest).not.toHaveBeenCalled();
    expect(d.recordShareEvent).toHaveBeenCalledTimes(1);
    expect(d.recordShareEvent).toHaveBeenCalledWith('cshare0000000001', 'blocked-origin', { detail: { origin: '127.0.0.2:9000' } });
  });

  it('a revoke while the guest browser starts closes the socket too, and leaves no re-check running', async () => {
    let handle: { close(m: string): void } | null = null;
    let answer: (id: string) => void = () => {};
    const unregister = vi.fn();
    const d = guestDeps({
      registerGuest: vi.fn((_id, h) => { handle = h; return unregister; }),
      requestStream: vi.fn(() => new Promise<string>((r) => { answer = r; })),
      recheckMs: 10,
    });
    const ws = new FakeSocket();
    const opening = handleBrowserPaneSocket(ws, url('share=cshare0000000001'), guestUser.id, d);
    await new Promise((r) => setTimeout(r, 5));
    expect(handle).not.toBeNull();
    handle!.close('Its owner stopped sharing this preview.');
    expect(ws.closed).toEqual({ code: 4410, reason: 'share ended' });
    answer('browser_5');
    await opening;
    expect(d.closeStream).toHaveBeenCalledWith('browser_5');
    expect(unregister).toHaveBeenCalled();
    const calls = d.guestContext.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(d.guestContext.mock.calls.length).toBe(calls);
  });

  it('closes a live guest when its share is revoked here, and at the next re-check when it ends anywhere else', async () => {
    let handle: { close(m: string): void } | null = null;
    const d = guestDeps({ registerGuest: vi.fn((_id, h) => { handle = h; return () => {}; }) });
    const ws = await open(d, 'share=cshare0000000001', guestUser.id);
    handle!.close('Its owner stopped sharing this preview.');
    expect(ws.closed).toEqual({ code: 4410, reason: 'share ended' });

    let revoked = false;
    const later = guestDeps({ recheckMs: 20, guestContext: vi.fn(async () => (revoked ? ctx({}, { revokedAt: new Date(NOW) }) : ctx()) as any) });
    const ws2 = await open(later, 'share=cshare0000000001', guestUser.id);
    expect(ws2.closed).toBeNull();
    revoked = true;
    await new Promise((r) => setTimeout(r, 60));
    expect(ws2.closed).toEqual({ code: 4410, reason: 'revoked' });
  });

  it('has a live guest redial (not end) when its share\'s recipe changes, here at once and at the next re-check anywhere else', async () => {
    let handle: { reconnect(): void } | null = null;
    const d = guestDeps({ registerGuest: vi.fn((_id, h) => { handle = h; return () => {}; }) });
    const ws = await open(d, 'share=cshare0000000001', guestUser.id);
    handle!.reconnect();
    expect(ws.closed).toEqual({ code: 1012, reason: 'share updated' });

    let recipe: unknown = { kind: 'webapp-dev-stack' };
    const later = guestDeps({ recheckMs: 20, guestContext: vi.fn(async () => ctx({}, { originRecipe: recipe }) as any) });
    const ws2 = await open(later, 'share=cshare0000000001', guestUser.id);
    await new Promise((r) => setTimeout(r, 50));
    expect(ws2.closed, 'the same recipe: left alone').toBeNull();
    recipe = { kind: 'manual', origins: ['127.0.0.2:8080'] };
    await new Promise((r) => setTimeout(r, 60));
    expect(ws2.closed).toEqual({ code: 1012, reason: 'share updated' });
  });
});

