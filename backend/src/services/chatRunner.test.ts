import { describe, expect, it, vi } from 'vitest';

// setStatus writes through to session_statuses; without a database that write
// fails and logs after the file's last test, which vitest reports as a teardown error.
const db = vi.hoisted(() => ({ workstreamUpdateMany: vi.fn(async (_args: unknown) => ({ count: 1 })) }));
vi.mock('../db', () => ({
  prisma: {
    sessionStatus: { upsert: vi.fn(async () => ({})), deleteMany: vi.fn(async () => ({ count: 0 })) },
    workstream: { updateMany: db.workstreamUpdateMany },
  },
}));
import { renameSessionFor, saveSessionTitle, sessionTitleOf, SESSION_TITLE_MAX, chatContextAction, chatContextActions, chatContextRefusals, chatInterruptRpcPayload, chatKeyFor, chatRequireCheckout, chatResumeClaimPayload, chatRpcFailure, chatSendRpcPayload, chatSendsLive, chatStopScope, chatStopsTurn, chatTargetError, chatTextError, clearChatsOnBox, historyTerminalHolds, isIdleShell, mayReceiveChat, paneProbeKind, paneStillHolds, permissionModeForAgent, probeFromForeground, reconcileChatStatus, resumeCommandFor, resumeDecision, statusForChatEvent, sweepStaleChatStatus, terminalHoldsChat, toolCallLabel, CHAT_INTERRUPT_CAPABILITY, CHAT_LIVE_CAPABILITY, CHAT_ORCHESTRATOR_CAPABILITY, CHAT_CONTEXT_CAPABILITY, CHAT_RUNNER_CAPABILITY, CHAT_STATUS_SOURCE, CHAT_TRUST_CAPABILITY, SPACE_MEMORY_CAPABILITY, chatHistoryFromStore, CHAT_BOX_NOTICE_CAPABILITY, ownerOnlyChatEvent, chatPushRoute } from './chatRunner';
import { sessionBelongsToUser, sessionName } from './tmux';
import { getStatus, setStatus } from './status';
import { settleTurnPost } from './sessionTurns';
import { statusKey } from './statusKey';

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

  it('lets a message with images have no text', () => {
    expect(chatTextError('', true)).toBeNull();
    expect(chatTextError('  ', true)).toBeNull();
    expect(chatTextError(undefined, true)).toBe('text is required');
    expect(chatTextError('', false)).toBe('text is required');
  });
});

describe('statusForChatEvent', () => {
  it('works from the turn start and rests at the turn end', () => {
    expect(statusForChatEvent({ type: 'turn-start', text: 'hi' })).toEqual({ status: 'working', message: 'Thinking' });
    expect(statusForChatEvent({ type: 'turn-end', exitCode: 0 })).toEqual({ status: 'idle' });
  });

  it('previews what Claude last said, never a tool call', () => {
    const said = { type: 'assistant', message: { content: [{ type: 'text', text: '\nLooking at the  tests now.\nMore.' }] } };
    expect(statusForChatEvent(said, 'Thinking')).toEqual({ status: 'working', message: 'Looking at the tests now.' });
    const tool = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } };
    expect(statusForChatEvent(tool, 'Looking at the tests now.')).toEqual({ status: 'working', message: 'Looking at the tests now.' });
    expect(statusForChatEvent(tool)).toEqual({ status: 'working', message: 'Thinking' });
    expect(statusForChatEvent({ type: 'turn-end', exitCode: 0 }, 'All green.')).toEqual({ status: 'idle', message: 'All green.' });
    expect(statusForChatEvent({ type: 'turn-end', exitCode: 130 }, 'Thinking')).toEqual({ status: 'idle' });
    const long = { type: 'assistant', message: { content: [{ type: 'text', text: 'a'.repeat(300) }] } };
    expect(statusForChatEvent(long)?.message).toHaveLength(120);
  });

  it('rests once Claude answers, and works again when a live turn takes in a message', () => {
    expect(statusForChatEvent({ type: 'result', result: 'Asked; waiting on it.' }, 'Asked; waiting on it.')).toEqual({ status: 'idle', message: 'Asked; waiting on it.' });
    expect(statusForChatEvent({ type: 'result' }, 'Thinking')).toEqual({ status: 'idle' });
    expect(statusForChatEvent({ type: 'user', isReplay: true, message: { role: 'user', content: 'are you there?' } })).toEqual({ status: 'working', message: 'Thinking' });
    // A tool result, and a transcript's own user line, are not a new message.
    expect(statusForChatEvent({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })).toBeNull();
    expect(statusForChatEvent({ type: 'user', message: { content: 'old prompt' } })).toBeNull();
  });

  it('works again when a background task\'s end wakes Claude after its answer, before it says anything', () => {
    const notification = { type: 'system', subtype: 'task_notification', task_id: 'b1', tool_use_id: 'toolu_1', status: 'completed' };
    expect(statusForChatEvent(notification, 'Asked; waiting on it.')).toEqual({ status: 'working', message: 'Asked; waiting on it.' });
    expect(statusForChatEvent({ type: 'system', subtype: 'init', session_id: 's1' })).toEqual({ status: 'working', message: 'Thinking' });
    expect(statusForChatEvent({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })).toBeNull();
    expect(statusForChatEvent({ type: 'system', subtype: 'task_started', task_id: 'b1' })).toBeNull();
  });

  it('leaves the status alone for everything else', () => {
    expect(statusForChatEvent({ type: 'assistant', message: { content: [{ type: 'text', text: '  ' }] } })).toBeNull();
    expect(statusForChatEvent({ type: 'stream_event', event: {} })).toBeNull();
    expect(statusForChatEvent(null)).toBeNull();
  });
});

