import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));

const { paneSubagentsHandlers, parsePaneSubagents, PANE_SUBAGENTS_CAPABILITY } = await import('./chatPaneSubagents');
type Deps = NonNullable<Parameters<typeof paneSubagentsHandlers>[0]>;

const HOST = { userId: 'owner', instanceId: 'box-1' };
const SESSION = 'ada-sample-agent';
const SID = '13013c9a-894d-42b2-9d67-3e918a88fb3c';
const USER = { id: 'u1', googleEmail: 'ada@example.com', displayName: 'Ada', unixUsername: 'ada' } as never;
const SUB = {
  agentId: 'ac9afc6661520867b', toolUseId: 'toolu_01', agentType: 'Explore', description: 'Find flaky tests', background: true, model: 'sonnet',
  finished: true, startedAt: '2026-11-05T16:41:00.000Z', updatedAt: '2026-11-05T16:41:30.000Z', prompt: 'Find the flaky tests', report: 'Two are flaky.',
};
const LIST = { running: true, session: { sessionId: SID, cwd: '/home/ada/termag/projects/sample', startedAt: 1793897081612 }, subagents: [SUB], alongside: [] };

function deps(over: Partial<Deps> = {}): Deps & { sent: Array<{ type: string; payload: unknown }> } {
  const sent: Array<{ type: string; payload: unknown }> = [];
  return {
    sent,
    enabled: async () => true,
    find: async () => ({ host: HOST, session: SESSION }),
    connected: () => true,
    capabilities: () => [PANE_SUBAGENTS_CAPABILITY],
    send: async (_h, type, payload) => { sent.push({ type, payload }); return type === 'pane-subagents' ? LIST : { found: true, entries: [{ type: 'user' }] }; },
    ...over,
  };
}

describe('GET …/chat/pane-subagents', () => {
  it('asks the box about the workstream\'s agent pane and passes on what it says, its cwd left out', async () => {
    const d = deps();
    const r = await paneSubagentsHandlers(d).list('u1', 'p1', { workstream: 'main' }, USER);
    expect(d.sent).toEqual([{ type: 'pane-subagents', payload: { session: SESSION } }]);
    expect(r).toEqual({ status: 200, body: { available: true, running: true, session: { sessionId: SID, startedAt: 1793897081612 }, subagents: [SUB], alongside: [] } });
  });

  it('is 404 with the flag off, and asks nothing', async () => {
    const d = deps({ enabled: async () => false });
    expect(await paneSubagentsHandlers(d).list('u1', 'p1', {}, USER)).toEqual({ status: 404, body: { error: 'Not found', code: 'pane-subagents-off' } });
    expect(d.sent).toEqual([]);
  });

  it('passes on a refusal to find the project or workstream', async () => {
    const r = await paneSubagentsHandlers(deps({ find: async () => ({ status: 404, body: { error: 'Project not found' } }) })).list('u1', 'p1', {}, USER);
    expect(r.status).toBe(404);
  });

  it('degrades quietly: a box away, an agent without the RPC, or a failed or odd answer is unavailable', async () => {
    const list = (over: Partial<Deps>) => paneSubagentsHandlers(deps(over)).list('u1', 'p1', {}, USER);
    expect((await list({ connected: () => false })).body).toEqual({ available: false, reason: 'offline' });
    expect((await list({ capabilities: () => ['chat-subagents-v1'] })).body).toEqual({ available: false, reason: 'outdated-agent' });
    expect((await list({ send: async () => { throw new Error('Unknown command: pane-subagents'); } })).body).toEqual({ available: false, reason: 'unreadable' });
    expect((await list({ send: async () => 'nonsense' })).body).toEqual({ available: false, reason: 'unreadable' });
  });
});

