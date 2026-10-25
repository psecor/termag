import { describe, expect, it } from 'vitest';
import {
  Dictation, dictationEngine, dictationErrorText, dictationShortcutLabel, engineMemory, isBlockedError, isDictationShortcut,
  joinDictation, speechRecognitionCtor, transcriptOf, withDeviceFallback, type DictationState, type EngineMemory,
  type SpeechRecognitionCtor, type SpeechRecognitionLike, type SpeechResultListLike,
} from './dictation';

function results(...rs: Array<[string, boolean]>): SpeechResultListLike {
  return rs.map(([t, isFinal]) => Object.assign([{ transcript: t }], { isFinal }));
}

class FakeRecognition implements SpeechRecognitionLike {
  static last: FakeRecognition | null = null;
  static throwOnStart = false;
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: SpeechRecognitionLike['onstart'] = null;
  onresult: SpeechRecognitionLike['onresult'] = null;
  onerror: SpeechRecognitionLike['onerror'] = null;
  onend: SpeechRecognitionLike['onend'] = null;
  calls: string[] = [];
  constructor() { FakeRecognition.last = this; }
  start() { this.calls.push('start'); if (FakeRecognition.throwOnStart) throw new Error('InvalidStateError'); }
  stop() { this.calls.push('stop'); }
  abort() { this.calls.push('abort'); }
}

function setup() {
  const texts: string[] = [];
  const states: DictationState[] = [];
  const errors: string[] = [];
  const d = new Dictation(FakeRecognition, 'en-GB', {
    onText: t => texts.push(t), onState: s => states.push(s), onError: c => errors.push(c),
  });
  return { d, texts, states, errors, rec: () => FakeRecognition.last! };
}

describe('speechRecognitionCtor', () => {
  const Ctor = function () {} as unknown;
  it('takes the standard or the webkit-prefixed recogniser', () => {
    expect(speechRecognitionCtor({ isSecureContext: true, SpeechRecognition: Ctor })).toBe(Ctor);
    expect(speechRecognitionCtor({ isSecureContext: true, webkitSpeechRecognition: Ctor })).toBe(Ctor);
  });
  it('is null without one (Firefox), off a secure context, or without a window', () => {
    expect(speechRecognitionCtor({ isSecureContext: true })).toBeNull();
    expect(speechRecognitionCtor({ isSecureContext: false, webkitSpeechRecognition: Ctor })).toBeNull();
    expect(speechRecognitionCtor({ isSecureContext: true, webkitSpeechRecognition: {} })).toBeNull();
    expect(speechRecognitionCtor(null)).toBeNull();
  });
});

describe('transcriptOf', () => {
  it('splits finished phrases from the one still being heard, trimming the gaps', () => {
    expect(transcriptOf(results(['fix the', true], [' failing test', true], [' in sdk', false]))).toEqual({
      final: 'fix the failing test', interim: 'in sdk',
    });
  });
  it('skips empty results', () => {
    expect(transcriptOf(results(['  ', true], ['', false]))).toEqual({ final: '', interim: '' });
  });
});

describe('joinDictation', () => {
  it('appends after a space, or keeps a newline the person typed', () => {
    expect(joinDictation('', 'hello')).toBe('hello');
    expect(joinDictation('Look at', ' main.ts ')).toBe('Look at main.ts');
    expect(joinDictation('Look at  ', 'main.ts')).toBe('Look at main.ts');
    expect(joinDictation('First line\n', 'second')).toBe('First line\nsecond');
  });
  it('leaves the text alone when nothing was said', () => {
    expect(joinDictation('typed ', '  ')).toBe('typed ');
  });
});

