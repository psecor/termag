import { describe, expect, it } from 'vitest';
import { chatRevokeError, deadChatKeys, revokeChats } from './chatRevoke';

const projects = [
  { id: 'p1', archived: false, workstreams: [{ id: 'w1', archived: false }, { id: 'w-old', archived: true }] },
  { id: 'p-arch', archived: true, workstreams: [{ id: 'w2', archived: false }] },
];

describe('deadChatKeys', () => {
  const keys = [
    { chatKey: 'p1--w1', projectId: 'p1', workstreamId: 'w1' },
    { chatKey: 'p1--w-old', projectId: 'p1', workstreamId: 'w-old' },
    { chatKey: 'p1--gone', projectId: 'p1', workstreamId: 'gone' },
    { chatKey: 'p-arch--w2', projectId: 'p-arch', workstreamId: 'w2' },
    { chatKey: 'missing--w', projectId: 'missing', workstreamId: 'w' },
  ];

  it('refuses an archived project, a missing project, and a workstream that is gone or archived', () => {
    expect(deadChatKeys(projects, keys)).toEqual(['p1--w-old', 'p1--gone', 'p-arch--w2', 'missing--w']);
  });

  it('keeps a live workstream', () => {
    expect(deadChatKeys(projects, [keys[0]])).toEqual([]);
  });
});

describe('chatRevokeError', () => {
  it('blocks a connected box whose turn is still running, skipped, or failed', () => {
    expect(chatRevokeError(true, [{ workstream: 'w1', cleared: 0, stopped: false }])).toMatch(/w1/);
    expect(chatRevokeError(true, [{ workstream: 'w1', skipped: 'runner-missing' }])).toMatch(/runner-missing/);
    expect(chatRevokeError(true, [{ workstream: 'w1', error: 'boom' }])).toMatch(/boom/);
  });

  it('allows a connected box that stopped every turn, including one that was idle', () => {
    expect(chatRevokeError(true, [
      { workstream: 'w1', cleared: 1, stopped: true },
      { workstream: 'w2', cleared: 0, stopped: true },
    ])).toBeNull();
    expect(chatRevokeError(true, [])).toBeNull();
  });

  it('allows an offline archive, and blocks an offline host that will not be destroyed', () => {
    expect(chatRevokeError(false, [{ workstream: 'w1', skipped: 'offline' }])).toBeNull();
    expect(chatRevokeError(false, [], { offlineBlocks: true })).toMatch(/offline/);
  });
});

describe('revokeChats', () => {
  it('clears by workstream id and fails the revoke when a turn is still running', async () => {
    const calls: string[] = [];
    const send = async (type: string, payload: Record<string, unknown>) => {
      calls.push(`${type}:${payload.chatKey}`);
      return payload.chatKey === 'p1--w1' ? { cleared: 0, stopped: true } : { cleared: 1, stopped: false };
    };
    expect(await revokeChats(send, true, 'p1', ['w1', 'w2'])).toMatch(/w2/);
    expect(calls).toEqual(['chat-clear:p1--w1', 'chat-clear:p1--w2']);
  });

  it('does not call the box when it is offline, and blocks when the host survives', async () => {
    let called = false;
    const send = async () => { called = true; return { cleared: 0, stopped: true }; };
    expect(await revokeChats(send, false, 'p1', ['w1'])).toBeNull();
    expect(await revokeChats(send, false, 'p1', ['w1'], { offlineBlocks: true })).toMatch(/offline/);
    expect(called).toBe(false);
  });
});
