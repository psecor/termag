// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeechRecognitionLike, SpeechResultListLike } from './dictation';

const mocks = vi.hoisted(() => ({ flagOn: true }));
vi.mock('../flags', () => ({
  FLAGS: { chatVoiceInput: 'chat-voice-input-enabled' },
  useFlag: () => mocks.flagOn,
}));

import { useDictation } from './useDictation';
import { DictationButton, DictationNote } from './DictationButton';

class FakeRecognition implements SpeechRecognitionLike {
  static last: FakeRecognition | null = null;
  lang = ''; continuous = false; interimResults = false; maxAlternatives = 0;
  onstart: SpeechRecognitionLike['onstart'] = null;
  onresult: SpeechRecognitionLike['onresult'] = null;
  onerror: SpeechRecognitionLike['onerror'] = null;
  onend: SpeechRecognitionLike['onend'] = null;
  stopped = false; aborted = false;
  constructor() { FakeRecognition.last = this; }
  start() {}
  stop() { this.stopped = true; }
  abort() { this.aborted = true; }
}

function results(...rs: Array<[string, boolean]>): SpeechResultListLike {
  return rs.map(([t, isFinal]) => Object.assign([{ transcript: t }], { isFinal }));
}

function Composer({ initial = '' }: { initial?: string }) {
  const [text, setText] = useState(initial);
  const dictation = useDictation({ text, setText, max: 40 });
  return (
    <form>
      <DictationButton dictation={dictation} />
      <textarea value={text} onChange={e => { dictation.onEdit(); setText(e.target.value); }} onKeyDown={e => { dictation.onKeyDown(e); }} />
      <DictationNote dictation={dictation} />
      <button type="button" className="clear" onClick={() => setText('')}>clear</button>
    </form>
  );
}

// A composer whose renders lag behind dictation: each setText is held until
// the test lets it through, as when the recogniser fires again between React
// committing one value and running that render's effects.
const held: string[] = [];
let release: (() => void) | null = null;
function LaggyComposer() {
  const [text, setTextState] = useState('');
  release = () => { const next = held.shift(); if (next !== undefined) setTextState(next); };
  const dictation = useDictation({ text, setText: t => { held.push(t); }, max: 200 });
  return (
    <form>
      <DictationButton dictation={dictation} />
      <textarea value={text} readOnly />
    </form>
  );
}

let host: HTMLDivElement;
let root: Root;
const w = window as unknown as Record<string, unknown>;

beforeEach(() => {
  mocks.flagOn = true;
  FakeRecognition.last = null;
  w.webkitSpeechRecognition = FakeRecognition;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete w.webkitSpeechRecognition;
});

const render = (el: React.ReactElement) => act(() => root.render(el));
const mic = () => host.querySelector<HTMLButtonElement>('button[aria-pressed]');
const box = () => host.querySelector('textarea')!;
const note = () => host.querySelector('.chat-composer-note')?.textContent ?? null;
const rec = () => FakeRecognition.last!;
const key = (init: KeyboardEventInit) => act(() => { box().dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init })); });

describe('DictationButton', () => {
  it('is not shown with the flag off', () => {
    mocks.flagOn = false;
    render(<Composer />);
    expect(mic()).toBeNull();
  });

  it('is not shown where the browser has no recogniser', () => {
    delete w.webkitSpeechRecognition;
    render(<Composer />);
    expect(mic()).toBeNull();
  });

  it('dictates into the box, interim words and all, with a listening note', () => {
    render(<Composer initial="Please" />);
    expect(mic()!.getAttribute('aria-pressed')).toBe('false');
    act(() => mic()!.click());
    act(() => rec().onstart?.());
    expect(mic()!.getAttribute('aria-pressed')).toBe('true');
    expect(mic()!.getAttribute('aria-label')).toBe('Stop dictating');
    expect(note()).toMatch(/Listening/);
    act(() => rec().onresult?.({ results: results(['run the', true], ['tests', false]) }));
    expect(box().value).toBe('Please run the tests');
  });

  it('cuts dictated text at the composer cap', () => {
    render(<Composer />);
    act(() => mic()!.click());
    act(() => rec().onresult?.({ results: results(['x'.repeat(100), false]) }));
    expect(box().value).toHaveLength(40);
  });

  it('clicking again stops and keeps the text', () => {
    render(<Composer />);
    act(() => mic()!.click());
    act(() => rec().onresult?.({ results: results(['keep me', false]) }));
    act(() => mic()!.click());
    expect(rec().stopped).toBe(true);
    act(() => rec().onend?.());
    expect(box().value).toBe('keep me');
    expect(mic()!.getAttribute('aria-pressed')).toBe('false');
    expect(note()).toBeNull();
  });

  it('Esc discards what was dictated', () => {
    render(<Composer initial="typed" />);
    act(() => mic()!.click());
    act(() => rec().onresult?.({ results: results(['oops', false]) }));
    key({ key: 'Escape' });
    expect(box().value).toBe('typed');
    expect(rec().aborted).toBe(true);
  });

  it('the shortcut toggles dictation from the box', () => {
    render(<Composer />);
    key({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    expect(rec()).not.toBeNull();
    expect(mic()!.getAttribute('aria-pressed')).toBe('true');
    key({ key: ' ', code: 'Space', ctrlKey: true, shiftKey: true });
    expect(rec().stopped).toBe(true);
  });

  it('text the composer sets itself (a send that clears it) stops dictation for good', () => {
    render(<Composer />);
    act(() => mic()!.click());
    const r = rec();
    act(() => r.onresult?.({ results: results(['send this', false]) }));
    act(() => host.querySelector<HTMLButtonElement>('.clear')!.click());
    expect(r.aborted).toBe(true);
    act(() => r.onresult?.({ results: results(['send this now', true]) }));
    expect(box().value).toBe('');
    expect(mic()!.getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps listening through quick interim results that render behind it', () => {
    held.length = 0;
    render(<LaggyComposer />);
    act(() => mic()!.click());
    const r = rec();
    act(() => r.onstart?.());
    act(() => {
      r.onresult?.({ results: results(['fix', false]) });
      r.onresult?.({ results: results(['fix the', false]) });
      r.onresult?.({ results: results(['fix the build', false]) });
    });
    // The box catches up one render at a time, each older than what dictation last wrote.
    act(() => release!());
    expect(box().value).toBe('fix');
    act(() => release!());
    act(() => release!());
    expect(box().value).toBe('fix the build');
    expect(r.aborted).toBe(false);
    expect(mic()!.getAttribute('aria-pressed')).toBe('true');
  });

  it('a refused microphone says so and disables the button', () => {
    render(<Composer />);
    act(() => mic()!.click());
    act(() => { rec().onerror?.({ error: 'not-allowed' }); rec().onend?.(); });
    expect(note()).toMatch(/Microphone blocked/);
    expect(mic()!.disabled).toBe(true);
    expect(mic()!.title).toMatch(/blocked/i);
  });
});
