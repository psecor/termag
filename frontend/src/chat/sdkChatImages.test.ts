import { describe, expect, it } from 'vitest';
import { addPending, applyEvent, emptyChat, fromHistory, mergeHistory, promptImages, retryMessage, type ChatState } from './sdkChat';

const run = (events: unknown[], from: ChatState = emptyChat) => events.reduce<ChatState>(applyEvent, from);
const ref = (id: string) => ({ type: 'image', source: { type: 'termag', media_type: 'image/png', id, path: `~/.termag/chat-images/k/${id}.png` } });

describe('images in user messages', () => {
  it('reads a message\'s own images: the box\'s copies, or inline data', () => {
    expect(promptImages([ref('a'), { type: 'text', text: 'hi' }])).toEqual([{ mediaType: 'image/png', path: '~/.termag/chat-images/k/a.png' }]);
    expect(promptImages([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } }]))
      .toEqual([{ mediaType: 'image/jpeg', src: 'data:image/jpeg;base64,AAA' }]);
    expect(promptImages('hi')).toEqual([]);
    // A tool result's image is the tool's, not the user's.
    expect(promptImages([{ type: 'tool_result', tool_use_id: 't', content: [ref('b')] }])).toEqual([]);
  });

  it('shows a transcript message with images above its text, and one with only images', () => {
    const state = fromHistory([
      { type: 'user', uuid: 'u1', message: { role: 'user', content: [ref('a'), { type: 'text', text: 'what is this?' }] } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'A cat.' }] } },
      { type: 'user', uuid: 'u2', message: { role: 'user', content: [ref('b')] } },
    ]);
    expect(state.items.filter(it => it.kind === 'user')).toEqual([
      { kind: 'user', key: 'user:u1', text: 'what is this?', uuid: 'u1', images: [{ mediaType: 'image/png', path: '~/.termag/chat-images/k/a.png' }] },
      { kind: 'user', key: 'user:u2', text: '', uuid: 'u2', images: [{ mediaType: 'image/png', path: '~/.termag/chat-images/k/b.png' }] },
    ]);
  });

  it('keeps tool results apart from image messages', () => {
    const state = fromHistory([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: [ref('b')] }] } }]);
    expect(state.items).toEqual([]);
  });

  it('settles the pending bubble on its turn-start, keeping the local copies', () => {
    const pending = addPending(emptyChat, 'look', [{ mediaType: 'image/png', src: 'data:image/png;base64,AAA' }], 'pending:x');
    const state = applyEvent(pending, { type: 'turn-start', text: 'look', images: [{ id: 'a', mediaType: 'image/png', path: '~/p/a.png' }] });
    expect(state.items).toEqual([{ kind: 'user', key: 'pending:x', text: 'look', pending: false, images: [{ mediaType: 'image/png', src: 'data:image/png;base64,AAA' }] }]);
  });

  it('does not settle a pending text message on a turn of the same text with images', () => {
    const pending = addPending(emptyChat, 'look');
    const state = applyEvent(pending, { type: 'turn-start', text: 'look', images: [{ id: 'a', mediaType: 'image/png', path: '~/p/a.png' }] });
    expect(state.items).toHaveLength(2);
    expect(state.items[1]).toMatchObject({ kind: 'user', text: 'look', images: [{ path: '~/p/a.png' }] });
  });

  it('shows another view\'s image turn from its turn-start, and does not repeat it from the transcript', () => {
    const state = run([
      { type: 'turn-start', text: '', images: [{ id: 'a', mediaType: 'image/png', path: '~/p/a.png' }] },
      { type: 'user', message: { content: [ref('a')] } },
    ]);
    expect(state.items.filter(it => it.kind === 'user')).toHaveLength(1);
  });

  it('moves a queued image message where a live turn read it', () => {
    let state = addPending(emptyChat, 'first');
    state = applyEvent(state, { type: 'turn-start', text: 'first', live: true });
    state = addPending(state, 'and this', [{ mediaType: 'image/png', src: 'data:image/png;base64,AAA' }]);
    state = applyEvent(state, { type: 'user', isReplay: true, uuid: 'r2', message: { content: [ref('a'), { type: 'text', text: 'and this' }] } });
    const users = state.items.filter(it => it.kind === 'user');
    expect(users.map(u => u.key)).toEqual([expect.stringMatching(/^pending:/), 'user:r2']);
    expect(users[1]).toMatchObject({ text: 'and this', images: [{ path: '~/.termag/chat-images/k/a.png' }] });
  });
});

describe('retryMessage', () => {
  const failed = (images: Array<{ mediaType: string; src?: string; path?: string }>, text = 'look') => run([
    { type: 'turn-start', text, images: images.map((_, k) => ({ id: `i${k}`, mediaType: 'image/png', path: `~/p/i${k}.png` })) },
    { type: 'result', is_error: true, subtype: 'error_during_execution', result: 'API Error: 529 overloaded' },
    { type: 'turn-end', exitCode: 1 },
  ], addPending(emptyChat, text, images, 'p'));

  it('sends the images this browser still holds again', () => {
    expect(retryMessage(failed([{ mediaType: 'image/png', src: 'data:image/png;base64,AAA' }])))
      .toEqual({ text: 'look', images: [{ mediaType: 'image/png', data: 'AAA', src: 'data:image/png;base64,AAA' }] });
  });

  it('sends the text alone when only the box has the images, and nothing when there is no text', () => {
    expect(retryMessage(failed([{ mediaType: 'image/png', path: '~/p/a.png' }]))).toEqual({ text: 'look', images: [] });
    expect(retryMessage(failed([{ mediaType: 'image/png', path: '~/p/a.png' }], ''))).toBeNull();
  });
});

describe('image-only turns keep their own identity', () => {
  const start = (id: string) => ({ type: 'turn-start', text: '', images: [{ id, mediaType: 'image/png', path: `~/.termag/chat-images/k/${id}.png` }] });
  const answered = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: [ref('a')] } },
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'A cat.' }] } },
  ];
  const users = (state: ChatState) => state.items.filter(it => it.kind === 'user');

  it('a new image-only turn after an answered one is its own bubble, not a repeat of it', () => {
    const state = mergeHistory({ entries: answered, sessionId: 's', running: true }, [start('b')]);
    expect(users(state)).toHaveLength(2);
    expect(users(state)[1]).toMatchObject({ text: '', images: [{ path: '~/.termag/chat-images/k/b.png' }] });
    expect(state.turnUserKey).toBe(users(state)[1].key);
  });

  it('the running turn\'s own unanswered image-only prompt in the snapshot is not shown twice', () => {
    const state = mergeHistory({ entries: answered.slice(0, 1), sessionId: 's', running: true }, [start('a')]);
    expect(users(state)).toHaveLength(1);
    expect(state.turnUserKey).toBe('user:u1');
  });

  it('a live turn skips the replay of its own images, and shows another image-only message it reads', () => {
    let state = applyEvent(emptyChat, { ...start('a'), live: true });
    state = applyEvent(state, { type: 'user', isReplay: true, uuid: 'r1', message: { content: [ref('b')] } });
    expect(users(state)).toHaveLength(2);
    state = applyEvent(state, { type: 'user', isReplay: true, uuid: 'r2', message: { content: [ref('a')] } });
    expect(users(state)).toHaveLength(2);
  });
});
