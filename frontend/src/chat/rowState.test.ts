import { describe, expect, it } from 'vitest';
import { chatRowState } from './rowState';
import type { InboxRow } from '../mobile/inbox';

function row(over: Partial<InboxRow> = {}): InboxRow {
  return {
    status: 'idle', waitingReason: null, band: 'other', ring: null, review: null, message: null,
    ...over,
  } as InboxRow;
}

describe('chatRowState', () => {
  it('is working while a turn runs, from the hooks or the live chat, and while the box sets it up', () => {
    expect(chatRowState(row({ status: 'working', band: 'running' }), undefined, null)).toMatchObject({ kind: 'working', text: 'Running' });
    expect(chatRowState(row(), { tone: 'working', text: 'Editing evaluator.ts', preview: 'Looking at it' }, null))
      .toEqual({ kind: 'working', text: 'Editing evaluator.ts', message: 'Looking at it' });
    expect(chatRowState(row(), { tone: 'setup', text: 'Starting the box', preview: null }, null).kind).toBe('working');
    expect(chatRowState(row({ status: 'not_running' }), undefined, 'cloning')).toMatchObject({ kind: 'working', text: 'Setting up…' });
  });

  it('asks for approval in amber, and for an answer in blue', () => {
    expect(chatRowState(row({ status: 'waiting', waitingReason: 'approval', band: 'attention' }), undefined, null))
      .toMatchObject({ kind: 'approval', text: 'Needs approval' });
    expect(chatRowState(row({ status: 'waiting', waitingReason: 'user_input', band: 'attention' }), undefined, null))
      .toMatchObject({ kind: 'unread', text: 'Asked you a question' });
    expect(chatRowState(row({ status: 'waiting', band: 'attention' }), undefined, null).kind).toBe('unread');
  });

  it('marks a finished review that needs you in blue', () => {
    expect(chatRowState(row({ ring: 'done', band: 'attention' }), undefined, null)).toMatchObject({ kind: 'unread', text: 'Review ready' });
  });

  it('is red when the live turn stopped on an error, whatever the hooks say', () => {
    expect(chatRowState(row({ status: 'working' }), { tone: 'error', text: 'Stopped · rate limited', preview: null }, null))
      .toEqual({ kind: 'error', text: 'Stopped · rate limited', message: null });
  });

  it('follows the live status alone when there is one, so the mark says what the words say', () => {
    const idle = { tone: 'idle' as const, text: 'Done · your turn', preview: null };
    expect(chatRowState(row({ status: 'waiting', waitingReason: 'approval', band: 'attention' }), idle, null))
      .toMatchObject({ kind: 'done', text: 'Done · your turn' });
    expect(chatRowState(row({ ring: 'done', band: 'attention' }), idle, null).kind).toBe('done');
  });

  it('marks in blue a session that came to rest since you looked, even one no longer running', () => {
    expect(chatRowState(row({ message: 'All green' }), undefined, null, true))
      .toEqual({ kind: 'unread', text: 'Ready · unseen', message: 'All green' });
    expect(chatRowState(row({ status: 'not_running' }), undefined, null, true)).toMatchObject({ kind: 'unread', text: 'Not running · unseen' });
    // What needs you, or runs, says so first; an open chat's live status still decides alone.
    expect(chatRowState(row({ status: 'waiting', waitingReason: 'approval', band: 'attention' }), undefined, null, true).kind).toBe('approval');
    expect(chatRowState(row({ status: 'working', band: 'running' }), undefined, null, true).kind).toBe('working');
    expect(chatRowState(row(), { tone: 'idle', text: 'Done · your turn', preview: null }, null, true).kind).toBe('done');
  });

  it('shows nothing for done, and dims an agent that is not running', () => {
    expect(chatRowState(row({ message: 'All green' }), undefined, null)).toEqual({ kind: 'done', text: 'Ready', message: 'All green' });
    expect(chatRowState(row(), { tone: 'idle', text: 'Done · your turn', preview: 'Want it on?' }, null))
      .toEqual({ kind: 'done', text: 'Done · your turn', message: 'Want it on?' });
    expect(chatRowState(row({ status: 'not_running' }), undefined, null)).toMatchObject({ kind: 'off', text: 'Not running' });
  });
});