describe('sessionTitleOf', () => {
  it('takes a turn-end\'s title or a session-title frame\'s, and nothing from any other event', () => {
    expect(sessionTitleOf({ type: 'turn-end', exitCode: 0, title: 'Login rate limiting' })).toBe('Login rate limiting');
    expect(sessionTitleOf({ type: 'turn-end', exitCode: 0 })).toBeNull();
    // The title the box generates where Claude names no session (Bedrock).
    expect(sessionTitleOf({ type: 'session-title', title: 'Fix SSO dashboard redirect loop', source: 'generated' })).toBe('Fix SSO dashboard redirect loop');
    expect(sessionTitleOf({ type: 'session-title', title: '  \n ' })).toBeNull();
    expect(sessionTitleOf({ type: 'session-title' })).toBeNull();
    expect(sessionTitleOf({ type: 'assistant', title: 'Not a title' })).toBeNull();
    expect(sessionTitleOf({ type: 'turn-end', title: 42 })).toBeNull();
    expect(sessionTitleOf(null)).toBeNull();
  });

  it('keeps one plain line: no control or direction characters, no blanks', () => {
    expect(sessionTitleOf({ type: 'turn-end', title: '  Auth\n\tfix\u0007  ' })).toBe('Auth fix');
    expect(sessionTitleOf({ type: 'turn-end', title: 'evil\u202egnp.exe' })).toBe('evilgnp.exe');
    expect(sessionTitleOf({ type: 'turn-end', title: ' \u200b\n ' })).toBeNull();
  });

  it('cuts a long one to the sidebar\'s length without splitting a character', () => {
    const cut = sessionTitleOf({ type: 'turn-end', title: '🦊'.repeat(200) });
    expect(Array.from(cut!)).toHaveLength(SESSION_TITLE_MAX);
    expect(cut!.endsWith('🦊…')).toBe(true);
    expect(sessionTitleOf({ type: 'turn-end', title: 'a'.repeat(SESSION_TITLE_MAX) })).toBe('a'.repeat(SESSION_TITLE_MAX));
  });
});

