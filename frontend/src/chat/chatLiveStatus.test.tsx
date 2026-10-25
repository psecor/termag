// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { chatLiveKey, publishChatStatus, useChatLiveStatuses } from './chatLiveStatus';

describe('chatLiveStatus', () => {
  it('hands what the open chat publishes to every reader, and withdraws it', () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const seen: Array<ReadonlyMap<string, unknown>> = [];
    function Reader() { seen.push(useChatLiveStatuses()); return null; }
    const root = createRoot(document.createElement('div'));
    act(() => root.render(<Reader />));
    const key = chatLiveKey('p1', 'main');
    act(() => publishChatStatus(key, { tone: 'working', text: 'Thinking…', preview: null }));
    expect(seen[seen.length - 1].get(key)).toEqual({ tone: 'working', text: 'Thinking…', preview: null });
    const renders = seen.length;
    act(() => publishChatStatus(key, { tone: 'working', text: 'Thinking…', preview: null }));
    expect(seen.length).toBe(renders);
    act(() => publishChatStatus(key, null));
    expect(seen[seen.length - 1].has(key)).toBe(false);
    act(() => root.unmount());
  });
});