describe('errors', () => {
  it('says nothing for an abort, and something for the rest', () => {
    expect(dictationErrorText('aborted')).toBeNull();
    for (const code of ['not-allowed', 'service-not-allowed', 'audio-capture', 'no-speech', 'network', 'language-not-supported', 'model-unavailable', 'transcribe-failed', 'weird']) {
      expect(dictationErrorText(code), code).toBeTruthy();
    }
    expect(dictationErrorText('not-allowed')).toMatch(/blocked/i);
  });
  it('treats a refused microphone or service as blocked, not a passing failure', () => {
    expect(isBlockedError('not-allowed')).toBe(true);
    expect(isBlockedError('service-not-allowed')).toBe(true);
    expect(isBlockedError('no-speech')).toBe(false);
  });
});

describe('the shortcut', () => {
  const k = { key: ' ', code: 'Space', ctrlKey: false, metaKey: false, shiftKey: true, altKey: false };
  it('is Ctrl or ⌘ with Shift and Space', () => {
    expect(isDictationShortcut({ ...k, ctrlKey: true })).toBe(true);
    expect(isDictationShortcut({ ...k, metaKey: true })).toBe(true);
  });
  it('is not plain Shift+Space, Ctrl+Space or with Alt', () => {
    expect(isDictationShortcut(k)).toBe(false);
    expect(isDictationShortcut({ ...k, ctrlKey: true, shiftKey: false })).toBe(false);
    expect(isDictationShortcut({ ...k, ctrlKey: true, altKey: true })).toBe(false);
    expect(isDictationShortcut({ ...k, ctrlKey: true, key: 'a', code: 'KeyA' })).toBe(false);
  });
  it('is labelled for the platform', () => {
    expect(dictationShortcutLabel('MacIntel')).toBe('⌘⇧Space');
    expect(dictationShortcutLabel('Linux x86_64')).toBe('Ctrl+Shift+Space');
    expect(dictationShortcutLabel(undefined)).toBe('Ctrl+Shift+Space');
  });
});

describe('Dictation', () => {
  it('listens continuously with interim results in the given language', () => {
    const { d, states, rec } = setup();
    d.start('');
    expect(rec()).toMatchObject({ lang: 'en-GB', continuous: true, interimResults: true, calls: ['start'] });
    expect(states).toEqual(['starting']);
    rec().onstart?.();
    expect(d.state).toBe('listening');
  });

  it('appends what is said, interim words included, to the text it started from', () => {
    const { d, texts, rec } = setup();
    d.start('Please');
    rec().onresult?.({ results: results(['fix the', false]) });
    rec().onresult?.({ results: results(['fix the build', true], ['now', false]) });
    expect(texts).toEqual(['Please fix the', 'Please fix the build now']);
  });

  it('stop lets the recogniser finish its phrase, then goes idle on end', () => {
    const { d, texts, states, rec } = setup();
    d.start('');
    rec().onstart?.();
    d.stop();
    expect(rec().calls).toEqual(['start', 'stop']);
    expect(d.state).toBe('stopping');
    rec().onresult?.({ results: results(['done', true]) });
    rec().onend?.();
    expect(texts).toEqual(['done']);
    expect(states).toEqual(['starting', 'listening', 'stopping', 'idle']);
  });

  it('cancel puts the text back and ignores anything the recogniser still sends', () => {
    const { d, texts, rec } = setup();
    d.start('typed');
    const r = rec();
    r.onresult?.({ results: results(['spoken', false]) });
    d.cancel();
    expect(r.calls).toContain('abort');
    r.onresult?.({ results: results(['late', true]) });
    r.onend?.();
    expect(texts).toEqual(['typed spoken', 'typed']);
    expect(d.state).toBe('idle');
  });

  it('detach keeps what is shown and stops listening at once', () => {
    const { d, texts, rec } = setup();
    d.start('');
    const r = rec();
    r.onresult?.({ results: results(['send this', false]) });
    d.detach();
    r.onresult?.({ results: results(['send this please', true]) });
    expect(texts).toEqual(['send this']);
    expect(d.state).toBe('idle');
  });

  it('reports errors but not its own aborts, and ends idle', () => {
    const { d, errors, rec } = setup();
    d.start('');
    rec().onerror?.({ error: 'aborted' });
    rec().onerror?.({ error: 'not-allowed' });
    rec().onend?.();
    expect(errors).toEqual(['not-allowed']);
    expect(d.state).toBe('idle');
  });

  it('a second start while one runs is ignored; a start after it ends is a new session', () => {
    const { d, texts, rec } = setup();
    d.start('a');
    const first = rec();
    d.start('b');
    expect(rec()).toBe(first);
    first.onend?.();
    d.start('c');
    expect(rec()).not.toBe(first);
    rec().onresult?.({ results: results(['d', true]) });
    expect(texts).toEqual(['c d']);
  });

  it('a recogniser that refuses to start ends idle with an error', () => {
    FakeRecognition.throwOnStart = true;
    try {
      const { d, errors } = setup();
      d.start('');
      expect(d.state).toBe('idle');
      expect(errors).toEqual(['start-failed']);
    } finally {
      FakeRecognition.throwOnStart = false;
    }
  });
});