describe('saveSessionTitle', () => {
  const at = new Date('2026-11-02T20:00:00Z');
  it("writes the project's own workstream, only when the title changed, and never over a person's rename", async () => {
    await saveSessionTitle('p1', 'w1', 'Auth fix', at);
    expect(db.workstreamUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'w1', projectId: 'p1',
        AND: [
          { OR: [{ sessionTitle: null }, { sessionTitle: { not: 'Auth fix' } }] },
          { OR: [{ sessionTitleSource: null }, { sessionTitleSource: { not: 'person' } }] },
        ],
      },
      data: { sessionTitle: 'Auth fix', sessionTitleAt: at, sessionTitleSource: 'claude' },
    });
  });

  it('says whether it wrote, so only a new title becomes the session.titled event', async () => {
    db.workstreamUpdateMany.mockResolvedValueOnce({ count: 1 });
    await expect(saveSessionTitle('p1', 'w1', 'Auth fix', at)).resolves.toBe(true);
    db.workstreamUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(saveSessionTitle('p1', 'w1', 'Auth fix', at)).resolves.toBe(false);
  });

  it("records a person's rename, cleaned and cut as Claude's titles are, and nothing for a blank one", async () => {
    db.workstreamUpdateMany.mockClear();
    expect(await renameSessionFor('p1', 'w1', '  Ship\nthe fix  ', at)).toEqual({ title: 'Ship the fix', titleAt: at.toISOString() });
    expect(db.workstreamUpdateMany).toHaveBeenCalledWith({
      where: { id: 'w1', projectId: 'p1' },
      data: { sessionTitle: 'Ship the fix', sessionTitleAt: at, sessionTitleSource: 'person' },
    });
    expect(await renameSessionFor('p1', 'w1', '   ', at)).toBeNull();
    expect(await renameSessionFor('p1', 'w1', 7, at)).toBeNull();
  });
});

describe('chatContextActions', () => {
  it('offers the context actions, and never in an ask chat', () => {
    expect(chatContextActions([CHAT_RUNNER_CAPABILITY, CHAT_CONTEXT_CAPABILITY], false)).toBe('ready');
    expect(chatContextActions([CHAT_CONTEXT_CAPABILITY], true)).toBeNull();
  });

  it('says an older runner needs an update instead of hiding the actions', () => {
    expect(chatContextActions([CHAT_RUNNER_CAPABILITY], false)).toBe('update');
  });
});

describe('chatContextAction', () => {
  it('takes clear, compact and resume only', () => {
    expect(['clear', 'compact', 'resume', 'reset', '', null].map(chatContextAction)).toEqual(['clear', 'compact', 'resume', null, null, null]);
  });
});

describe('chatContextRefusals', () => {
  it('lets a Claude chat on its own models do everything', () => {
    expect(chatContextRefusals('claude', null)).toEqual({});
  });
  it('does not compact a chat on another backend, but clears and resumes it', () => {
    const r = chatContextRefusals('claude', 'fireworks');
    expect(Object.keys(r)).toEqual(['compact']);
  });
  it('refuses all three for another engine, with why', () => {
    const r = chatContextRefusals('pi', null);
    expect(Object.keys(r).sort()).toEqual(['clear', 'compact', 'resume']);
    expect(r.compact).toMatch(/Claude Code/);
  });
});

describe('chatRpcFailure: the context actions', () => {
  it('answers each refusal as a 409 the browser can show', () => {
    for (const [message, code] of [['chat-busy: a turn is running', 'chat-busy'], ['resume-gone: a message started a new session', 'resume-gone'], ['nothing-to-compact: no context', 'nothing-to-compact']]) {
      const r = chatRpcFailure(message);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe(code);
    }
  });
});

describe('chatRpcFailure', () => {
  it('names an old agent and a checkout still running, and passes anything else on', () => {
    expect(chatRpcFailure('Unknown command: chat-send')).toMatchObject({ status: 409, body: { code: 'runner-missing' } });
    expect(chatRpcFailure('checkout-pending: the repository is still being checked out')).toMatchObject({ status: 409, body: { code: 'checkout-pending' } });
    expect(chatRpcFailure('chat-clearing: this chat is being stopped')).toMatchObject({ status: 409, body: { code: 'chat-clearing' } });
    expect(chatRpcFailure('chat-stopped: the chat was stopped before this message went in')).toMatchObject({ status: 409, body: { code: 'chat-stopped' } });
    expect(chatRpcFailure('mode-refused: the chat runner only runs dontAsk')).toMatchObject({ status: 409, body: { code: 'mode-refused' } });
    expect(chatRpcFailure('mode-refused: the chat runner only runs dontAsk').status).not.toBe(502);
    expect(chatRpcFailure('image-refused: image 1 is not a PNG, JPEG, GIF or WebP')).toEqual({ status: 400, body: { error: 'image 1 is not a PNG, JPEG, GIF or WebP', code: 'bad-image' } });
    expect(chatRpcFailure('cwd must be absolute')).toEqual({ status: 502, body: { error: 'cwd must be absolute' } });
  });
});

