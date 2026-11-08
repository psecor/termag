import { describe, it, expect } from 'vitest';
import type { Project, Workstream } from '../types';
import type { InboxRow } from '../mobile/inbox';
import { isAskChatWorkstream, isAskChatWorkstreamWs, sidebarWorkstreams, withoutAskChats } from './askChatVisibility';

const ws = (name: string, askThread?: Workstream['askThread']): Workstream => ({
  id: `ws-${name}`, projectId: 'p1', name, branch: name, archived: false,
  lastActiveAt: '2026-10-07T14:00:00Z', createdAt: '2026-10-07T10:00:00Z', updatedAt: '2026-10-07T14:00:00Z',
  askThread,
});
const row = (workstream: string, askThreadId?: string | null): InboxRow => ({
  key: `p1|${workstream}`, projectId: 'p1', projectName: 'termag', workstream,
  owner: 'psecor', shared: false, provider: 'claude', instanceId: 'box1', kind: 'normal',
  pinned: false, status: 'idle', waitingReason: null, updatedAt: null, message: null,
  contextTokens: null, rateLimited: null, review: null, ring: null, band: 'other',
  ...(askThreadId !== undefined ? { askThreadId } : {}),
});

describe('isAskChatWorkstream', () => {
  it('matches the ask-<thread id> form the orchestrator names ask chats', () => {
    expect(isAskChatWorkstream('ask-cmvpvr0by19t1ex4aevd9iv3e')).toBe(true);
    expect(isAskChatWorkstream('ask-0123456789')).toBe(true);
  });

  it('does not match main, human-named workstreams or a bare ask-', () => {
    expect(isAskChatWorkstream('main')).toBe(false);
    expect(isAskChatWorkstream('termag-tui')).toBe(false);
    expect(isAskChatWorkstream('ask-Fix')).toBe(false);
    expect(isAskChatWorkstream('ask-')).toBe(false);
  });
});

describe('isAskChatWorkstreamWs', () => {
  it('is true by the askThread record even when the name is not the ask- form', () => {
    expect(isAskChatWorkstreamWs(ws('main', { id: 't1', title: null }))).toBe(true);
  });

  it('is true for the ask- name with no record, and false for either on a plain workstream', () => {
    expect(isAskChatWorkstreamWs(ws('ask-cmvpvr0by19t1ex4aevd9iv3e'))).toBe(true);
    expect(isAskChatWorkstreamWs(ws('termag-tui'))).toBe(false);
  });
});

describe('sidebarWorkstreams', () => {
  const workstreams = [
    ws('main'),
    ws('termag-tui'),
    ws('ask-cmvpvr0by19t1ex4aevd9iv3e'),
    ws('ask-cmvpvr0by19t1ex4aevd9iv4f', { id: 't2', title: 'Which rate limits?' }),
  ];

  it('drops the ask chats unless the setting shows them, keeping main and the human-named ones', () => {
    expect(sidebarWorkstreams(workstreams, false, null).map(w => w.name)).toEqual(['main', 'termag-tui']);
    expect(sidebarWorkstreams(workstreams, true, null).map(w => w.name)).toEqual(workstreams.map(w => w.name));
  });

  it('keeps the ask chat that is the workstream on screen, so the open session never drops out', () => {
    const shown = sidebarWorkstreams(workstreams, false, 'ask-cmvpvr0by19t1ex4aevd9iv3e');
    expect(shown.map(w => w.name)).toEqual(['main', 'termag-tui', 'ask-cmvpvr0by19t1ex4aevd9iv3e']);
  });

  it('keeps a remembered selection only while its project is the one open: on another project\'s screen it hides again', () => {
    // The caller passes the selection only for the active project; null here
    // is what a closed project's remembered ask- selection becomes.
    expect(sidebarWorkstreams(workstreams, false, null).map(w => w.name)).toEqual(['main', 'termag-tui']);
  });

  it('does not mutate its input', () => {
    const before = [...workstreams];
    sidebarWorkstreams(workstreams, false, null);
    expect(workstreams).toEqual(before);
  });
});

describe('withoutAskChats', () => {
  it('drops rows whose workstream is an ask chat, by record or by name, and keeps the rest', () => {
    const rows = [
      row('main'),
      row('termag-tui'),
      row('ask-cmvpvr0by19t1ex4aevd9iv3e'),
      row('titled-ask', 't2'),
    ];
    expect(withoutAskChats(rows).map(r => r.workstream)).toEqual(['main', 'termag-tui']);
  });
});
