import { describe, it, expect } from 'vitest';
import type { InboxRow } from '../mobile/inbox';
import type { Block } from './paneChat';
import { chatHref, chatRows, conversationBlocks, fullUiHref, isSdkChat, repoSlug, showAnswerKeys, statusLine } from './simpleChat';

function row(over: Partial<InboxRow>): InboxRow {
  return {
    key: 'p|main', projectId: 'p', projectName: 'p', workstream: 'main', owner: 'u', shared: false,
    provider: 'claude', instanceId: 'box', kind: 'normal', pinned: false, status: 'idle',
    waitingReason: null, updatedAt: '2026-10-15T10:00:00Z', message: null, contextTokens: null,
    rateLimited: null, review: null, ring: null, band: 'other',
    ...over,
  };
}

describe('chatRows', () => {
  it('drops MetaTerm and cloud sessions', () => {
    const rows = chatRows([
      row({ key: 'a', projectId: 'a' }),
      row({ key: 'm', projectId: 'm', kind: 'metaterm' }),
      row({ key: 'c', projectId: 'c', kind: 'cloud' }),
    ]);
    expect(rows.map(r => r.key)).toEqual(['a']);
  });

  it('puts chats that need you first, then running ones', () => {
    const rows = chatRows([
      row({ key: 'idle', band: 'other', updatedAt: '2026-10-15T12:00:00Z' }),
      row({ key: 'run', band: 'running', status: 'working' }),
      row({ key: 'ask', band: 'attention', status: 'waiting', waitingReason: 'user_input' }),
    ]);
    expect(rows.map(r => r.key)).toEqual(['ask', 'run', 'idle']);
  });
});

describe('statusLine', () => {
  it('shows setup before anything the agent says', () => {
    expect(statusLine({ status: 'working', setupLabel: 'cloning' })).toEqual({ tone: 'setup', text: 'Setting up · cloning' });
  });

  it('says when the box agent is offline', () => {
    expect(statusLine({ status: 'working', offline: true }).tone).toBe('offline');
  });

  it('names the running tool, else the spinner, else just working', () => {
    expect(statusLine({ status: 'working', message: 'Bash(npm test)' }).text).toBe('Working · Bash(npm test)');
    expect(statusLine({ status: 'working', spinner: '✻ Channeling… (12s)' }).text).toBe('Channeling… (12s)');
    expect(statusLine({ status: 'working' }).text).toBe('Working');
  });

  it('says what a waiting agent wants', () => {
    expect(statusLine({ status: 'waiting', waitingReason: 'user_input' }).text).toBe('Asked you a question');
    expect(statusLine({ status: 'waiting', waitingReason: 'approval', message: 'Claude needs your permission to use Bash' }).text)
      .toBe('Needs approval · Claude needs your permission to use Bash');
  });

  it('reads idle as the user’s turn and anything else as not running', () => {
    expect(statusLine({ status: 'idle' })).toEqual({ tone: 'idle', text: 'Done · your turn' });
    expect(statusLine({ status: 'not_running' }).tone).toBe('off');
    expect(statusLine({ status: undefined }).tone).toBe('off');
  });
});

describe('showAnswerKeys', () => {
  it('shows while waiting or while a question is on screen, never otherwise', () => {
    expect(showAnswerKeys('waiting', 0)).toBe(true);
    expect(showAnswerKeys('working', 3)).toBe(true);
    expect(showAnswerKeys('working', 0)).toBe(false);
    expect(showAnswerKeys('idle', 0)).toBe(false);
  });
});

describe('links', () => {
  it('builds the chat URL, with the workstream only when it is not main', () => {
    expect(chatHref('p1', 'main')).toBe('/chat/p/p1');
    expect(chatHref('p1', 'feature x')).toBe('/chat/p/p1?ws=feature%20x');
  });

  it('builds the full-UI deep link', () => {
    expect(fullUiHref('p1')).toBe('/?project=p1');
    expect(fullUiHref('p1', 'tui')).toBe('/?project=p1&ws=tui');
    expect(fullUiHref(null)).toBe('/');
  });
});

describe('repoSlug', () => {
  it('reads https and ssh GitHub URLs', () => {
    expect(repoSlug('https://github.com/acme/web')).toBe('acme/web');
    expect(repoSlug('https://github.com/acme/web.git')).toBe('acme/web');
    expect(repoSlug('git@github.com:acme/web.git')).toBe('acme/web');
  });

  it('is null for nothing or a non-GitHub URL', () => {
    expect(repoSlug(null)).toBeNull();
    expect(repoSlug('https://gitlab.com/acme/web')).toBeNull();
  });
});

describe('conversationBlocks', () => {
  const sys = (text: string): Block => ({ kind: 'system', text });

  it('drops what the pane printed before the first turn', () => {
    const blocks: Block[] = [
      sys('To run a command as administrator (user "root"), use "sudo <command>".\n[box-1] ~/p $ claude'),
      { kind: 'you', text: 'hello' },
      { kind: 'agent', text: 'Hi.' },
    ];
    expect(conversationBlocks(blocks).map(b => b.kind)).toEqual(['you', 'agent']);
  });

  it('keeps unrecognised text after the first turn, which may be the agent talking', () => {
    const blocks: Block[] = [sys('banner'), { kind: 'you', text: 'hello' }, sys('noted: hello')];
    expect(conversationBlocks(blocks)).toEqual([{ kind: 'you', text: 'hello' }, sys('noted: hello')]);
  });

  it('shows nothing before the agent has had a turn', () => {
    expect(conversationBlocks([sys('$ claude'), sys('Welcome to Claude Code')])).toEqual([]);
    expect(conversationBlocks([])).toEqual([]);
  });

  it('starts at a capture that opens mid-turn', () => {
    const blocks: Block[] = [{ kind: 'agent', text: 'the tail of an answer', partial: true }];
    expect(conversationBlocks(blocks)).toEqual(blocks);
  });
});

describe('isSdkChat', () => {
  const ws = [{ id: 'w-main', name: 'main' }, { id: 'w-tui', name: 'tui' }] as never;
  const wf = (workstreamId: string, provider: string) => ({ id: workstreamId, type: 'agent', provider, server: '', projectId: 'p', workstreamId });

  it('is the chat provider on the workstream, else on main', () => {
    expect(isSdkChat({ workstreams: ws, workflows: [wf('w-main', 'claude-chat')] as never }, 'main')).toBe(true);
    expect(isSdkChat({ workstreams: ws, workflows: [wf('w-main', 'claude-chat')] as never }, 'tui')).toBe(true);
    expect(isSdkChat({ workstreams: ws, workflows: [wf('w-main', 'claude-chat'), wf('w-tui', 'claude')] as never }, 'tui')).toBe(false);
  });

  it('is false for a pane agent or no agent', () => {
    expect(isSdkChat({ workstreams: ws, workflows: [wf('w-main', 'claude')] as never }, 'main')).toBe(false);
    expect(isSdkChat({ workstreams: ws, workflows: [] }, 'main')).toBe(false);
  });
});
