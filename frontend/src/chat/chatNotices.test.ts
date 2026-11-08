import { describe, expect, it } from 'vitest';
import { NOTICE_SHOWN_MS, chatNoticePlacement, noticePaneLabel, parseChatNotice, type ChatNotice } from './chatNotices';

const line = '[termag] Claude Code was updated to 2.1.320 (automatic nightly run); resuming your session.';
const n = (id: string, at: string, over: Partial<ChatNotice> = {}): ChatNotice => ({ id, kind: 'tool-update', pane: 'agent', text: line, at, ...over });

describe('parseChatNotice', () => {
  it('takes a notice as the server sends it', () => {
    expect(parseChatNotice(n('a', '2026-11-04T03:12:00.000Z'))).toEqual(n('a', '2026-11-04T03:12:00.000Z'));
  });

  it('drops anything that is not a restart notice NOTICE_SAFE passes', () => {
    for (const text of ["[termag] it's", '[termag] <b>x</b>', 'resuming your session.', '[termag] a\nb', 42]) {
      expect(parseChatNotice({ ...n('a', '2026-11-04T03:12:00.000Z'), text })).toBeNull();
    }
    expect(parseChatNotice({ ...n('a', 'yesterday') })).toBeNull();
    expect(parseChatNotice(null)).toBeNull();
  });
});

describe('chatNoticePlacement', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  const ids = (p: ReturnType<typeof chatNoticePlacement>) => [p.session?.id ?? null, p.side?.id ?? null];

  it('puts the agent pane\'s newest notice above the session', () => {
    expect(ids(chatNoticePlacement([n('a', '2026-11-03T03:00:00Z'), n('b', '2026-11-04T03:00:00Z'), n('c', '2026-11-02T03:00:00Z')], now))).toEqual(['b', null]);
  });

  it('never puts a side pane\'s restart above an agent session that went on: it is a note after it', () => {
    // A Codex update restarted only the side terminal; Claude in the agent pane never restarted.
    expect(ids(chatNoticePlacement([n('s', '2026-11-04T03:00:00Z', { pane: 'ctrl' })], now))).toEqual([null, 's']);
    expect(ids(chatNoticePlacement([n('a', '2026-11-03T03:00:00Z'), n('s', '2026-11-04T03:00:00Z', { pane: 'ctrl' })], now))).toEqual(['a', 's']);
  });

  it('drops a side pane\'s notice older than the agent session it would sit in', () => {
    expect(ids(chatNoticePlacement([n('s', '2026-11-03T03:00:00Z', { pane: 'review' }), n('a', '2026-11-04T03:00:00Z')], now))).toEqual(['a', null]);
  });

  it('shows none older than a week, and none without any', () => {
    expect(ids(chatNoticePlacement([n('a', new Date(now - NOTICE_SHOWN_MS - 1).toISOString()), n('s', new Date(now - NOTICE_SHOWN_MS - 1).toISOString(), { pane: 'ctrl' })], now))).toEqual([null, null]);
    expect(ids(chatNoticePlacement([], now))).toEqual([null, null]);
  });
});

describe('noticePaneLabel', () => {
  it('says where the line was printed when it was not the chat\'s own pane', () => {
    expect(noticePaneLabel('agent')).toBeNull();
    expect(noticePaneLabel('ctrl')).toBe('in the side terminal');
    expect(noticePaneLabel('review')).toBe('in the Review pane');
  });
});
