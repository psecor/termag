import { describe, expect, it } from 'vitest';
import { chatTurnTag, chatTurnUrl, notifyState, plainPreview, seedWorkingTurns, shouldNotifyHere, showSetupHint, stepTurn, turnNotificationText, turnPreview } from './turnNotify';

function run(events: unknown[]): boolean[] {
  let open = false;
  return events.map(e => { const s = stepTurn(open, e); open = s.open; return s.ready; });
}

describe('stepTurn', () => {
  it('is ready once per answer, not again on the turn-end after it', () => {
    expect(run([
      { type: 'turn-start', text: 'go' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } },
      { type: 'result', result: 'Done.' },
      { type: 'turn-end', exitCode: 0, signal: null },
    ])).toEqual([false, false, true, false]);
  });

  it('is ready on each answer of a live turn, never while it only waits on background work', () => {
    expect(run([
      { type: 'turn-start', text: 'ask termag' },
      { type: 'result', result: 'The ask is waiting in the background.' },
      { type: 'system', subtype: 'background_tasks_changed' },
      { type: 'user', isReplay: true, message: { content: 'are you there?' } },
      { type: 'result', result: 'Still waiting on it.' },
      // The task finishes and Claude answers on its own.
      { type: 'assistant', message: { content: [{ type: 'text', text: 'The ask came back.' }] } },
      { type: 'result', result: 'The ask came back.' },
      { type: 'turn-end', exitCode: 0 },
    ])).toEqual([false, true, false, false, true, false, true, false]);
  });

  it('is ready on a turn that failed without an answer, not one someone stopped', () => {
    expect(run([{ type: 'turn-start' }, { type: 'turn-end', exitCode: 1 }])).toEqual([false, true]);
    expect(run([{ type: 'turn-start' }, { type: 'turn-end', exitCode: null, signal: 'SIGTERM' }])).toEqual([false, false]);
  });

  it('ignores tool results and an old prompt replayed without isReplay', () => {
    expect(run([
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'user', message: { content: 'old prompt' } },
      { type: 'result', result: 'x' },
    ])).toEqual([false, false, false]);
  });
});

describe('plainPreview', () => {
  it('matches the push: no emphasis, ticks or leading marker', () => {
    expect(plainPreview('Read **README.md** and `src/`')).toBe('Read README.md and src/');
    expect(plainPreview('> quoted')).toBe('quoted');
    expect(turnNotificationText('orchestrator', 'main', '**Done**').body).toBe('Your turn · Done');
  });
});

describe('turnPreview and turnNotificationText', () => {
  it('takes the first line of the answer', () => {
    expect(turnPreview({ type: 'result', result: '\n\n  All   green.\nMore.' })).toBe('All green.');
    expect(turnPreview({ type: 'result' })).toBeNull();
    expect(turnPreview(null)).toBeNull();
  });

  it('matches the push', () => {
    expect(turnNotificationText('orchestrator', 'main', 'All green.')).toEqual({ title: 'orchestrator', body: 'Your turn · All green.' });
    expect(turnNotificationText('orchestrator', 'feat', null)).toEqual({ title: 'orchestrator · feat', body: 'Done · your turn' });
    expect(turnNotificationText('p', 'main', 'x'.repeat(400)).body).toHaveLength('Your turn · '.length + 180);
    expect(chatTurnTag('p1', 'main')).toBe('chat-turn:p1:main');
    expect(chatTurnUrl('p1', 'feat')).toBe('/termag/chat/p/p1?ws=feat');
  });
});

describe('shouldNotifyHere', () => {
  const chat = { projectId: 'p1', workstream: 'main' };
  const base = { enabled: true, permission: 'granted' as const, pushCovers: false, looking: true, shown: { projectId: 'p2', workstream: 'main' }, chat };

  it('notifies for another chat, or this one when the tab is in the background', () => {
    expect(shouldNotifyHere(base)).toBe(true);
    expect(shouldNotifyHere({ ...base, shown: chat, looking: false })).toBe(true);
    expect(shouldNotifyHere({ ...base, shown: null })).toBe(true);
  });

  it('never for the chat the person is looking at', () => {
    expect(shouldNotifyHere({ ...base, shown: chat })).toBe(false);
    expect(shouldNotifyHere({ ...base, shown: { projectId: 'p1', workstream: 'feat' } })).toBe(true);
  });

  it('leaves it to push on a subscribed device, and needs the opt-in and the permission', () => {
    expect(shouldNotifyHere({ ...base, pushCovers: true })).toBe(false);
    expect(shouldNotifyHere({ ...base, enabled: false })).toBe(false);
    expect(shouldNotifyHere({ ...base, permission: 'default' })).toBe(false);
    expect(shouldNotifyHere({ ...base, permission: 'unsupported' })).toBe(false);
  });
});

describe('seedWorkingTurns', () => {
  it('opens a turn for a chat already working at load, so its answer notifies', () => {
    const open = new Map<string, boolean>();
    seedWorkingTurns(open, ['p1|main']);
    expect(stepTurn(open.get('p1|main') ?? false, { type: 'result', result: 'ok' }).ready).toBe(true);
  });
  it('leaves a chat the follower already tracks alone', () => {
    const open = new Map([['p1|main', false]]);
    seedWorkingTurns(open, ['p1|main', 'p2|feat']);
    expect([...open]).toEqual([['p1|main', false], ['p2|feat', true]]);
  });
});

describe('showSetupHint', () => {
  const never = { flag: true, optedIn: false, permission: 'default' as const, dismissed: false };
  it('shows only while notifications were never set up and the hint was not dismissed', () => {
    expect(showSetupHint(never)).toBe(true);
    expect(showSetupHint({ ...never, flag: false })).toBe(false);
    expect(showSetupHint({ ...never, optedIn: true })).toBe(false);
    expect(showSetupHint({ ...never, permission: 'granted' })).toBe(false);
    expect(showSetupHint({ ...never, permission: 'denied' })).toBe(false);
    expect(showSetupHint({ ...never, permission: 'unsupported' })).toBe(false);
    expect(showSetupHint({ ...never, dismissed: true })).toBe(false);
  });
});

describe('notifyState', () => {
  const base = { flag: true, optedIn: true, permission: 'granted' as const, pushCovers: false };
  it.each([
    [{ ...base, flag: false }, 'hidden'],
    [{ ...base, permission: 'unsupported' as const }, 'unsupported'],
    [{ ...base, permission: 'denied' as const }, 'blocked'],
    [{ ...base, optedIn: false }, 'off'],
    [{ ...base, permission: 'default' as const }, 'off'],
    [base, 'on-tab'],
    [{ ...base, pushCovers: true }, 'on-push'],
  ])('%j → %s', (input, expected) => {
    expect(notifyState(input)).toBe(expected);
  });
});