describe('chatPushRoute: the fan-out of a chat push, per status socket', () => {
  it("sends the owner everything, and a collaborator everything but the owner's seat spend", () => {
    const spend = { type: 'plan-usage', spend: { usedMinor: 1, limitMinor: 2 } };
    expect(chatPushRoute(spend, 'alice', 'alice')).toBe('owner');
    expect(chatPushRoute(spend, 'alice', 'bob')).toBe('none');
    expect(chatPushRoute({ type: 'assistant' }, 'alice', 'bob')).toBe('share');
    expect(chatPushRoute({ type: 'assistant' }, 'alice', 'alice')).toBe('owner');
  });
});

describe('ownerOnlyChatEvent', () => {
  it("keeps the box owner's seat spend from collaborators, and nothing else", () => {
    expect(ownerOnlyChatEvent({ type: 'plan-usage', spend: { usedMinor: 1, limitMinor: 2 } })).toBe(true);
    expect(ownerOnlyChatEvent({ type: 'rate_limit_event', rate_limit_info: {} })).toBe(false);
    expect(ownerOnlyChatEvent({ type: 'assistant' })).toBe(false);
    expect(ownerOnlyChatEvent(null)).toBe(false);
    expect(ownerOnlyChatEvent('plan-usage')).toBe(false);
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

  it("settling the chat leaves the session working while a desktop thread in its checkout works (services/sessionTurns.ts)", () => {
    settleTurnPost(statusKey(null, 'recon-desk-agent'), { status: 'working', source: 't3:claude', threadId: 'T1' });
    setStatus('recon-desk-agent', 'working', { source: CHAT_STATUS_SOURCE }, undefined, null);
    reconcileChatStatus('recon-desk-agent', null);
    expect(getStatus('recon-desk-agent')).toMatchObject({ status: 'working', source: 't3:claude' });
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

describe('chatHistoryFromStore', () => {
  const ok = { isChatProvider: true, instanceId: 'box-1', setupStatus: 'ready', connected: true, capabilities: ['chat-runner-v1'] };

  it('reads the store for an offline box and for a project whose box is gone', () => {
    expect(chatHistoryFromStore(chatTargetError({ ...ok, connected: false })!)).toBe(true);
    expect(chatHistoryFromStore(chatTargetError({ ...ok, instanceId: null })!)).toBe(true);
  });

  it('keeps every other refusal', () => {
    expect(chatHistoryFromStore(chatTargetError({ ...ok, isChatProvider: false })!)).toBe(false);
    expect(chatHistoryFromStore(chatTargetError({ ...ok, setupStatus: 'cloning' })!)).toBe(false);
    expect(chatHistoryFromStore(chatTargetError({ ...ok, capabilities: [] })!)).toBe(false);
    expect(chatHistoryFromStore({ status: 404, body: { error: 'Project not found' } })).toBe(false);
  });
});

describe('clearChatsOnBox', () => {
  it('clears each workstream\'s chat by its id and reports it by its name', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const send = async (type: string, payload: Record<string, unknown>) => {
      calls.push([type, payload]);
      return payload.chatKey === 'p1--w1' ? { cleared: 2, stopped: true } : { cleared: 0, stopped: false };
    };
    expect(await clearChatsOnBox(send, 'p1', [{ id: 'w1', name: 'main' }, { id: 'w2', name: 'tui' }])).toEqual([
      { workstream: 'main', cleared: 2, stopped: true },
      { workstream: 'tui', cleared: 0, stopped: false },
    ]);
    expect(calls).toEqual([['chat-clear', { chatKey: 'p1--w1' }], ['chat-clear', { chatKey: 'p1--w2' }]]);
  });

  it('reports an old agent, an offline box and other failures instead of throwing', async () => {
    const send = async (_t: string, payload: Record<string, unknown>) => {
      if (payload.chatKey === 'p1--a') throw new Error('Unknown command: chat-clear');
      if (payload.chatKey === 'p1--b') throw new Error('Box agent not connected');
      throw new Error('boom');
    };
    expect(await clearChatsOnBox(send, 'p1', [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }])).toEqual([
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

describe('resumeCommandFor', () => {
  it('resumes a session id, and nothing that is not one', () => {
    expect(resumeCommandFor('5109190e-c0d2-4f72-9c15-3c4c57fb126c')).toBe('claude --resume 5109190e-c0d2-4f72-9c15-3c4c57fb126c');
    expect(resumeCommandFor('x; rm -rf ~')).toBeNull();
    expect(resumeCommandFor(null)).toBeNull();
    expect(resumeCommandFor('short')).toBeNull();
  });
});

describe('paneProbeKind', () => {
  it('names a miss, a Claude, a shell, and anything else separately', () => {
    expect(paneProbeKind(null)).toBe('unknown');
    expect(paneProbeKind('')).toBe('unknown');
    expect(paneProbeKind('   ')).toBe('unknown');
    expect(paneProbeKind('claude')).toBe('claude');
    expect(paneProbeKind('claude --resume abc')).toBe('claude');
    expect(paneProbeKind('-zsh')).toBe('shell');
    expect(paneProbeKind('/bin/bash')).toBe('shell');
    expect(paneProbeKind('vim')).toBe('other');
    expect(paneProbeKind('node server.js')).toBe('other');
  });
});

describe('paneStillHolds', () => {
  it('a live Claude holds the pane, and a dead pane whose name is still claude does not', () => {
    expect(paneStillHolds('claude')).toBe(true);
    expect(paneStillHolds({ cmd: 'claude', dead: false })).toBe(true);
    expect(paneStillHolds({ cmd: 'claude', dead: true })).toBe(false);
    expect(probeFromForeground({ cmd: 'claude', dead: true })).toBe('shell');
    expect(probeFromForeground({ cmd: 'claude', dead: false })).toBe('claude');
    expect(probeFromForeground({ cmd: 'zsh', dead: false })).toBe('shell');
    expect(probeFromForeground(null)).toBe('unknown');
  });
});

describe('historyTerminalHolds', () => {
  it('reports a live Claude, clears only on a shell or a dead pane, and omits a miss', () => {
    expect(historyTerminalHolds({ cmd: 'claude', dead: false })).toBe(true);
    expect(historyTerminalHolds('claude')).toBe(true);
    expect(historyTerminalHolds('zsh')).toBe(false);
    expect(historyTerminalHolds({ cmd: 'claude', dead: true })).toBe(false);
    // A failed or empty probe is not Claude having left.
    expect(historyTerminalHolds(null)).toBeUndefined();
    expect(historyTerminalHolds({ cmd: null, dead: false })).toBeUndefined();
    expect(historyTerminalHolds({ cmd: '', dead: false })).toBeUndefined();
    expect(historyTerminalHolds('vim')).toBeUndefined();
  });
});

describe('terminalHoldsChat', () => {
  it('is a Claude in the foreground, by path or with arguments', () => {
    expect(terminalHoldsChat('claude')).toBe(true);
    expect(terminalHoldsChat('/home/u/.local/bin/claude --resume abc')).toBe(true);
    expect(terminalHoldsChat('claude --resume 5109190e')).toBe(true);
  });
  it('is not a shell, a dev server or an empty pane', () => {
    expect(terminalHoldsChat('zsh')).toBe(false);
    expect(terminalHoldsChat('node server.js')).toBe(false);
    expect(terminalHoldsChat('claude-runner-helper')).toBe(false);
    expect(terminalHoldsChat('')).toBe(false);
    expect(terminalHoldsChat(null)).toBe(false);
  });
});

describe('resumeDecision', () => {
  it('types the resume command only into an idle shell prompt', () => {
    expect(resumeDecision('zsh')).toBe('type');
    expect(resumeDecision('-bash')).toBe('type');
    expect(resumeDecision('-zsh')).toBe('type');
    expect(resumeDecision('/bin/bash')).toBe('type');
    expect(resumeDecision('fish')).toBe('type');
    expect(isIdleShell('zsh')).toBe(true);
  });

  it('does not type into a program that merely is not an agent', () => {
    for (const fg of ['vim', 'htop', 'ssh', 'less', 'npm', '/usr/bin/vim', 'sudo']) {
      expect(resumeDecision(fg)).toBe('pane-busy');
      expect(isIdleShell(fg)).toBe(false);
    }
  });

  it('never types into a failed or empty probe: unknown is not idle', () => {
    expect(resumeDecision(null)).toBe('pane-unknown');
    expect(resumeDecision('')).toBe('pane-unknown');
    expect(resumeDecision('   ')).toBe('pane-unknown');
  });

  it('leaves a running agent, a Claude, or a busy pane alone', () => {
    expect(resumeDecision('node server.js')).toBe('pane-busy');
    expect(resumeDecision('python app.py')).toBe('pane-busy');
    expect(resumeDecision('git')).toBe('pane-busy');
    expect(resumeDecision('claude --resume abc')).toBe('claude-open');
    expect(resumeDecision('/home/u/.local/bin/claude')).toBe('claude-open');
  });
});

describe('chatSendRpcPayload', () => {
  it('carries box notices only when asked, and only to an agent with chat-box-notice-v1', () => {
    const t = { chatKey: 'p--w', cwd: '/w', projectId: 'p', workstream: 'main', workstreamId: 'w', requireCheckout: false, permissionMode: 'dontAsk' };
    const plain = chatSendRpcPayload(t, 'hi', [CHAT_BOX_NOTICE_CAPABILITY]);
    expect(plain).not.toHaveProperty('boxNotices');
    expect(plain).not.toHaveProperty('notice');
    expect(chatSendRpcPayload(t, 'hi', [CHAT_BOX_NOTICE_CAPABILITY], { boxNotices: true, notice: 'new box' })).toMatchObject({ boxNotices: true, notice: 'new box', text: 'hi' });
    const older = chatSendRpcPayload(t, 'hi', [], { boxNotices: true, notice: 'new box' });
    expect(older).not.toHaveProperty('boxNotices');
    expect(older).not.toHaveProperty('notice');
  });
  const target = { chatKey: 'p--w1', cwd: '/w/p', projectId: 'p', workstream: 'main', workstreamId: 'w1', requireCheckout: true, permissionMode: 'dontAsk' };

  it('carries the mode the backend decided', () => {
    expect(chatSendRpcPayload(target, 'hi')).toEqual({ ...target, text: 'hi' });
  });

  it('names the project for the turn\'s telemetry resource, and leaves it out when the caller has none', () => {
    expect(chatSendRpcPayload({ ...target, project: 'webapp' }, 'hi')).toMatchObject({ project: 'webapp', workstream: 'main' });
    expect(chatSendRpcPayload({ ...target, project: null }, 'hi')).not.toHaveProperty('project');
  });

  it('names the chat\'s space whose memory the turn loads, or none, only to an agent with space-memory-v1', () => {
    expect(chatSendRpcPayload(target, 'hi', [SPACE_MEMORY_CAPABILITY], { memorySpace: 'team' }).spaceMemory).toEqual({ space: 'team' });
    expect(chatSendRpcPayload(target, 'hi', [], { memorySpace: 'team' }).spaceMemory).toBeUndefined();
    // A chat with no space (or one its box isn't granted) loads nothing: said, so the box doesn't pick its default.
    expect(chatSendRpcPayload(target, 'hi', [SPACE_MEMORY_CAPABILITY], { memorySpace: null }).spaceMemory).toEqual({ space: null });
    expect(chatSendRpcPayload(target, 'hi', [SPACE_MEMORY_CAPABILITY]).spaceMemory).toBeUndefined();
  });

  it('passes a chosen Claude model and omits a missing one', () => {
    expect(chatSendRpcPayload({ ...target, model: 'sonnet' }, 'hi').model).toBe('sonnet');
    expect(chatSendRpcPayload({ ...target, model: null }, 'hi')).not.toHaveProperty('model');
  });

  it('asks for live input only with the flag on and an agent that takes it', () => {
    expect(chatSendRpcPayload(target, 'hi', [CHAT_LIVE_CAPABILITY], { liveInput: true }).liveInput).toBe(true);
    expect(chatSendRpcPayload(target, 'hi', [CHAT_RUNNER_CAPABILITY], { liveInput: true })).not.toHaveProperty('liveInput');
    expect(chatSendRpcPayload(target, 'hi', [CHAT_LIVE_CAPABILITY], { liveInput: false })).not.toHaveProperty('liveInput');
  });

  it('marks an orchestrator chat only for an agent that takes it', () => {
    expect(chatSendRpcPayload({ ...target, orchestrator: true }, 'hi', [CHAT_ORCHESTRATOR_CAPABILITY]).orchestrator).toBe(true);
    expect(chatSendRpcPayload({ ...target, orchestrator: true }, 'hi', [CHAT_RUNNER_CAPABILITY])).not.toHaveProperty('orchestrator');
    expect(chatSendRpcPayload({ ...target, orchestrator: false }, 'hi', [CHAT_ORCHESTRATOR_CAPABILITY])).not.toHaveProperty('orchestrator');
  });

  it('asks for the session title only with the flag on', () => {
    expect(chatSendRpcPayload(target, 'hi', [CHAT_RUNNER_CAPABILITY], { titles: true }).titles).toBe(true);
    expect(chatSendRpcPayload(target, 'hi', [CHAT_RUNNER_CAPABILITY], { titles: false })).not.toHaveProperty('titles');
    expect(chatSendRpcPayload(target, 'hi')).not.toHaveProperty('titles');
  });

  it('asks for tool-group headings only when the send says so', () => {
    expect(chatSendRpcPayload(target, 'hi', [CHAT_RUNNER_CAPABILITY], { headings: true }).headings).toBe(true);
    expect(chatSendRpcPayload(target, 'hi', [CHAT_RUNNER_CAPABILITY], { headings: false })).not.toHaveProperty('headings');
    expect(chatSendRpcPayload(target, 'hi')).not.toHaveProperty('headings');
  });

  it('carries a checked effort only to an agent with chat-effort-v1', () => {
    expect(chatSendRpcPayload(target, 'hi', ['chat-effort-v1'], { effort: 'xhigh' }).effort).toBe('xhigh');
    expect(chatSendRpcPayload(target, 'hi', [CHAT_RUNNER_CAPABILITY], { effort: 'xhigh' })).not.toHaveProperty('effort');
    expect(chatSendRpcPayload(target, 'hi', ['chat-effort-v1'], { effort: null })).not.toHaveProperty('effort');
  });

  it('asks for the seat\'s monthly spend only when the route says so', () => {
    expect(chatSendRpcPayload(target, 'hi', [CHAT_RUNNER_CAPABILITY], { planSpend: true }).planSpend).toBe(true);
    expect(chatSendRpcPayload(target, 'hi', [CHAT_RUNNER_CAPABILITY], { planSpend: false })).not.toHaveProperty('planSpend');
    expect(chatSendRpcPayload(target, 'hi')).not.toHaveProperty('planSpend');
  });

  it('carries checked images only when there are some', () => {
    const images = [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }];
    expect(chatSendRpcPayload(target, 'look', [], { images }).images).toEqual(images);
    expect(chatSendRpcPayload(target, 'look', [], { images: [] })).not.toHaveProperty('images');
    expect(chatSendRpcPayload(target, 'look')).not.toHaveProperty('images');
  });

  it('sends live only a send that may go live, to an agent that takes it', () => {
    expect(chatSendsLive([CHAT_LIVE_CAPABILITY], true)).toBe(true);
    expect(chatSendsLive([CHAT_LIVE_CAPABILITY], false)).toBe(false);
    expect(chatSendsLive([CHAT_LIVE_CAPABILITY], undefined)).toBe(false);
    expect(chatSendsLive([CHAT_RUNNER_CAPABILITY], true)).toBe(false);
  });

  it('has no way for a request body to choose the mode', () => {
    const body = { text: 'hi', permissionMode: 'bypassPermissions', workstream: 'main' } as const;
    expect(chatSendRpcPayload(target, body.text).permissionMode).toBe('dontAsk');
  });

  it('sends bypassPermissions only to an agent that advertises chat-trust-v1', () => {
    const trusted = { ...target, permissionMode: 'bypassPermissions' };
    expect(permissionModeForAgent('bypassPermissions', [CHAT_RUNNER_CAPABILITY])).toBe('dontAsk');
    expect(permissionModeForAgent('bypassPermissions', [CHAT_RUNNER_CAPABILITY, CHAT_TRUST_CAPABILITY])).toBe('bypassPermissions');
    expect(permissionModeForAgent('dontAsk', [CHAT_TRUST_CAPABILITY])).toBe('dontAsk');
    expect(chatSendRpcPayload(trusted, 'hi', [CHAT_RUNNER_CAPABILITY]).permissionMode).toBe('dontAsk');
    expect(chatSendRpcPayload(trusted, 'hi', [CHAT_RUNNER_CAPABILITY, 'chat-durable-v1']).permissionMode).toBe('dontAsk');
    expect(chatSendRpcPayload(trusted, 'hi', [CHAT_RUNNER_CAPABILITY, CHAT_TRUST_CAPABILITY]).permissionMode).toBe('bypassPermissions');
    expect(chatSendRpcPayload(trusted, 'hi').permissionMode).toBe('dontAsk');
  });
});

describe('chatResumeClaimPayload', () => {
  const target = { chatKey: 'p--w1', cwd: '/w/p', permissionMode: 'bypassPermissions' };

  it('sends the ceiling mode and the checkout, never a session id from the request', () => {
    expect(chatResumeClaimPayload(target, [CHAT_RUNNER_CAPABILITY, CHAT_TRUST_CAPABILITY])).toEqual({
      chatKey: 'p--w1', cwd: '/w/p', permissionMode: 'bypassPermissions',
    });
    expect(chatResumeClaimPayload(target, [CHAT_RUNNER_CAPABILITY]).permissionMode).toBe('dontAsk');
    expect(chatResumeClaimPayload({ ...target, permissionMode: 'dontAsk' }, [CHAT_RUNNER_CAPABILITY, CHAT_TRUST_CAPABILITY]).permissionMode).toBe('dontAsk');
  });

  it('names the project and workstream for the pane\'s telemetry resource, only with a project', () => {
    expect(chatResumeClaimPayload({ ...target, project: 'webapp', workstream: 'feature-x' }, [CHAT_RUNNER_CAPABILITY]))
      .toMatchObject({ project: 'webapp', workstream: 'feature-x' });
    const none = chatResumeClaimPayload({ ...target, workstream: 'feature-x' }, [CHAT_RUNNER_CAPABILITY]);
    expect(none).not.toHaveProperty('project');
    expect(none).not.toHaveProperty('workstream');
  });
});

describe('chat stop scope', () => {
  it('reads only an explicit turn as a turn-only stop', () => {
    expect(chatStopScope('turn')).toBe('turn');
    for (const raw of ['all', undefined, null, 'TURN', 1]) expect(chatStopScope(raw)).toBe('all');
  });

  it('sends a turn-only stop only to an agent with chat-interrupt-v1; an older one gets the whole stop', () => {
    expect(chatStopsTurn([CHAT_RUNNER_CAPABILITY, CHAT_INTERRUPT_CAPABILITY])).toBe(true);
    expect(chatStopsTurn([CHAT_RUNNER_CAPABILITY, CHAT_LIVE_CAPABILITY])).toBe(false);
    expect(chatInterruptRpcPayload('k', [CHAT_INTERRUPT_CAPABILITY], 'turn')).toEqual({ chatKey: 'k', scope: 'turn' });
    expect(chatInterruptRpcPayload('k', [CHAT_INTERRUPT_CAPABILITY], 'all')).toEqual({ chatKey: 'k' });
    expect(chatInterruptRpcPayload('k', [CHAT_LIVE_CAPABILITY], 'turn')).toEqual({ chatKey: 'k' });
  });
});
