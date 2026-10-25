import { describe, it, expect } from 'vitest';
import {
  agentUp, bootEstimateMinutes, CLAIM_TTL_MS, claimHeldUntil, claimQueued, finishQueued, newChatNames, orchestratorOption, preLaunchTail,
  readLastStart, readQueued, releaseQueued, setupComplete, setupSteps, showSetup, startBlocker, uniqueName, writeLastStart, writeQueued,
  type SetupInput,
} from './newChat';

describe('uniqueName', () => {
  it('keeps a free name and numbers a taken one', () => {
    expect(uniqueName('web', [])).toBe('web');
    expect(uniqueName('web', ['web'])).toBe('web-2');
    expect(uniqueName('web', ['Web', 'web-2'])).toBe('web-3');
  });
});

describe('newChatNames', () => {
  it('names the project after the repo and the box after the project', () => {
    expect(newChatNames('web', [], [])).toEqual({ projectName: 'web', boxName: 'web' });
    expect(newChatNames('web', ['web'], ['web'])).toEqual({ projectName: 'web-2', boxName: 'web-2' });
    expect(newChatNames('web', ['web'], ['web-2'])).toEqual({ projectName: 'web-2', boxName: 'web-2-2' });
  });
  it('falls back to a valid box name', () => {
    expect(newChatNames('web.app', [], []).boxName).toBe('chat');
  });
});

describe('bootEstimateMinutes', () => {
  const box = (createdAt: string, readyAt: string | null, extra: object = {}) =>
    ({ kind: 'ec2' as const, createdAt, readyAt, claimedAt: null, ...extra });

  it('is the median launch-to-ready time of cold boxes, rounded, at least a minute', () => {
    expect(bootEstimateMinutes([
      box('2026-10-01T10:00:00Z', '2026-10-01T10:04:00Z'),
      box('2026-10-02T10:00:00Z', '2026-10-02T10:06:00Z'),
      box('2026-10-03T10:00:00Z', '2026-10-03T10:20:00Z'),
    ])).toBe(6);
    expect(bootEstimateMinutes([box('2026-10-01T10:00:00Z', '2026-10-01T10:00:20Z')])).toBe(1);
  });

  it('ignores claimed warm boxes, external hosts and boxes not up yet', () => {
    expect(bootEstimateMinutes([
      box('2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z', { claimedAt: '2026-10-01T11:30:00Z' }),
      box('2026-10-01T10:00:00Z', '2026-10-01T10:03:00Z', { kind: 'external' }),
      box('2026-10-01T10:00:00Z', null),
    ])).toBeNull();
  });
});

