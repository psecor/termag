// The pure pieces of on-device dictation (chat/localRecognition.ts): cutting
// microphone audio into spoken phrases at the pauses, resampling them to the
// 16 kHz Whisper takes, and cleaning what it returns. No browser APIs here,
// so they test without one.

/** Whisper's input rate. */
export const WHISPER_RATE = 16000;

/** `input` at `from` Hz as `to` Hz (to ≤ from), averaging each output sample's span. */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    out[i] = b > a ? sum / (b - a) : input[a];
  }
  return out;
}

function concat(chunks: Float32Array[]): Float32Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export interface SegmenterOptions {
  sampleRate: number;
  /** Silence that ends a phrase. */
  silenceMs?: number;
  /** A phrase is cut here even mid-speech (Whisper reads at most 30 s). */
  maxMs?: number;
  /** Less speech than this in a phrase is a cough or a click: dropped. */
  minSpeechMs?: number;
  /** Audio kept from before speech starts, so its first sound is not clipped. */
  prerollMs?: number;
}

const FRAME_MS = 30;
/** The quietest level counted as speech, whatever the room's noise. */
const MIN_SPEECH_RMS = 0.012;

/**
 * Splits a stream of microphone samples into phrases by loudness: a phrase
 * starts when a frame is well above the room's noise floor and ends after
 * `silenceMs` below it. `push` returns the phrases it finished; `current` is
 * the phrase still being spoken (for interim text); `flush` ends it.
 */
export class SpeechSegmenter {
  private readonly frameLen: number;
  private readonly silenceFrames: number;
  private readonly maxFrames: number;
  private readonly minSpeechFrames: number;
  private readonly prerollFrames: number;
  private pending = new Float32Array(0);
  private preroll: Float32Array[] = [];
  private frames: Float32Array[] = [];
  private speechFrames = 0;
  private silentRun = 0;
  private floor = 0;
  private _phrase = 0;

  constructor(opts: SegmenterOptions) {
    const perMs = opts.sampleRate / 1000;
    this.frameLen = Math.max(1, Math.round(FRAME_MS * perMs));
    this.silenceFrames = Math.ceil((opts.silenceMs ?? 700) / FRAME_MS);
    this.maxFrames = Math.floor((opts.maxMs ?? 20000) / FRAME_MS);
    this.minSpeechFrames = Math.ceil((opts.minSpeechMs ?? 150) / FRAME_MS);
    this.prerollFrames = Math.ceil((opts.prerollMs ?? 300) / FRAME_MS);
  }

  /** Counts up each time a phrase ends, so a result for an older phrase can be told apart. */
  get phrase(): number { return this._phrase; }

  get speaking(): boolean { return this.frames.length > 0; }

  push(samples: Float32Array): Float32Array[] {
    const buf = new Float32Array(this.pending.length + samples.length);
    buf.set(this.pending);
    buf.set(samples, this.pending.length);
    const done: Float32Array[] = [];
    let o = 0;
    for (; o + this.frameLen <= buf.length; o += this.frameLen) {
      const phrase = this.frame(buf.slice(o, o + this.frameLen));
      if (phrase) done.push(phrase);
    }
    this.pending = buf.slice(o);
    return done;
  }

  /** The phrase being spoken so far, or null when there is none. */
  current(): Float32Array | null {
    return this.speechFrames >= this.minSpeechFrames ? concat(this.frames) : null;
  }

  /** Ends the phrase being spoken (the person stopped): it, or null. */
  flush(): Float32Array | null {
    return this.speaking ? this.end() : null;
  }

  private frame(f: Float32Array): Float32Array | null {
    let sq = 0;
    for (let i = 0; i < f.length; i++) sq += f[i] * f[i];
    const rms = Math.sqrt(sq / f.length);
    // Start the room's noise floor from the first frame, capped so that
    // speaking the moment the microphone opens still counts as speech.
    if (this.floor === 0) this.floor = Math.min(rms, MIN_SPEECH_RMS) || 1e-6;
    const loud = rms > Math.max(MIN_SPEECH_RMS, this.floor * 3);
    if (!loud) this.floor = this.floor * 0.95 + rms * 0.05;

    if (!this.speaking) {
      if (loud) {
        this.frames = [...this.preroll, f];
        this.preroll = [];
        this.speechFrames = 1;
        this.silentRun = 0;
      } else {
        this.preroll.push(f);
        if (this.preroll.length > this.prerollFrames) this.preroll.shift();
      }
      return null;
    }
    this.frames.push(f);
    if (loud) { this.speechFrames++; this.silentRun = 0; } else this.silentRun++;
    if (this.silentRun >= this.silenceFrames || this.frames.length >= this.maxFrames) return this.end();
    return null;
  }

  private end(): Float32Array | null {
    const enough = this.speechFrames >= this.minSpeechFrames;
    // Keep a little of the trailing silence; Whisper does better with it.
    const keep = this.frames.length - Math.max(0, this.silentRun - Math.ceil(200 / FRAME_MS));
    const audio = enough ? concat(this.frames.slice(0, keep)) : null;
    this.frames = [];
    this.speechFrames = 0;
    this.silentRun = 0;
    this._phrase++;
    return audio;
  }
}

/**
 * What Whisper heard, ready for the prompt box, or '' for nothing: its
 * non-speech markers ("[BLANK_AUDIO]", "(wind blowing)") are dropped.
 */
export function cleanTranscript(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t || /^[[(][^\])]*[\])]$/.test(t)) return '';
  return t;
}

/** The language to ask Whisper for, from a BCP 47 tag ("en-GB" → "en"); null to let it detect. */
export function whisperLanguage(tag: string | undefined): string | null {
  const primary = (tag ?? '').split('-')[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}