/** A recogniser class whose instances are recorded, so a test can drive each one. */
function recorder(): { Ctor: SpeechRecognitionCtor; made: SpeechRecognitionLike[]; calls: string[] } {
  const made: SpeechRecognitionLike[] = [];
  const calls: string[] = [];
  class Rec implements SpeechRecognitionLike {
    lang = ''; continuous = false; interimResults = false; maxAlternatives = 0;
    onstart: SpeechRecognitionLike['onstart'] = null;
    onresult: SpeechRecognitionLike['onresult'] = null;
    onerror: SpeechRecognitionLike['onerror'] = null;
    onend: SpeechRecognitionLike['onend'] = null;
    onprogress: SpeechRecognitionLike['onprogress'] = null;
    constructor() { made.push(this); }
    start() { calls.push('start'); }
    stop() { calls.push('stop'); }
    abort() { calls.push('abort'); }
  }
  return { Ctor: Rec, made, calls };
}

function memory(prefers = false): EngineMemory & { set: boolean } {
  const m = { set: false, prefersDevice: () => prefers || m.set, useDevice: () => { m.set = true; } };
  return m;
}

function session(Ctor: SpeechRecognitionCtor) {
  const texts: string[] = [];
  const errors: string[] = [];
  const states: DictationState[] = [];
  const progress: Array<number | null> = [];
  const d = new Dictation(Ctor, 'en-US', {
    onText: t => texts.push(t), onState: s => states.push(s), onError: c => errors.push(c), onProgress: f => progress.push(f),
  });
  return { d, texts, errors, states, progress };
}