describe('setupSteps', () => {
  const base: SetupInput = {
    box: { name: 'web', status: 'provisioning', provisioningError: null, claimedAt: null },
    setupStatus: 'pending', repo: 'acme/web', agentUp: false, etaMinutes: 4,
  };

  it('narrates a cold launch with its estimate, the clone and Claude waiting their turn', () => {
    expect(setupSteps(base)).toEqual([
      { id: 'box', state: 'active', text: 'Launching box web · usually about 4 min' },
      { id: 'clone', state: 'pending', text: 'Clone acme/web' },
      { id: 'agent', state: 'pending', text: 'Starting Claude' },
    ]);
    expect(setupSteps({ ...base, etaMinutes: null })[0].text).toBe('Launching box web · usually a few minutes');
  });

  it('says a warm box was claimed, then follows the clone', () => {
    const claimed = { ...base, box: { ...base.box!, status: 'ready' as const, claimedAt: '2026-10-15T10:00:00Z' } };
    expect(setupSteps(claimed).map(s => [s.state, s.text])).toEqual([
      ['done', 'Claimed a ready box, web'],
      ['active', 'Clone acme/web'],
      ['pending', 'Starting Claude'],
    ]);
    expect(setupSteps({ ...claimed, setupStatus: 'cloning' })[1]).toEqual({ id: 'clone', state: 'active', text: 'Cloning acme/web' });
    expect(setupSteps({ ...claimed, setupStatus: 'ready' }).map(s => s.state)).toEqual(['done', 'done', 'active']);
    const up = setupSteps({ ...claimed, setupStatus: 'ready', agentUp: true });
    expect(up[2]).toEqual({ id: 'agent', state: 'done', text: 'Claude is ready' });
    expect(setupComplete(up)).toBe(true);
  });

  it('reports a failed box or clone with its reason and holds Claude', () => {
    const boxFailed = setupSteps({ ...base, box: { ...base.box!, status: 'failed', provisioningError: 'No box AMI found' } });
    expect(boxFailed[0]).toEqual({ id: 'box', state: 'failed', text: 'Box web failed to launch: No box AMI found' });
    expect(boxFailed[2].state).toBe('pending');
    const ready = { ...base.box!, status: 'ready' as const };
    const cloneFailed = setupSteps({ ...base, box: ready, setupStatus: 'failed', setupError: 'repository not found' });
    expect(cloneFailed[1]).toEqual({ id: 'clone', state: 'failed', text: 'Clone of acme/web failed: repository not found' });
    expect(cloneFailed[2].state).toBe('pending');
  });

  it('on a box that clones in the pane, the clone runs until Claude is up', () => {
    const ready = { ...base.box!, status: 'ready' as const };
    expect(setupSteps({ ...base, box: ready, setupStatus: 'none' }).map(s => [s.id, s.state, s.text])).toEqual([
      ['box', 'done', 'Box web is up'],
      ['clone', 'active', 'Cloning acme/web'],
      ['agent', 'pending', 'Starting Claude'],
    ]);
    expect(setupSteps({ ...base, box: ready, setupStatus: 'none', agentUp: true }).map(s => s.state)).toEqual(['done', 'done', 'done']);
  });

  it('has no clone step without a repository', () => {
    const steps = setupSteps({ ...base, repo: null, box: { ...base.box!, status: 'ready' }, setupStatus: 'none' });
    expect(steps.map(s => s.id)).toEqual(['box', 'agent']);
    expect(steps[1].state).toBe('active');
  });
});

describe('agentUp', () => {
  it('is up on any hook status or with its input box on screen', () => {
    expect(agentUp('idle', null)).toBe(true);
    expect(agentUp('working', null)).toBe(true);
    expect(agentUp(undefined, '')).toBe(true);
    expect(agentUp('not_running', null)).toBe(false);
    expect(agentUp(undefined, undefined)).toBe(false);
  });
});

function memory() {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v); },
      removeItem: (k: string) => { m.delete(k); },
    };
}

describe('queued first message', () => {

  it('is kept per project until cleared', () => {
    const s = memory();
    writeQueued(s, 'p1', 'fix the login bug');
    expect(readQueued(s, 'p1')).toBe('fix the login bug');
    expect(readQueued(s, 'p2')).toBeNull();
    finishQueued(s, 'p1', 'fix the login bug');
    expect(readQueued(s, 'p1')).toBeNull();
  });

  it('says whether storage held the message', () => {
    expect(writeQueued(memory(), 'p1', 'fix it')).toBe(true);
    expect(writeQueued(null, 'p1', 'fix it')).toBe(false);
    const refusing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} };
    expect(writeQueued(refusing, 'p1', 'fix it')).toBe(false);
  });

  it('after a send, keeps what was queued behind it', () => {
    const s = memory();
    writeQueued(s, 'p1', 'first second');
    finishQueued(s, 'p1', 'first');
    expect(readQueued(s, 'p1')).toBe('second');
    finishQueued(s, 'p1', 'second');
    expect(readQueued(s, 'p1')).toBeNull();
  });

  it('stores nothing for an empty message and survives a missing or broken store', () => {
    const s = memory();
    writeQueued(s, 'p1', '   ');
    expect(readQueued(s, 'p1')).toBeNull();
    expect(readQueued(null, 'p1')).toBeNull();
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
    expect(() => writeQueued(broken, 'p1', 'x')).not.toThrow();
    expect(readQueued(broken, 'p1')).toBeNull();
  });
});

