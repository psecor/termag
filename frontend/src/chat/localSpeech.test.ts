import { describe, expect, it } from 'vitest';
import { cleanTranscript, resample, SpeechSegmenter, whisperLanguage } from './localSpeech';

const RATE = 1000; // 30 samples a frame keeps the arrays small
const ms = (n: number) => n * RATE / 1000;

function tone(durationMs: number, level = 0.2): Float32Array {
  return Float32Array.from({ length: ms(durationMs) }, (_, i) => (i % 2 ? level : -level));
}
const silence = (durationMs: number, level = 0.001) => tone(durationMs, level);

describe('resample', () => {
  it('averages each output sample over its span', () => {
    expect(Array.from(resample(Float32Array.from([1, 3, 5, 7, 9, 11]), 3, 1))).toEqual([3, 9]);
  });
  it('returns the input at the same rate', () => {
    const x = Float32Array.from([1, 2]);
    expect(resample(x, 16000, 16000)).toBe(x);
  });
  it('gives 16 kHz from 48 kHz at a third of the length', () => {
    expect(resample(new Float32Array(48000), 48000, 16000).length).toBe(16000);
  });
});

describe('SpeechSegmenter', () => {
  it('ends a phrase after the pause, with a little of the silence before and after', () => {
    const s = new SpeechSegmenter({ sampleRate: RATE, silenceMs: 300, prerollMs: 90 });
    expect(s.push(silence(600))).toEqual([]);
    expect(s.push(tone(600))).toEqual([]);
    expect(s.speaking).toBe(true);
    const done = s.push(silence(400));
    expect(done).toHaveLength(1);
    // 90 ms before + 600 ms of speech + 200 ms of the pause kept, at 1 sample per ms.
    expect(done[0].length).toBe(ms(90 + 600 + 210));
    expect(s.speaking).toBe(false);
    expect(s.phrase).toBe(1);
  });

  it('takes samples in any chunk size', () => {
    const s = new SpeechSegmenter({ sampleRate: RATE, silenceMs: 300 });
    const audio = [silence(300), tone(600), silence(400)];
    const all = new Float32Array(audio.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of audio) { all.set(a, o); o += a.length; }
    const done: Float32Array[] = [];
    for (let i = 0; i < all.length; i += 7) done.push(...s.push(all.slice(i, i + 7)));
    expect(done).toHaveLength(1);
  });

  it('drops a click too short to be speech', () => {
    const s = new SpeechSegmenter({ sampleRate: RATE, silenceMs: 300, minSpeechMs: 150 });
    s.push(silence(300));
    s.push(tone(60));
    expect(s.push(silence(400))).toEqual([]);
    expect(s.phrase).toBe(1);
  });

  it('cuts a long phrase at the limit', () => {
    const s = new SpeechSegmenter({ sampleRate: RATE, maxMs: 900 });
    expect(s.push(tone(1000))).toHaveLength(1);
    expect(s.speaking).toBe(true);
  });

  it('shows the phrase so far, and flush ends it', () => {
    const s = new SpeechSegmenter({ sampleRate: RATE, prerollMs: 0 });
    s.push(tone(300));
    expect(s.current()?.length).toBe(ms(300));
    expect(s.flush()?.length).toBe(ms(300));
    expect(s.current()).toBeNull();
    expect(s.flush()).toBeNull();
  });

  it('follows the room: steady background noise is not speech', () => {
    const s = new SpeechSegmenter({ sampleRate: RATE, silenceMs: 300 });
    s.push(silence(2000, 0.02));
    expect(s.speaking).toBe(false);
    s.push(tone(600, 0.2));
    expect(s.speaking).toBe(true);
  });
});

describe('cleanTranscript', () => {
  it('trims and collapses spaces', () => {
    expect(cleanTranscript('  fix the   failing test ')).toBe('fix the failing test');
  });
  it("drops Whisper's non-speech markers", () => {
    expect(cleanTranscript(' [BLANK_AUDIO]')).toBe('');
    expect(cleanTranscript('(wind blowing)')).toBe('');
    expect(cleanTranscript('')).toBe('');
  });
  it('keeps brackets inside speech', () => {
    expect(cleanTranscript('call foo (the helper)')).toBe('call foo (the helper)');
  });
});

describe('whisperLanguage', () => {
  it('takes the primary subtag', () => {
    expect(whisperLanguage('en-GB')).toBe('en');
    expect(whisperLanguage('PT-br')).toBe('pt');
  });
  it('is null for nothing usable', () => {
    expect(whisperLanguage(undefined)).toBeNull();
    expect(whisperLanguage('')).toBeNull();
    expect(whisperLanguage('x-private')).toBeNull();
  });
});