describe('withDeviceFallback', () => {
  it("switches to the device's recogniser when the browser's has no speech service, and remembers", () => {
    const browser = recorder();
    const device = recorder();
    const mem = memory();
    const s = session(withDeviceFallback(browser.Ctor, device.Ctor, mem));
    s.d.start('fix');
    browser.made[0].onstart?.();
    browser.made[0].onerror?.({ error: 'network' });
    browser.made[0].onend?.();
    expect(browser.calls).toEqual(['start', 'abort']);
    expect(device.made).toHaveLength(1);
    expect(device.made[0].lang).toBe('en-US');
    expect(device.made[0].continuous).toBe(true);
    expect(mem.set).toBe(true);
    // The browser's end did not end the session; the device's results arrive in it.
    expect(s.d.state).toBe('listening');
    device.made[0].onprogress?.(0.5);
    device.made[0].onresult?.({ results: results(['the test', true]) });
    expect(s.texts).toEqual(['fix the test']);
    expect(s.progress).toEqual([0.5]);
    expect(s.errors).toEqual([]);
    device.made[0].onend?.();
    expect(s.d.state).toBe('idle');
  });

  it('passes the error through once it has heard something, or for a refused microphone', () => {
    for (const [code, heard] of [['network', true], ['not-allowed', false]] as const) {
      const browser = recorder();
      const device = recorder();
      const s = session(withDeviceFallback(browser.Ctor, device.Ctor, memory()));
      s.d.start('');
      if (heard) browser.made[0].onresult?.({ results: results(['hi', true]) });
      browser.made[0].onerror?.({ error: code });
      expect(device.made).toHaveLength(0);
      expect(s.errors).toEqual([code]);
    }
  });

  it('does not switch after the person stopped', () => {
    const browser = recorder();
    const device = recorder();
    const s = session(withDeviceFallback(browser.Ctor, device.Ctor, memory()));
    s.d.start('');
    s.d.stop();
    browser.made[0].onerror?.({ error: 'network' });
    expect(device.made).toHaveLength(0);
  });

  it("does not fall back from the device's own error", () => {
    const browser = recorder();
    const device = recorder();
    const s = session(withDeviceFallback(browser.Ctor, device.Ctor, memory()));
    s.d.start('');
    browser.made[0].onerror?.({ error: 'network' });
    device.made[0].onerror?.({ error: 'model-unavailable' });
    expect(device.made).toHaveLength(1);
    expect(s.errors).toEqual(['model-unavailable']);
  });

  it('still switches when aborting the failed browser recogniser throws', () => {
    const browser = recorder();
    const device = recorder();
    const s = session(withDeviceFallback(browser.Ctor, device.Ctor, memory()));
    s.d.start('');
    browser.made[0].abort = () => { throw new Error('InvalidStateError'); };
    browser.made[0].onerror?.({ error: 'network' });
    expect(device.made).toHaveLength(1);
    expect(device.calls).toEqual(['start']);
    expect(s.errors).toEqual([]);
  });

  it('starts on the device once it has switched, without trying the browser again', () => {
    const browser = recorder();
    const device = recorder();
    const s = session(withDeviceFallback(browser.Ctor, device.Ctor, memory()));
    s.d.start('');
    browser.made[0].onerror?.({ error: 'network' });
    device.made[0].onend?.();
    s.d.start('');
    expect(browser.made).toHaveLength(1);
    expect(device.made).toHaveLength(2);
    expect(device.calls).toEqual(['start', 'start']);
  });

  it('stop and abort reach the recogniser in use', () => {
    const browser = recorder();
    const device = recorder();
    const s = session(withDeviceFallback(browser.Ctor, device.Ctor, memory()));
    s.d.start('');
    browser.made[0].onerror?.({ error: 'network' });
    s.d.stop();
    expect(device.calls).toEqual(['start', 'stop']);
  });
});

describe('dictationEngine', () => {
  const Browser = recorder().Ctor;
  const Device = recorder().Ctor;
  const secure = { isSecureContext: true, webkitSpeechRecognition: Browser };
  it("uses the browser's with the device's as a fallback", () => {
    const Ctor = dictationEngine(secure, Device, memory())!;
    expect(Ctor).not.toBe(Browser);
    expect(Ctor).not.toBe(Device);
  });
  it("uses the device's where the browser has none, or failed here before", () => {
    expect(dictationEngine({ isSecureContext: true }, Device, memory())).toBe(Device);
    expect(dictationEngine(secure, Device, memory(true))).toBe(Device);
  });
  it("uses the browser's alone where the device can't", () => {
    expect(dictationEngine(secure, null, memory(true))).toBe(Browser);
    expect(dictationEngine({ isSecureContext: true }, null, memory())).toBeNull();
  });
  it('is null off a secure context or without a window', () => {
    expect(dictationEngine({ isSecureContext: false, webkitSpeechRecognition: Browser }, Device, memory())).toBeNull();
    expect(dictationEngine(null, Device, memory())).toBeNull();
  });
});

describe('engineMemory', () => {
  it('keeps the choice in storage, and survives storage that throws', () => {
    const store = new Map<string, string>();
    const m = engineMemory({ getItem: k => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } });
    expect(m.prefersDevice()).toBe(false);
    m.useDevice();
    expect(m.prefersDevice()).toBe(true);
    const broken = engineMemory({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(broken.prefersDevice()).toBe(false);
    expect(() => broken.useDevice()).not.toThrow();
    expect(engineMemory(null).prefersDevice()).toBe(false);
  });
});