describe('preLaunchTail', () => {
  it('is the last lines the box printed before any turn', () => {
    const blocks = [{ kind: 'system' as const, text: 'banner\n\n$ git fetch origin\nUsername for \'https://github.com\':  ' }];
    expect(preLaunchTail(blocks, 2)).toEqual(['$ git fetch origin', "Username for 'https://github.com':"]);
  });
  it('is empty once the agent has had a turn, or with nothing printed', () => {
    expect(preLaunchTail([{ kind: 'system', text: 'x' }, { kind: 'you', text: 'hi' }])).toEqual([]);
    expect(preLaunchTail([])).toEqual([]);
  });
});

describe('claiming the queued message', () => {
  it('lets one tab send it; a second tab skips a fresh claim', () => {
    const s = memory();
    writeQueued(s, 'p1', 'fix it');
    expect(claimQueued(s, 'p1', 'tab-a', 1_000)).toBe('fix it');
    expect(claimQueued(s, 'p1', 'tab-b', 2_000)).toBeNull();
    expect(claimQueued(s, 'p1', 'tab-a', 2_000)).toBe('fix it');
  });

  it('lets another tab take over a claim left by a tab that went away', () => {
    const s = memory();
    writeQueued(s, 'p1', 'fix it');
    claimQueued(s, 'p1', 'tab-a', 1_000);
    expect(claimQueued(s, 'p1', 'tab-b', 1_000 + CLAIM_TTL_MS)).toBe('fix it');
  });

  it('keeps the message after a failed send, and drops it with its claim after a good one', () => {
    const s = memory();
    writeQueued(s, 'p1', 'fix it');
    claimQueued(s, 'p1', 'tab-a', 1_000);
    releaseQueued(s, 'p1', 'tab-a');
    expect(readQueued(s, 'p1')).toBe('fix it');
    expect(claimQueued(s, 'p1', 'tab-b', 1_001)).toBe('fix it');
    finishQueued(s, 'p1', 'fix it');
    expect(readQueued(s, 'p1')).toBeNull();
    expect(claimQueued(s, 'p1', 'tab-b', 1_002)).toBeNull();
  });

  it('only releases its own claim', () => {
    const s = memory();
    writeQueued(s, 'p1', 'fix it');
    claimQueued(s, 'p1', 'tab-a', 1_000);
    releaseQueued(s, 'p1', 'tab-b');
    expect(claimQueued(s, 'p1', 'tab-b', 1_001)).toBeNull();
  });

  it('says when the current claim expires', () => {
    const s = memory();
    expect(claimHeldUntil(s, 'p1')).toBeNull();
    writeQueued(s, 'p1', 'fix it');
    claimQueued(s, 'p1', 'tab-a', 1_000);
    expect(claimHeldUntil(s, 'p1')).toBe(1_000 + CLAIM_TTL_MS);
  });

  it('has nothing to claim without a message or a store', () => {
    expect(claimQueued(memory(), 'p1', 'tab-a', 1)).toBeNull();
    expect(claimQueued(null, 'p1', 'tab-a', 1)).toBeNull();
  });
});

describe('showSetup', () => {
  const quiet = { held: false, queued: false, up: false, captured: true, turns: 0 };
  it('shows while held or while a message waits', () => {
    expect(showSetup({ ...quiet, held: true, captured: false })).toBe(true);
    expect(showSetup({ ...quiet, queued: true, up: true, turns: 3 })).toBe(true);
  });
  it('shows for a chat with no message whose Claude is not up and whose pane has no conversation', () => {
    expect(showSetup(quiet)).toBe(true);
  });
  it('hides once Claude is up, once there is a conversation, or before the first capture', () => {
    expect(showSetup({ ...quiet, up: true })).toBe(false);
    expect(showSetup({ ...quiet, turns: 2 })).toBe(false);
    expect(showSetup({ ...quiet, captured: false })).toBe(false);
  });
});

