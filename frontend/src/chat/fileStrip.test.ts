// The file strip's one function (chat/fileStrip.ts), driven through event
// sequences with the expected strip after every step. The chat is simulated
// with the real reducer (chat/sdkChat.ts), the pre-ready queue as
// useQueuedMessage behaves: one entry per chat, a second message appended to
// the waiting one, an error that holds until Retry.
import { describe, expect, it } from 'vitest';
import { EMPTY_STRIP, fileLine, reduceStrip, replyFirstLine, stripState, stripStatusText, type StripEvent, type StripModel, type StripState } from './fileStrip';
import { addPending, applyEvent, emptyChat, type ChatState } from './sdkChat';
import { countSent } from './fileChat';

interface Session { strip: StripModel; chat: ChatState; queue: { text: string | null; error: string | null }; ready: boolean; inFlight: string | null }
const fresh = (): Session => ({ strip: EMPTY_STRIP, chat: emptyChat, queue: { text: null, error: null }, ready: false, inFlight: null });

type Step =
  | ['send', string] | ['sendFails'] | ['sendFailsAway', string] | ['restored'] | ['seen'] | ['sendOk']
  | ['queue', string] | ['ready'] | ['queueFails', string] | ['queueGoes'] | ['retry']
  | ['turnStart', string] | ['reply', string] | ['turnEnd'] | ['stop'] | ['runnerError', string]
  | ['dismiss'] | ['session', string];

function describeStrip(s: StripState): string {
  switch (s.kind) {
    case 'hidden': return 'hidden';
    case 'sending': return 'sending';
    case 'queued': return `queued ${s.where} ×${s.count}`;
    case 'working': return s.text ? `working: ${s.text}` : 'working';
    case 'done': return `${s.outcome}${s.text ? `: ${s.text}` : ''}`;
    case 'failed': return `failed ×${s.count}: ${s.error}${s.retry ? ' [Retry]' : ''}${s.away ? ' (back in the box)' : ''}`;
  }
}

function run(steps: Array<[Step, string]>) {
  const sessions = new Map<string, Session>([['a', fresh()]]);
  let cur = 'a';
  const get = () => sessions.get(cur)!;
  const ev = (e: StripEvent) => { const s = get(); s.strip = reduceStrip(s.strip, e); };
  // What FileChat dispatches whenever the queue (or the history, once ready) changes.
  const snapshot = () => {
    const s = get();
    ev({ type: 'queue', text: s.queue.text, error: s.queue.error, count: s.queue.text != null && s.ready ? countSent(s.chat, s.queue.text) : null });
  };
  const seen: string[] = [];
  for (const [step, expected] of steps) {
    const s = get();
    switch (step[0]) {
      case 'send': {
        // The composer's deliver: counted, then the pending bubble.
        const occurrence = countSent(s.chat, step[1]) + 1;
        ev({ type: 'sending', text: step[1], occurrence });
        s.chat = addPending(s.chat, step[1]);
        s.inFlight = step[1];
        break;
      }
      case 'sendOk': ev({ type: 'sent' }); s.inFlight = null; break;
      case 'sendFails': {
        ev({ type: 'unsent' });
        const t = s.inFlight;
        s.chat = { ...s.chat, items: s.chat.items.filter(it => !(it.kind === 'user' && it.pending && it.text === t)) };
        s.inFlight = null;
        break;
      }
      case 'sendFailsAway': {
        ev({ type: 'unsent', away: { error: step[1], typed: s.inFlight ?? '', images: 0 } });
        const t = s.inFlight;
        s.chat = { ...s.chat, items: s.chat.items.filter(it => !(it.kind === 'user' && it.pending && it.text === t)) };
        s.inFlight = null;
        break;
      }
      case 'restored': ev({ type: 'restored' }); break;
      case 'seen': ev({ type: 'seen' }); break;
      case 'queue':
        s.queue = { ...s.queue, text: s.queue.text ? `${s.queue.text} ${step[1]}` : step[1] };
        ev({ type: 'queued', text: step[1] });
        snapshot();
        break;
      case 'ready': s.ready = true; snapshot(); break;
      case 'queueFails': s.queue = { ...s.queue, error: step[1] }; snapshot(); break;
      case 'retry': ev({ type: 'retry' }); s.queue = { ...s.queue, error: null }; snapshot(); break;
      case 'queueGoes': s.queue = { text: null, error: null }; snapshot(); break;
      case 'turnStart': s.chat = applyEvent(s.chat, { type: 'turn-start', text: step[1] }); break;
      case 'reply': s.chat = applyEvent(s.chat, { type: 'assistant', message: { id: `m${s.chat.seq}`, content: [{ type: 'text', text: step[1] }] } }); break;
      case 'turnEnd': s.chat = applyEvent(s.chat, { type: 'turn-end' }); break;
      case 'stop': s.chat = applyEvent(applyEvent(s.chat, { type: 'user-stop' }), { type: 'turn-end' }); break;
      case 'runnerError': s.chat = applyEvent(s.chat, { type: 'runner-error', message: step[1] }); break;
      case 'dismiss': ev({ type: 'dismiss' }); break;
      case 'session': cur = step[1]; if (!sessions.has(cur)) sessions.set(cur, fresh()); break;
    }
    seen.push(`${step.join(' ')} → ${describeStrip(stripState(get().strip, get().chat))}`);
    expect(seen[seen.length - 1]).toBe(`${step.join(' ')} → ${expected}`);
  }
}

