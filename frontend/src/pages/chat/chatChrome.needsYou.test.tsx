// @vitest-environment jsdom
// The phone's Sessions button says how many sessions need you.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxRow } from '../../mobile/inbox';
import { ChatChromeProvider, ChatHistoryButton, type ChatChrome } from './chatChrome';

let data: { rows: InboxRow[]; live: Map<string, unknown>; setupOf: Map<string, string>; unseen: Set<string> } | null;
vi.mock('./simpleData', () => ({ useSimpleDataIfAny: () => data }));

function row(id: string, status: InboxRow['status'], waitingReason: InboxRow['waitingReason'] = null): InboxRow {
  return {
    key: `${id}|main`, projectId: id, projectName: id, workstream: 'main', owner: 'ada', shared: false, provider: 'claude-chat',
    instanceId: 'box-1', kind: 'normal', pinned: false, status, waitingReason, updatedAt: null, message: null,
    contextTokens: null, rateLimited: null, review: null, ring: null, band: 'other',
  } as InboxRow;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  data = { rows: [], live: new Map(), setupOf: new Map(), unseen: new Set() };
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function show(mode: ChatChrome['mode'] = 'drawer') {
  const value: ChatChrome = { mode, historyOpen: false, openHistory: () => {}, closeHistory: () => {} };
  act(() => root.render(<ChatChromeProvider value={value}><ChatHistoryButton /></ChatChromeProvider>));
}
const button = () => host.querySelector('button');

describe('ChatHistoryButton', () => {
  it('shows how many sessions need you, and says so in its name', () => {
    data!.rows = [row('a', 'waiting', 'approval'), row('b', 'waiting'), row('c', 'working'), row('d', 'idle'), row('e', 'not_running')];
    show();
    expect(button()?.textContent).toBe('Sessions2');
    expect(button()?.getAttribute('aria-label')).toBe('Sessions, 2 sessions need you');
    expect(host.querySelector('.chat-history-count')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('says one session needs you in the singular', () => {
    data!.rows = [row('a', 'waiting'), row('d', 'idle')];
    show();
    expect(button()?.getAttribute('aria-label')).toBe('Sessions, 1 session needs you');
  });

  it('shows no count when nothing needs you, or without the page\'s data', () => {
    data!.rows = [row('c', 'working'), row('d', 'idle')];
    show();
    expect(host.querySelector('.chat-history-count')).toBeNull();
    expect(button()?.hasAttribute('aria-label')).toBe(false);
    data = null;
    show();
    expect(host.querySelector('.chat-history-count')).toBeNull();
  });

  it('is not there while the list sits beside the chat', () => {
    data!.rows = [row('a', 'waiting')];
    show('docked');
    expect(button()).toBeNull();
  });
});
