import { describe, expect, it } from 'vitest';
import { chatRowState, liveUnlessWaiting } from './rowState';
import type { InboxRow } from '../mobile/inbox';

function row(over: Partial<InboxRow> = {}): InboxRow {
  return {
    status: 'idle', waitingReason: null, band: 'other', ring: null, review: null, message: null,
    ...over,
  } as InboxRow;
}

describe('chatRowState', () => {
  it('is working while a turn runs, from the hooks or the live chat, while the box sets it up, and while Devin reviews', () => {
    expect(chatRowState(row({ status: 'working', band: 'running' }), undefined, null)).toMatchObject({ kind: 'working', text: 'Working' });
    expect(chatRowState(row(), { tone: 'working', text: 'Working · Edit · evaluator.ts', preview: 'Looking at it' }, null))
      .toEqual({ kind: 'working', text: 'Working · Edit · evaluator.ts', message: 'Looking at it', unseen: false });
    expect(chatRowState(row(), { tone: 'setup', text: 'Working · setting up · starting claude', preview: null }, null).kind).toBe('working');
    expect(chatRowState(row({ status: 'not_running' }), undefined, 'cloning')).toMatchObject({ kind: 'working', text: 'Working · setting up' });
    expect(chatRowState(row({ ring: 'reviewing', band: 'reviewing', review: { pr: 12 } as InboxRow['review'] }), undefined, null))
      .toMatchObject({ kind: 'working', text: 'Working · reviewing #12' });
  });

  it('asks for approval in amber, and for an answer in blue', () => {
    expect(chatRowState(row({ status: 'waiting', waitingReason: 'approval', band: 'attention' }), undefined, null))
      .toMatchObject({ kind: 'approval', text: 'Needs you · approval' });
    expect(chatRowState(row({ status: 'waiting', waitingReason: 'user_input', band: 'attention' }), undefined, null))
      .toMatchObject({ kind: 'unread', text: 'Needs you · a question' });
    expect(chatRowState(row({ status: 'waiting', band: 'attention' }), undefined, null)).toMatchObject({ kind: 'unread', text: 'Needs you' });
  });

  it('marks a finished review that needs you in blue, even while the agent works, as its words say', () => {
    expect(chatRowState(row({ ring: 'done', band: 'attention' }), undefined, null)).toMatchObject({ kind: 'unread', text: 'Needs you · review ready' });
    expect(chatRowState(row({ status: 'working', ring: 'done', band: 'attention' }), undefined, null))
      .toMatchObject({ kind: 'unread', text: 'Needs you · review ready' });
  });

  it('is red when the live turn stopped on an error, whatever the hooks say', () => {
    expect(chatRowState(row({ status: 'working' }), { tone: 'error', text: 'Needs you · failed', preview: null }, null))
      .toEqual({ kind: 'error', text: 'Needs you · failed', message: null, unseen: false });
  });

  it('follows the live status alone when there is one, so the mark says what the words say', () => {
    const idle = { tone: 'idle' as const, text: 'Idle · your turn', preview: null };
    expect(chatRowState(row({ status: 'waiting', waitingReason: 'approval', band: 'attention' }), idle, null))
      .toMatchObject({ kind: 'done', text: 'Idle' });
    expect(chatRowState(row({ ring: 'done', band: 'attention' }), idle, null).kind).toBe('done');
    // A stored chat whose box is down: no agent runs, so the open chat's row is Not running too.
    expect(chatRowState(row(), { tone: 'off', text: 'Not running · box is stopped, sending a message starts it', preview: null }, null))
      .toMatchObject({ kind: 'off', text: 'Not running · box is stopped, sending a message starts it' });
  });

  it('keeps a session that came to rest since you looked in its own state, with " · unread" and the dot', () => {
    expect(chatRowState(row({ message: 'All green' }), undefined, null, true))
      .toEqual({ kind: 'done', text: 'Idle · unread', message: 'All green', unseen: true });
    expect(chatRowState(row({ status: 'not_running' }), undefined, null, true))
      .toMatchObject({ kind: 'off', text: 'Not running · unread', unseen: true });
    // What needs you, or runs, says so first; an open chat's live status still decides alone.
    expect(chatRowState(row({ status: 'waiting', waitingReason: 'approval', band: 'attention' }), undefined, null, true))
      .toMatchObject({ kind: 'approval', unseen: false });
    expect(chatRowState(row({ status: 'working', band: 'running' }), undefined, null, true)).toMatchObject({ kind: 'working', unseen: false });
    expect(chatRowState(row(), { tone: 'idle', text: 'Idle · your turn', preview: null }, null, true)).toMatchObject({ kind: 'done', unseen: false });
  });

  // a box that parks leaves a waiting status standing, and the open chat on it read Not running, so the
  // redesign's Group by Status filed a session with an unanswered question or approval under Not running.
  it('never reads a session that waits on you as Not running in the redesign, open or not', () => {
    const parked = { tone: 'off' as const, text: 'Not running · box is stopped, sending a message starts it', preview: null };
    const approval = row({ status: 'waiting', waitingReason: 'approval', band: 'attention' });
    const question = row({ status: 'waiting', waitingReason: 'user_input', band: 'attention' });
    const review = row({ ring: 'done', band: 'attention' });
    expect(liveUnlessWaiting(approval, parked)).toBeUndefined();
    expect(chatRowState(approval, liveUnlessWaiting(approval, parked), null)).toMatchObject({ kind: 'approval', text: 'Needs you · approval' });
    expect(chatRowState(question, liveUnlessWaiting(question, parked), null)).toMatchObject({ kind: 'unread', text: 'Needs you · a question' });
    expect(chatRowState(review, liveUnlessWaiting(review, parked), null)).toMatchObject({ kind: 'unread', text: 'Needs you · review ready' });
    // Nothing waits: a parked chat is Not running, as before.
    expect(chatRowState(row(), liveUnlessWaiting(row(), parked), null)).toMatchObject({ kind: 'off' });
    // With the box up the live chat still decides alone (it knows better than the hooks).
    const idle = { tone: 'idle' as const, text: 'Idle · your turn', preview: null };
    expect(liveUnlessWaiting(approval, idle)).toBe(idle);
    expect(liveUnlessWaiting(approval, undefined)).toBeUndefined();
  });

  it('shows nothing for done, and dims an agent that is not running', () => {
    expect(chatRowState(row({ message: 'All green' }), undefined, null)).toEqual({ kind: 'done', text: 'Idle', message: 'All green', unseen: false });
    expect(chatRowState(row(), { tone: 'idle', text: 'Idle · your turn', preview: 'Want it on?' }, null))
      .toEqual({ kind: 'done', text: 'Idle', message: 'Want it on?', unseen: false });
    expect(chatRowState(row({ status: 'not_running' }), undefined, null)).toMatchObject({ kind: 'off', text: 'Not running' });
  });
});