describe('the file strip, step by step', () => {
  it('follows one message: sending, behind the turn, working, the reply, done', () => run([
    [['send', 'A'], 'sending'],
    [['sendOk'], 'queued box ×1'],
    [['turnStart', 'A'], 'working'],
    [['reply', 'on it'], 'working: on it'],
    [['reply', 'marked ready'], 'working: marked ready'],
    [['turnEnd'], 'done: marked ready'],
  ]));

  it('a direct send that fails puts the strip back as it was (the text is back in the box)', () => run([
    [['send', 'A'], 'sending'],
    [['sendFails'], 'hidden'],
    [['send', 'A'], 'sending'],
    [['sendOk'], 'queued box ×1'],
    [['turnStart', 'A'], 'working'],
    [['turnEnd'], 'done'],
    [['send', 'B'], 'sending'],
    [['sendFails'], 'done'],
  ]));

  it('sweep 11: a queued message that fails shows the error and Retry; Retry queues it again, once', () => run([
    [['queue', 'A'], 'queued browser ×1'],
    [['ready'], 'queued browser ×1'],
    [['queueFails', 'offline'], 'failed ×1: offline [Retry]'],
    [['retry'], 'queued browser ×1'],
    [['retry'], 'queued browser ×1'],
    [['queueGoes'], 'queued box ×1'],
    [['turnStart', 'A'], 'working'],
    [['reply', 'done it'], 'working: done it'],
    [['turnEnd'], 'done: done it'],
  ]));

  it('sweep 15: a later message that goes out takes the strip from an older failure, for good', () => run([
    [['queue', 'A'], 'queued browser ×1'],
    [['ready'], 'queued browser ×1'],
    [['queueFails', 'offline'], 'failed ×1: offline [Retry]'],
    [['send', 'B'], 'sending'],
    [['sendOk'], 'queued box ×1'],
    [['turnStart', 'B'], 'working'],
    [['queueFails', 'offline again'], 'working'],
    [['turnEnd'], 'done'],
    [['retry'], 'done'],
  ]));

  it('sweep 17: Dismiss after a later send took the strip never brings the older failure back', () => run([
    [['queue', 'A'], 'queued browser ×1'],
    [['ready'], 'queued browser ×1'],
    [['queueFails', 'offline'], 'failed ×1: offline [Retry]'],
    [['send', 'B'], 'sending'],
    [['sendOk'], 'queued box ×1'],
    [['dismiss'], 'hidden'],
    [['queueFails', 'offline again'], 'hidden'],
    [['turnStart', 'B'], 'hidden'],
    [['reply', 'merged'], 'hidden'],
    [['turnEnd'], 'hidden'],
    [['send', 'C'], 'sending'],
  ]));

  it('sweep 17: a second message while Claude is not ready joins the queue: counted, failed together, Retry, then one message', () => run([
    [['queue', 'A'], 'queued browser ×1'],
    [['queue', 'B'], 'queued browser ×2'],
    [['ready'], 'queued browser ×2'],
    [['queueFails', 'offline'], 'failed ×2: offline [Retry]'],
    [['retry'], 'queued browser ×2'],
    [['queueGoes'], 'queued box ×1'],
    [['turnStart', 'A B'], 'working'],
    [['reply', 'both done'], 'working: both done'],
    [['turnEnd'], 'done: both done'],
  ]));

  it('a message queued behind a failed one fails with it: the queue holds both until Retry', () => run([
    [['queue', 'A'], 'queued browser ×1'],
    [['ready'], 'queued browser ×1'],
    [['queueFails', 'offline'], 'failed ×1: offline [Retry]'],
    [['queue', 'B'], 'failed ×2: offline [Retry]'],
    [['retry'], 'queued browser ×2'],
    [['queueGoes'], 'queued box ×1'],
  ]));

  it('Dismiss hides until something newer: a new message, or the dismissed one failing', () => run([
    [['queue', 'A'], 'queued browser ×1'],
    [['dismiss'], 'hidden'],
    [['ready'], 'hidden'],
    [['queueFails', 'offline'], 'failed ×1: offline [Retry]'],
    [['dismiss'], 'hidden'],
    [['retry'], 'hidden'],
    [['queueFails', 'offline'], 'hidden'],
    [['send', 'B'], 'sending'],
    [['sendOk'], 'queued box ×1'],
    [['dismiss'], 'hidden'],
    [['turnStart', 'B'], 'hidden'],
    [['turnEnd'], 'hidden'],
  ]));

  it('Dismiss with nothing sent, or twice, changes nothing', () => run([
    [['dismiss'], 'hidden'],
    [['send', 'A'], 'sending'],
    [['dismiss'], 'hidden'],
    [['dismiss'], 'hidden'],
    [['sendOk'], 'hidden'],
  ]));

  it('a turn that is stopped, or whose runner fails, ends the strip so', () => run([
    [['send', 'A'], 'sending'],
    [['sendOk'], 'queued box ×1'],
    [['turnStart', 'A'], 'working'],
    [['stop'], 'stopped'],
    [['send', 'B'], 'sending'],
    [['sendOk'], 'queued box ×1'],
    [['turnStart', 'B'], 'working'],
    [['runnerError', 'The chat runner failed'], 'failed: The chat runner failed'],
  ]));

  it('two messages behind a running turn are counted, and the newest is followed', () => run([
    [['turnStart', 'earlier'], 'hidden'],
    [['send', 'A'], 'sending'],
    [['sendOk'], 'queued box ×1'],
    [['send', 'B'], 'sending'],
    [['sendOk'], 'queued box ×2'],
    [['turnEnd'], 'queued box ×2'],
    [['turnStart', 'A'], 'queued box ×1'],
    [['turnEnd'], 'queued box ×1'],
    [['turnStart', 'B'], 'working'],
    [['reply', 'second'], 'working: second'],
    [['turnEnd'], 'done: second'],
  ]));

  it('the same words sent again follow the new bubble, not the earlier answer', () => run([
    [['send', 'A'], 'sending'],
    [['sendOk'], 'queued box ×1'],
    [['turnStart', 'A'], 'working'],
    [['reply', 'first'], 'working: first'],
    [['turnEnd'], 'done: first'],
    [['send', 'A'], 'sending'],
    [['sendOk'], 'queued box ×1'],
    [['turnStart', 'A'], 'working'],
    [['reply', 'second'], 'working: second'],
    [['turnEnd'], 'done: second'],
  ]));

  it('each session keeps its own strip when the target changes and changes back', () => run([
    [['send', 'A'], 'sending'],
    [['sendOk'], 'queued box ×1'],
    [['turnStart', 'A'], 'working'],
    [['session', 'b'], 'hidden'],
    [['queue', 'B'], 'queued browser ×1'],
    [['session', 'a'], 'working'],
    [['reply', 'done in a'], 'working: done in a'],
    [['session', 'b'], 'queued browser ×1'],
    [['ready'], 'queued browser ×1'],
    [['queueFails', 'offline'], 'failed ×1: offline [Retry]'],
    [['session', 'a'], 'working: done in a'],
    [['dismiss'], 'hidden'],
    [['session', 'b'], 'failed ×1: offline [Retry]'],
  ]));
});

