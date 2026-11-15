import { describe, expect, it } from 'vitest';
import { sessionTitleOf } from './sessionTitle';
import { buildChatTurnPayload } from './webPush';

describe('sessionTitleOf: the server\'s copy of the one title (frontend chat/sessionTitle.ts)', () => {
  it('takes a person\'s rename, then the ask\'s title, then Claude\'s, then the names', () => {
    const base = { projectName: 'billing-api', workstream: 'fix-retries' };
    expect(sessionTitleOf({ ...base, sessionTitle: 'Mine', sessionTitleSource: 'person', askTitle: 'Ask' })).toBe('Mine');
    expect(sessionTitleOf({ ...base, sessionTitle: 'Claude', sessionTitleSource: 'claude', askTitle: 'Ask' })).toBe('Ask');
    expect(sessionTitleOf({ ...base, sessionTitle: 'Claude', sessionTitleSource: 'claude' })).toBe('Claude');
    expect(sessionTitleOf({ ...base, sessionTitle: 'Old', sessionTitleSource: null })).toBe('Old');
    expect(sessionTitleOf(base)).toBe('fix-retries');
    expect(sessionTitleOf({ projectName: 'billing-api', workstream: 'main' })).toBe('billing-api');
  });

  it('calls an untitled ask by its thread id, never by Claude\'s title', () => {
    expect(sessionTitleOf({ projectName: 'p', workstream: 'ask-t1', askThreadId: 't1', sessionTitle: 'Claude' })).toBe('ask-t1');
  });

  it('titles the chat-turn push with it', () => {
    const p = buildChatTurnPayload({ baseUrl: 'https://x/termag', projectId: 'p1', projectName: 'orchestrator', workstream: 'feat', session: 's', title: 'Ship the fix' });
    expect(p.notification.title).toBe('Ship the fix');
    expect(buildChatTurnPayload({ baseUrl: 'https://x/termag', projectId: 'p1', projectName: 'orchestrator', workstream: 'feat', session: 's' }).notification.title).toBe('feat');
  });
});
