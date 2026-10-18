import { describe, expect, it } from 'vitest';
import { chatKeyFor, chatRequireCheckout, chatRpcFailure, chatTargetError, chatTextError, clearChatsOnBox, mayReceiveChat, reconcileChatStatus, statusForChatEvent, sweepStaleChatStatus, toolCallLabel, CHAT_STATUS_SOURCE } from './chatRunner';
import { sessionBelongsToUser, sessionName } from './tmux';
import { getStatus, setStatus } from './status';

describe('chatKeyFor', () => {
  it('is a flat name the box agent accepts', () => {
    // Keyed by the workstream id, not its name, so a rename keeps the key.
    expect(chatKeyFor('cmva5ktbm000cjuwdffqdnfnm', 'cmvwrk0000workstreamid1')).toBe('cmva5ktbm000cjuwdffqdnfnm--cmvwrk0000workstreamid1');
    expect(chatKeyFor('p1', 'ws1')).toMatch(/^[A-Za-z0-9_.-]+$/);
  });
});

describe('chatTextError', () => {
  it('wants some text, not too much', () => {
    expect(chatTextError('fix the bug')).toBeNull();
    expect(chatTextError('   ')).toBe('text is required');
    expect(chatTextError(undefined)).toBe('text is required');
    expect(chatTextError('x'.repeat(100_001))).toMatch(/longer than/);
  });
});

describe('toolCallLabel', () => {
  it('names the tool and its main argument', () => {
    expect(toolCallLabel('Bash', { command: 'npm test', description: 'Run the tests' })).toBe('Bash(npm test)');
    expect(toolCallLabel('Read', { file_path: '/w/src/app.ts' })).toBe('Read(/w/src/app.ts)');
    expect(toolCallLabel('Grep', { pattern: 'TODO' })).toBe('Grep(TODO)');
    expect(toolCallLabel('TodoWrite', { todos: [] })).toBe('TodoWrite');
    expect(toolCallLabel('Bash', { command: `echo ${'a'.repeat(100)}` })).toMatch(/^Bash\(echo a+…\)$/);
  });
});

describe('statusForChatEvent', () => {
  it('works from the turn start, names each tool call, rests at the turn end', () => {
    expect(statusForChatEvent({ type: 'turn-start', text: 'hi' })).toEqual({ status: 'working', message: 'Thinking' });
    expect(statusForChatEvent({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] },
    })).toEqual({ status: 'working', message: 'Bash(ls -la)' });
    expect(statusForChatEvent({ type: 'turn-end', exitCode: 0 })).toEqual({ status: 'idle' });
  });

  it('leaves the status alone for everything else', () => {
    expect(statusForChatEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } })).toBeNull();
    expect(statusForChatEvent({ type: 'stream_event', event: {} })).toBeNull();
    expect(statusForChatEvent({ type: 'result' })).toBeNull();
    expect(statusForChatEvent(null)).toBeNull();
  });
});

describe('chatRpcFailure', () => {
  it('names an old agent and a checkout still running, and passes anything else on', () => {
    expect(chatRpcFailure('Unknown command: chat-send')).toMatchObject({ status: 409, body: { code: 'runner-missing' } });
    expect(chatRpcFailure('checkout-pending: the repository is still being checked out')).toMatchObject({ status: 409, body: { code: 'checkout-pending' } });
    expect(chatRpcFailure('chat-clearing: this chat is being stopped')).toMatchObject({ status: 409, body: { code: 'chat-clearing' } });
    expect(chatRpcFailure('cwd must be absolute')).toEqual({ status: 502, body: { error: 'cwd must be absolute' } });
  });
});

describe('mayReceiveChat', () => {
  const viewer = (unixUsername: string, sharedProjectIds: string[] = []) => ({ unixUsername, sharedProjectIds: new Set(sharedProjectIds) });
  const proj = { owner: 'alice-smith', projectId: 'p-proj' };
  const other = { owner: 'alice-smith', projectId: 'p-other' };

  it('a user whose name prefixes the owner\'s gets nothing, though the status pill prefix matches', () => {
    const session = sessionName('alice-smith', 'proj', 'agent');
    expect(session).toBe('alice-smith-proj-agent');
    expect(sessionBelongsToUser(session, 'alice')).toBe(true);
    expect(mayReceiveChat(proj, viewer('alice'))).toBe(false);
  });

  it('the owner gets every one of their chats, by exact name', () => {
    expect(mayReceiveChat(proj, viewer('alice-smith'))).toBe(true);
    expect(mayReceiveChat(other, viewer('alice-smith'))).toBe(true);
    expect(mayReceiveChat({ owner: 'alice', projectId: 'p-a' }, viewer('alice-smith'))).toBe(false);
  });

  it('a user shared on one of alice-smith\'s projects gets that project\'s frames and none of her others', () => {
    const bob = viewer('bob', ['p-proj']);
    expect(mayReceiveChat(proj, bob)).toBe(true);
    expect(mayReceiveChat(other, bob)).toBe(false);
    expect(mayReceiveChat(other, viewer('carol'))).toBe(false);
  });

  it('compares the raw unix username, so a dotted owner is not a different user with an underscore', () => {
    expect(mayReceiveChat({ owner: 'jane.doe', projectId: 'p' }, viewer('jane.doe'))).toBe(true);
    // jane_doe and jane.doe are different accounts: tmuxSafeName would fold them together.
    expect(mayReceiveChat({ owner: 'jane.doe', projectId: 'p' }, viewer('jane_doe'))).toBe(false);
    expect(mayReceiveChat({ owner: 'jane.doe', projectId: 'p' }, viewer('bob', ['p']))).toBe(true);
  });
});