describe('a direct send that fails after its composer was gone (the target changed)', () => {
  it('is a failure of its session, without Retry, its text waiting for that box; a later send takes over', () => {
    let model = EMPTY_STRIP;
    model = reduceStrip(model, { type: 'sending', text: 'A', occurrence: 1 });
    model = reduceStrip(model, { type: 'unsent', away: { error: 'offline', typed: 'A typed', images: 2 } });
    expect(stripState(model, emptyChat)).toEqual({ kind: 'failed', messageId: 1, error: 'offline', count: 1, retry: false, away: { images: 2 } });
    expect(model.restore).toEqual(['A typed']);
    expect(stripStatusText(stripState(model, emptyChat), false)).toBe('not sent: offline · back in the box; attach the 2 images again');
    model = reduceStrip(model, { type: 'restored' });
    expect(model.restore).toEqual([]);
    // Retry does nothing for it: the text is in the box to send again.
    expect(reduceStrip(model, { type: 'retry' })).toBe(model);
    model = reduceStrip(model, { type: 'sending', text: 'B', occurrence: 1 });
    expect(stripState(model, emptyChat).kind).toBe('sending');
  });

  it('step by step, with Dismiss and a second failure while the first still waits', () => run([
    [['send', 'A'], 'sending'],
    [['sendFailsAway', 'offline'], 'failed ×1: offline (back in the box)'],
    [['seen'], 'failed ×1: offline (back in the box)'],
    [['dismiss'], 'hidden'],
    [['send', 'B'], 'sending'],
    [['sendFailsAway', 'still offline'], 'failed ×1: still offline (back in the box)'],
    [['restored'], 'failed ×1: still offline (back in the box)'],
    [['send', 'B'], 'sending'],
    [['sendOk'], 'queued box ×1'],
  ]));

  it('two failures before the box is back on screen both come back into it', () => {
    let model = EMPTY_STRIP;
    model = reduceStrip(model, { type: 'sending', text: 'A', occurrence: 1 });
    model = reduceStrip(model, { type: 'unsent', away: { error: 'offline', typed: 'first', images: 0 } });
    model = reduceStrip(model, { type: 'sending', text: 'B', occurrence: 1 });
    model = reduceStrip(model, { type: 'unsent', away: { error: 'offline', typed: 'second', images: 0 } });
    // Each kept apart, in the order sent: the box adds them once (FileChat).
    expect(model.restore).toEqual(['first', 'second']);
  });
});