describe('startBlocker', () => {
  const ok = {
    busy: false, hasRepo: true, name: 'web', nameError: '', spacesReady: true, spaceError: '',
    boxReady: false, boxName: 'web', boxError: '',
  };

  it('is empty when Start can go, or while a start is under way', () => {
    expect(startBlocker(ok)).toBe('');
    expect(startBlocker({ ...ok, busy: true, hasRepo: false })).toBe('');
  });

  it('says the first thing in the way', () => {
    expect(startBlocker({ ...ok, hasRepo: false })).toMatch(/repository URL/);
    expect(startBlocker({ ...ok, name: '' })).toBe('Give the session a name under Options');
    expect(startBlocker({ ...ok, nameError: 'Letters, digits, - and _ only' })).toBe('Session name: Letters, digits, - and _ only');
    expect(startBlocker({ ...ok, spacesReady: false })).toMatch(/spaces/);
    expect(startBlocker({ ...ok, spaceError: 'Name the new space' })).toBe('Name the new space');
    expect(startBlocker({ ...ok, boxName: '' })).toMatch(/box a name/);
    expect(startBlocker({ ...ok, boxError: 'bad' })).toBe('Box name: bad');
  });

  it('ignores the box name once a box was launched for this attempt', () => {
    expect(startBlocker({ ...ok, boxReady: true, boxName: '', boxError: 'bad' })).toBe('');
  });
});

describe('readLastStart / writeLastStart', () => {
  function memStore() {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  }
  const none = { pick: null, space: null, model: 'sonnet' };

  it('remembers a listed or pasted repository, the space and the model', () => {
    const store = memStore();
    expect(readLastStart(store)).toEqual(none);
    writeLastStart(store, { pick: { kind: 'listed', fullName: 'acme/web', defaultBranch: 'main' }, space: 'notes', model: 'opus' });
    expect(readLastStart(store)).toEqual({ pick: { kind: 'listed', fullName: 'acme/web', defaultBranch: 'main' }, space: 'notes', model: 'opus' });
    writeLastStart(store, { pick: { kind: 'pasted', url: 'https://github.com/acme/api' }, space: null, model: 'haiku' });
    expect(readLastStart(store)).toEqual({ pick: { kind: 'pasted', url: 'https://github.com/acme/api' }, space: null, model: 'haiku' });
  });

  it('forgets the repository for a pick it cannot keep', () => {
    const store = memStore();
    writeLastStart(store, { pick: { kind: 'listed', fullName: 'acme/web', defaultBranch: 'main' }, space: 'notes', model: 'sonnet' });
    writeLastStart(store, { pick: { kind: 'empty' }, space: 'notes', model: 'sonnet' });
    expect(readLastStart(store)).toEqual({ pick: null, space: 'notes', model: 'sonnet' });
  });

  it('reads a model no longer offered, including the retired Auto, as Sonnet', () => {
    const store = memStore();
    store.setItem('termag-chat-last-start', JSON.stringify({ pick: null, space: 'notes', model: 'opus-3' }));
    expect(readLastStart(store)).toEqual({ pick: null, space: 'notes', model: 'sonnet' });
    store.setItem('termag-chat-last-start', JSON.stringify({ pick: null, space: 'notes', model: 'auto' }));
    expect(readLastStart(store)).toEqual({ pick: null, space: 'notes', model: 'sonnet' });
  });

  it('reads garbage, or no storage, as nothing remembered', () => {
    const store = memStore();
    store.setItem('termag-chat-last-start', '{not json');
    expect(readLastStart(store)).toEqual(none);
    store.setItem('termag-chat-last-start', JSON.stringify({ pick: { kind: 'listed', fullName: 3 }, space: 7, model: 4 }));
    expect(readLastStart(store)).toEqual(none);
    expect(readLastStart(null)).toEqual(none);
    expect(() => writeLastStart(null, { pick: { kind: 'empty' }, space: null, model: 'sonnet' })).not.toThrow();
  });
});

describe('orchestratorOption', () => {
  it('is hidden without the skill or for a schedule, and needs trust otherwise', () => {
    expect(orchestratorOption({ providerHasSkill: false, scheduled: false, trusted: true })).toBe('hidden');
    expect(orchestratorOption({ providerHasSkill: true, scheduled: true, trusted: true })).toBe('hidden');
    expect(orchestratorOption({ providerHasSkill: true, scheduled: false, trusted: false })).toBe('needs-trust');
    expect(orchestratorOption({ providerHasSkill: true, scheduled: false, trusted: true })).toBe('available');
  });
});