describe('reconcileChatStatus', () => {
  it('settles a chat-runner session stuck working, and leaves others alone', () => {
    setStatus('recon-stuck-agent', 'working', { source: CHAT_STATUS_SOURCE }, undefined, null);
    reconcileChatStatus('recon-stuck-agent', null);
    expect(getStatus('recon-stuck-agent').status).toBe('idle');

    // A pane turn (not chat-runner) is not the chat's to settle.
    setStatus('recon-pane-agent', 'working', { source: 'claude' }, undefined, null);
    reconcileChatStatus('recon-pane-agent', null);
    expect(getStatus('recon-pane-agent').status).toBe('working');
  });
});

describe('sweepStaleChatStatus', () => {
  it('idles a chat-runner session left working past the window, not a fresh one', () => {
    setStatus('sweep-stale-agent', 'working', { source: CHAT_STATUS_SOURCE }, undefined, null);
    setStatus('sweep-fresh-agent', 'working', { source: CHAT_STATUS_SOURCE }, undefined, null);
    // Ten minutes on, the stale one is swept; re-stamped now, the fresh one holds.
    const future = Date.now() + 10 * 60_000;
    setStatus('sweep-fresh-agent', 'working', { source: CHAT_STATUS_SOURCE }, undefined, null);
    const freshAt = getStatus('sweep-fresh-agent').updatedAt.getTime();
    const swept = sweepStaleChatStatus(freshAt + 1);
    expect(getStatus('sweep-fresh-agent').status).toBe('working');
    expect(swept).toBeGreaterThanOrEqual(0);
    expect(sweepStaleChatStatus(future)).toBeGreaterThanOrEqual(0);
    expect(getStatus('sweep-stale-agent').status).toBe('idle');
    expect(getStatus('sweep-fresh-agent').status).toBe('idle');
  });
});

describe('chatTargetError', () => {
  const ok = { isChatProvider: true, instanceId: 'box-1', setupStatus: 'ready', connected: true, capabilities: ['chat-runner-v1'] };

  it('serves a ready chat on a connected box with the runner', () => {
    expect(chatTargetError(ok)).toBeNull();
    expect(chatTargetError({ ...ok, setupStatus: 'none' })).toBeNull();
  });

  it('refuses a terminal project', () => {
    expect(chatTargetError({ ...ok, isChatProvider: false })?.body).toMatchObject({ code: 'not-a-chat' });
  });

  it('refuses a project with no box: it would accept a send and drop every frame', () => {
    expect(chatTargetError({ ...ok, instanceId: null })?.status).toBe(409);
    expect(chatTargetError({ ...ok, instanceId: null })?.body).toMatchObject({ code: 'no-box' });
  });

  it('holds a chat while the project is still setting up', () => {
    expect(chatTargetError({ ...ok, setupStatus: 'cloning' })?.body).toMatchObject({ code: 'setup' });
  });

  it('503s an offline box agent, and flags an agent without the runner', () => {
    expect(chatTargetError({ ...ok, connected: false })?.status).toBe(503);
    expect(chatTargetError({ ...ok, capabilities: [] })?.body).toMatchObject({ code: 'runner-missing' });
  });
});

describe('clearChatsOnBox', () => {
  it('clears each workstream\'s chat on the box and reports what it did', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const send = async (type: string, payload: Record<string, unknown>) => {
      calls.push([type, payload]);
      return payload.chatKey === 'p1--main' ? { cleared: 2, stopped: true } : { cleared: 0, stopped: false };
    };
    expect(await clearChatsOnBox(send, 'p1', ['main', 'tui'])).toEqual([
      { workstream: 'main', cleared: 2, stopped: true },
      { workstream: 'tui', cleared: 0, stopped: false },
    ]);
    expect(calls).toEqual([['chat-clear', { chatKey: 'p1--main' }], ['chat-clear', { chatKey: 'p1--tui' }]]);
  });

  it('reports an old agent, an offline box and other failures instead of throwing', async () => {
    const send = async (_t: string, payload: Record<string, unknown>) => {
      if (payload.chatKey === 'p1--a') throw new Error('Unknown command: chat-clear');
      if (payload.chatKey === 'p1--b') throw new Error('Box agent not connected');
      throw new Error('boom');
    };
    expect(await clearChatsOnBox(send, 'p1', ['a', 'b', 'c'])).toEqual([
      { workstream: 'a', skipped: 'runner-missing' },
      { workstream: 'b', skipped: 'offline' },
      { workstream: 'c', error: 'boom' },
    ]);
  });
});

describe('chatRequireCheckout', () => {
  it('waits for a checkout only while the repo is set; start-empty clears it', () => {
    expect(chatRequireCheckout({ repoUrl: 'https://github.com/o/r' })).toBe(true);
    expect(chatRequireCheckout({ repoUrl: null })).toBe(false);
  });
});