describe('the strip\'s words', () => {
  it('says each state', () => {
    expect(stripStatusText({ kind: 'queued', where: 'browser', count: 1 }, false)).toBe('sent as soon as Claude is ready');
    expect(stripStatusText({ kind: 'queued', where: 'browser', count: 2 }, false)).toBe('2 messages · sent as soon as Claude is ready');
    expect(stripStatusText({ kind: 'queued', where: 'box', count: 1 }, false)).toBe('Queued · sent after the current turn');
    expect(stripStatusText({ kind: 'queued', where: 'box', count: 1 }, true)).toBe('Sent · it reads this at its next step');
    expect(stripStatusText({ kind: 'sending' }, false)).toBe('Sending…');
    expect(stripStatusText({ kind: 'working', text: null }, false)).toBe('Working…');
    expect(stripStatusText({ kind: 'done', outcome: 'done', text: 'x' }, false)).toBe('Done');
    expect(stripStatusText({ kind: 'done', outcome: 'stopped', text: null }, false)).toBe('Stopped');
    expect(stripStatusText({ kind: 'failed', messageId: 1, error: 'offline', count: 2, retry: true }, false)).toBe('2 messages · not sent: offline');
  });
});

describe('the one line above the box (fileLine)', () => {
  const ctx = { name: 'orchestrator', status: { tone: 'idle', text: 'Done · your turn' }, running: false, live: false, unsent: 0, away: [] as Array<{ key: string; name: string; error: string }> };
  const line = (s: StripState, over: Partial<typeof ctx> = {}) => fileLine(s, { ...ctx, ...over });

  it('says each strip state in one line, with only the actions that apply', () => {
    expect(line({ kind: 'hidden' })).toMatchObject({ text: 'orchestrator · Done · your turn', tone: 'idle', spinner: false, dismiss: false, retry: false });
    expect(line({ kind: 'hidden' }, { status: { tone: 'working', text: 'Writing…' }, running: true })).toMatchObject({ text: 'orchestrator · Writing…', spinner: true });
    expect(line({ kind: 'sending' })).toMatchObject({ text: 'orchestrator · sending…', spinner: true, dismiss: true });
    expect(line({ kind: 'queued', where: 'browser', count: 2 })).toMatchObject({ text: 'orchestrator · 2 messages · sent as soon as Claude is ready' });
    expect(line({ kind: 'working', text: '# Big heading\n\nlots of text' })).toMatchObject({ text: 'orchestrator · working…', spinner: true });
    expect(line({ kind: 'done', outcome: 'done', text: '**Marked** #761 ready.\n\nMore detail' })).toMatchObject({ text: 'orchestrator replied: Marked #761 ready.', tone: 'idle' });
    expect(line({ kind: 'done', outcome: 'done', text: null })).toMatchObject({ text: 'orchestrator · done' });
    expect(line({ kind: 'done', outcome: 'stopped', text: 'x' })).toMatchObject({ text: 'orchestrator · stopped' });
    expect(line({ kind: 'done', outcome: 'failed', text: 'The chat runner failed' })).toMatchObject({ text: 'orchestrator · failed: The chat runner failed', tone: 'error' });
    expect(line({ kind: 'failed', messageId: 1, error: 'offline', count: 1, retry: true })).toMatchObject({ text: 'orchestrator · not sent: offline', tone: 'error', retry: true });
  });

  it('folds the not-sent messages and another session\'s failure into the same line', () => {
    const l = line({ kind: 'working', text: null }, { unsent: 2, away: [{ key: 'b', name: 'docs', error: 'offline' }, { key: 'c', name: 'ops', error: 'offline' }] });
    expect(l).toMatchObject({ unsent: 2, away: { key: 'b', name: 'docs', error: 'offline' }, awayMore: 1 });
  });

  it('keeps the name and the status apart, so the name can be cut first', () => {
    expect(line({ kind: 'working', text: null })).toMatchObject({ name: 'orchestrator', status: ' · working…', text: 'orchestrator · working…' });
    expect(line({ kind: 'done', outcome: 'done', text: 'Merged.' })).toMatchObject({ name: 'orchestrator', status: ' replied: Merged.' });
  });

  it('quotes a reply\'s first line as plain text', () => {
    expect(replyFirstLine('\n\n## Done\n\nrest')).toBe('Done');
    expect(replyFirstLine('> `npm test` passed')).toBe('npm test passed');
    expect(replyFirstLine('| a | b |\n|---|---|')).toBe('a | b |');
    expect(replyFirstLine('')).toBeNull();
    expect(replyFirstLine(null)).toBeNull();
  });
});

