import { describe, it, expect } from 'vitest';
import type { InboxRow } from '../mobile/inbox';
import type { Block } from './paneChat';
import { boxLabel, chatHref, chatRowName, chatRows, conversationBlocks, fullUiHref, isSdkChat, repoNeedsTrust, repoSlug, repoStartsTrusted, runConversationHref, showAnswerKeys, sidebarLine, statusLine } from './simpleChat';

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

  it('sends a run\'s conversation to the simple UI only when the user has it', () => {
    expect(runConversationHref('p1', 'run-20261020-0900', true)).toBe('/chat/p/p1?ws=run-20261020-0900');
    expect(runConversationHref('p1', 'run-20261020-0900', false)).toBe('/?project=p1&ws=run-20261020-0900');
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

describe('repoNeedsTrust', () => {
  it('asks for every repository, including the org owners, and for no repository', () => {
    expect(repoNeedsTrust('https://github.com/example-org/webapp.git')).toBe(true);
    expect(repoNeedsTrust('https://github.com/Example-Team/termag')).toBe(true);
    expect(repoNeedsTrust('https://github.com/e2e-org/sample')).toBe(true);
    expect(repoNeedsTrust('git@github.com:someone/fork.git')).toBe(true);
    expect(repoNeedsTrust('https://example.com/x/y.git')).toBe(true);
    expect(repoNeedsTrust(null)).toBe(true);
  });
});

describe('repoStartsTrusted', () => {
  it('starts nothing trusted while no owner is listed', () => {
    expect(repoStartsTrusted('https://github.com/example-org/webapp.git')).toBe(false);
    expect(repoStartsTrusted('git@github.com:example-team/termag.git')).toBe(false);
  });

  it('stays opt-in for every other owner, a lookalike host, and no repository', () => {
    expect(repoStartsTrusted('https://github.com/e2e-org/sample')).toBe(false);
    expect(repoStartsTrusted('https://github.com/example-org-evil/x')).toBe(false);
    expect(repoStartsTrusted('https://github.com/not-example-org/x')).toBe(false);
    expect(repoStartsTrusted('https://github.com/example-team-extra/x')).toBe(false);
    expect(repoStartsTrusted('git@github.com:someone/fork.git')).toBe(false);
    expect(repoStartsTrusted('https://example.com/example-org/x.git')).toBe(false);
    expect(repoStartsTrusted('https://evilgithub.com/example-org/webapp')).toBe(false);
    expect(repoStartsTrusted('https://github.com/example-org/webapp/tree/main')).toBe(false);
    expect(repoStartsTrusted(null)).toBe(false);
    expect(repoStartsTrusted(undefined)).toBe(false);
    expect(repoStartsTrusted('')).toBe(false);
  });
});

describe('chatRowName', () => {
  const row = { projectName: 'termag', workstream: 'fix-auth', sessionTitle: 'Login rate limiting' };

  it('leads with the title when titles are on, the project and workstream secondary', () => {
    expect(chatRowName(row, true)).toEqual({ title: 'Login rate limiting', where: 'termag · fix-auth' });
    expect(chatRowName({ ...row, workstream: 'main' }, true)).toEqual({ title: 'Login rate limiting', where: 'termag' });
  });

  it('names the row after the project with titles off, or before Claude has titled the session', () => {
    expect(chatRowName(row, false)).toEqual({ title: null, where: 'termag · fix-auth' });
    expect(chatRowName({ ...row, sessionTitle: null }, true)).toEqual({ title: null, where: 'termag · fix-auth' });
    expect(chatRowName({ ...row, sessionTitle: '   ' }, true).title).toBeNull();
    expect(chatRowName({ projectName: 'termag', workstream: 'main' }, true).title).toBeNull();
  });
});

describe('sidebarLine', () => {
  it('says what the open chat\'s header says, with Claude\'s last words', () => {
    const r = row({ status: 'working', message: 'Bash(ls -la)' });
    expect(sidebarLine(r, { tone: 'working', text: 'Running Bash · ls -la', preview: 'Let me look.' }, 'done'))
      .toEqual({ state: 'Running Bash · ls -la', message: 'Let me look.', glyph: 'working' });
    expect(sidebarLine(r, { tone: 'setup', text: 'Setting up…', preview: null }, 'done').glyph).toBe('working');
    expect(sidebarLine(r, { tone: 'error', text: 'Stopped · your turn', preview: null }, 'done').glyph).toBe('idle');
  });

  it('says a chat still coming up is setting up, not "Not running"', () => {
    expect(sidebarLine(row({ status: 'not_running' }), undefined, 'cloning')).toEqual({ state: 'Setting up…', message: null, glyph: 'working' });
    expect(sidebarLine(row({ status: 'not_running' }), undefined, 'done').state).not.toBe('Setting up…');
  });

  it('otherwise reads the status pipeline', () => {
    expect(sidebarLine(row({ status: 'idle', message: 'All green.' }), undefined, 'done')).toMatchObject({ message: 'All green.', glyph: 'idle' });
  });
});

describe('boxLabel', () => {
  it('names the box a session runs on, even when it repeats the project', () => {
    expect(boxLabel(row({ projectName: 'sysadmin' }), 'psecor-dev02')).toBe('psecor-dev02');
    expect(boxLabel(row({ projectName: 'sysadmin' }), 'sysadmin')).toBe('sysadmin');
  });

  it("says whose box a shared session is on when the box isn't listed", () => {
    expect(boxLabel(row({ shared: true, owner: 'ada' }), undefined)).toBe("ada's box");
    expect(boxLabel(row({ shared: false }), undefined)).toBeNull();
  });

  it('has nothing for a session with no box', () => {
    expect(boxLabel(row({ instanceId: null }), 'psecor-dev02')).toBeNull();
  });
});