describe('parsePaneSubagents', () => {
  it('keeps only well-formed subagents and sessions, and none without a session', () => {
    const r = parsePaneSubagents({
      ...LIST,
      subagents: [SUB, { agentId: '../x' }, null, { agentId: 'b2', description: 7, startedAt: 'not a date', background: 'yes' }],
      alongside: [{ sessionId: '496bb91b-2f1d-42c9-a973-a47b0e6600fc', startedAt: 1, updatedAt: '2026-11-05T16:40:05.000Z', title: 'Review it' }, { sessionId: 'a/b' }],
    });
    expect(r.available && r.subagents.map(s => s.agentId)).toEqual(['ac9afc6661520867b', 'b2']);
    expect(r.available && r.subagents[1]).toMatchObject({ description: null, startedAt: null, background: false });
    expect(r.available && r.alongside.map(a => a.sessionId)).toEqual(['496bb91b-2f1d-42c9-a973-a47b0e6600fc']);
    expect(parsePaneSubagents({ running: true, session: null, subagents: [SUB], alongside: [] })).toEqual({ available: true, running: true, session: null, subagents: [], alongside: [] });
    expect(parsePaneSubagents({ running: false, session: { sessionId: '../x' }, subagents: [] })).toMatchObject({ available: true, session: null });
  });
});

describe('GET …/chat/pane-subagents/:agentId', () => {
  it('reads the subagent\'s transcript from the pane\'s session', async () => {
    const d = deps();
    const r = await paneSubagentsHandlers(d).read('u1', 'p1', 'ac9afc6661520867b', { workstream: 'main' }, USER);
    expect(d.sent).toEqual([{ type: 'pane-subagent-read', payload: { session: SESSION, agentId: 'ac9afc6661520867b' } }]);
    expect(r).toEqual({ status: 200, body: { agentId: 'ac9afc6661520867b', entries: [{ type: 'user' }] } });
  });

  it('answers as the chat\'s subagent route does, in words the agent tab has', async () => {
    const read = (over: Partial<Deps>, id = 'ac9afc6661520867b') => paneSubagentsHandlers(deps(over)).read('u1', 'p1', id, {}, USER);
    expect((await read({ enabled: async () => false })).status).toBe(404);
    expect((await read({}, '../etc')).status).toBe(400);
    expect((await read({ connected: () => false })).body).toMatchObject({ code: 'box-away' });
    expect((await read({ capabilities: () => [] })).body).toMatchObject({ code: 'runner-update' });
    expect((await read({ send: async () => ({ found: false, entries: [] }) })).body).toMatchObject({ code: 'subagent-missing' });
    expect((await read({ send: async () => { throw new Error('Agent not connected'); } })).body).toMatchObject({ code: 'box-away' });
    expect((await read({ send: async () => { throw new Error('bad agentId'); } })).status).toBe(502);
  });
});

describe('GET …/chat/pane-sessions/:sessionId', () => {
  const SIDE = '496bb91b-2f1d-42c9-a973-a47b0e6600fc';
  it('reads a session running alongside, scoped by the box to the pane\'s directory', async () => {
    const d = deps();
    const r = await paneSubagentsHandlers(d).session('u1', 'p1', SIDE, { workstream: 'main' }, USER);
    expect(d.sent).toEqual([{ type: 'pane-session-read', payload: { session: SESSION, sessionId: SIDE } }]);
    expect(r).toEqual({ status: 200, body: { sessionId: SIDE, entries: [{ type: 'user' }] } });
  });

  it('refuses what isn\'t a session id, and answers as the subagent read does otherwise', async () => {
    const read = (over: Partial<Deps>, id = SIDE) => paneSubagentsHandlers(deps(over)).session('u1', 'p1', id, {}, USER);
    expect((await read({ enabled: async () => false })).status).toBe(404);
    expect((await read({}, '../../etc/passwd')).status).toBe(400);
    expect((await read({ connected: () => false })).body).toMatchObject({ code: 'box-away' });
    expect((await read({ capabilities: () => [] })).body).toMatchObject({ code: 'runner-update' });
    expect((await read({ send: async () => ({ found: false, entries: [] }) })).body).toMatchObject({ code: 'session-missing' });
  });
});
