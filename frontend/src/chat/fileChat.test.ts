import { describe, expect, it } from 'vitest';
import { countSent, defaultFileChatTarget, fileChatMessage, fileChatPhaseText, fileChatReply, noteLastChat, readLastChat, type FileChatTarget } from './fileChat';
import { addPending, applyEvent, emptyChat, type ChatState } from './sdkChat';

const t = (projectId: string, activeAt: number | null, order: number, workstream = 'main'): FileChatTarget => ({ projectId, workstream, name: projectId, order, activeAt });

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: k => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: k => { m.delete(k); }, clear: () => m.clear(), key: () => null, get length() { return m.size; },
  };
}

describe('defaultFileChatTarget', () => {
  const targets = [t('docs', 300, 0), t('termag-5', 100, 1), t('nospace', 200, 2)];

  it('is the conversation the tab came from when it is in the space', () => {
    expect(defaultFileChatTarget(targets, { projectId: 'termag-5', workstream: 'main' })?.projectId).toBe('termag-5');
  });

  it('is the most recently active session when the last conversation is elsewhere, or unknown', () => {
    expect(defaultFileChatTarget(targets, { projectId: 'other-space', workstream: 'main' })?.projectId).toBe('docs');
    expect(defaultFileChatTarget(targets, null)?.projectId).toBe('docs');
    // Another workstream of the same project is another session.
    expect(defaultFileChatTarget(targets, { projectId: 'termag-5', workstream: 'review' })?.projectId).toBe('docs');
  });

  it('falls back to tab order without activity, and is null with no sessions', () => {
    expect(defaultFileChatTarget([t('a', null, 0), t('b', null, 1)], null)?.projectId).toBe('a');
    expect(defaultFileChatTarget([t('a', 5, 0), t('b', 5, 1)], null)?.projectId).toBe('a');
    expect(defaultFileChatTarget([], { projectId: 'a', workstream: 'main' })).toBeNull();
  });

  it('remembers the last conversation per storage, ignoring junk', () => {
    const s = memory();
    expect(readLastChat(s)).toBeNull();
    noteLastChat({ projectId: 'p1', workstream: 'ws' }, s);
    expect(readLastChat(s)).toEqual({ projectId: 'p1', workstream: 'ws' });
    s.setItem('termag.chat.fileChatTarget.v1', '{"projectId":""}');
    expect(readLastChat(s)).toBeNull();
    s.setItem('termag.chat.fileChatTarget.v1', 'nope');
    expect(readLastChat(s)).toBeNull();
  });
});

describe('fileChatMessage', () => {
  it('sends what was typed, then the file being viewed', () => {
    expect(fileChatMessage('  mark 755 ready \n', 'improve-termag', 'pr-outbox.md')).toBe('mark 755 ready\n\n(viewing improve-termag:pr-outbox.md)');
  });
});

describe('fileChatReply', () => {
  const sent = fileChatMessage('mark 755 ready', 'improve-termag', 'pr-outbox.md');
  const one = { message: sent, occurrence: 1 };
  const text = (s: ChatState, value: string): ChatState => applyEvent(s, { type: 'assistant', message: { id: `m${s.seq}`, content: [{ type: 'text', text: value }] } });

  it('is queued while the message waits behind a turn', () => {
    let s = applyEvent(emptyChat, { type: 'turn-start', text: 'an earlier ask' });
    s = addPending(s, sent);
    expect(fileChatReply(s, one)).toEqual({ phase: 'queued', text: null });
    expect(fileChatReply(emptyChat, one).phase).toBe('queued');
  });

  it('is working with the latest text, then done', () => {
    let s = addPending(emptyChat, sent);
    s = applyEvent(s, { type: 'turn-start', text: sent });
    expect(fileChatReply(s, one)).toEqual({ phase: 'working', text: null });
    s = text(s, 'Marking #755 ready…');
    s = text(s, 'Done: #755 is ready for review.');
    expect(fileChatReply(s, one)).toEqual({ phase: 'working', text: 'Done: #755 is ready for review.' });
    s = applyEvent(s, { type: 'turn-end' });
    expect(fileChatReply(s, one)).toEqual({ phase: 'done', text: 'Done: #755 is ready for review.' });
  });

  it('is the answer to this message, not to one sent after it', () => {
    let s = applyEvent(emptyChat, { type: 'turn-start', text: sent });
    s = text(s, 'Marked.');
    s = applyEvent(s, { type: 'turn-end' });
    s = applyEvent(s, { type: 'turn-start', text: 'something else' });
    s = text(s, 'Other answer');
    expect(fileChatReply(s, one)).toEqual({ phase: 'done', text: 'Marked.' });
  });

  it('follows the same words sent again, not the earlier answer', () => {
    let s = applyEvent(emptyChat, { type: 'turn-start', text: sent });
    s = text(s, 'Marked.');
    s = applyEvent(s, { type: 'turn-end' });
    const again = { message: sent, occurrence: countSent(s, sent) + 1 };
    expect(again.occurrence).toBe(2);
    expect(fileChatReply(s, again)).toEqual({ phase: 'queued', text: null });
    s = applyEvent(s, { type: 'turn-start', text: sent });
    expect(fileChatReply(s, again)).toEqual({ phase: 'working', text: null });
    s = text(s, 'Already ready.');
    s = applyEvent(s, { type: 'turn-end' });
    expect(fileChatReply(s, again)).toEqual({ phase: 'done', text: 'Already ready.' });
  });

  it('says a failed or stopped turn', () => {
    let s = applyEvent(emptyChat, { type: 'turn-start', text: sent });
    s = applyEvent(s, { type: 'runner-error', message: 'The chat runner failed' });
    expect(fileChatReply(s, one)).toEqual({ phase: 'failed', text: 'The chat runner failed' });
    let x = applyEvent(emptyChat, { type: 'turn-start', text: sent });
    x = applyEvent(x, { type: 'user-stop' });
    x = applyEvent(x, { type: 'turn-end' });
    expect(fileChatReply(x, one).phase).toBe('stopped');
  });

  it('words each phase', () => {
    expect(fileChatPhaseText('queued', false)).toBe('Queued · sent after the current turn');
    expect(fileChatPhaseText('queued', true)).toBe('Sent · it reads this at its next step');
    expect(fileChatPhaseText('working', false)).toBe('Working…');
    expect(fileChatPhaseText('done', false)).toBe('Done');
  });
});
