// On-device dictation: a recogniser with the browser's SpeechRecognition
// shape (chat/dictation.ts drives both the same way) that records the
// microphone, cuts it into phrases at the pauses (chat/localSpeech.ts) and has
// Whisper transcribe each one in a worker (chat/whisperWorker.ts). For the
// browsers whose own recogniser can't work: Arc, Brave and other Chromium
// forks (no speech service key), and Firefox (no recogniser). The audio never
// leaves the device.
import type { SpeechRecognitionCtor, SpeechRecognitionLike, SpeechResultLike } from './dictation';
import { cleanTranscript, resample, SpeechSegmenter, WHISPER_RATE, whisperLanguage } from './localSpeech';
import type { WhisperReply, WhisperRequest } from './whisperWorker';

/**
 * Interim text for the phrase being spoken, at most this often, and only
 * while a transcription takes less than this: on a slow machine (WASM on an
 * old CPU) interim passes would hold up the phrases already finished.
 */
const INTERIM_MS = 1200;

// The worker and its model are shared by every composer in the page, and
// loaded on the first dictation rather than with the page.
let worker: Worker | null = null;
let loading: Promise<void> | null = null;
let nextId = 1;
const pending = new Map<number, { resolve(text: string): void; reject(err: Error): void }>();
const progressListeners = new Set<(fraction: number) => void>();

function whisper(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<WhisperReply>) => {
    const m = e.data;
    if (m.type === 'progress') {
      for (const l of progressListeners) l(m.total > 0 ? m.loaded / m.total : 0);
    } else if (m.type === 'text' || m.type === 'failed') {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.type === 'text') p?.resolve(m.text);
      else p?.reject(new Error(m.message));
    }
  };
  // A worker that dies (out of memory, say) fails what it was doing; the next dictation starts a new one.
  worker.onerror = () => {
    for (const p of pending.values()) p.reject(new Error('speech worker failed'));
    pending.clear();
    worker?.terminate();
    worker = null;
    loading = null;
  };
  return worker;
}

function post(m: WhisperRequest, transfer: Transferable[] = []) {
  whisper().postMessage(m, transfer);
}

function loadModel(onProgress: (fraction: number) => void): Promise<void> {
  progressListeners.add(onProgress);
  if (!loading) {
    loading = new Promise<void>((resolve, reject) => {
      const w = whisper();
      const onMessage = (e: MessageEvent<WhisperReply>) => {
        if (e.data.type === 'ready') { w.removeEventListener('message', onMessage); resolve(); }
        if (e.data.type === 'load-failed') { w.removeEventListener('message', onMessage); reject(new Error(e.data.message)); }
      };
      w.addEventListener('message', onMessage);
      w.addEventListener('error', () => reject(new Error('speech worker failed')), { once: true });
      post({ type: 'load' });
    });
    // A failed load (offline, say) is tried again on the next dictation.
    loading.catch(() => { loading = null; });
  }
  return loading.finally(() => progressListeners.delete(onProgress));
}

function transcribe(audio: Float32Array, language: string | null): Promise<string> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ type: 'transcribe', id, audio, language }, [audio.buffer]);
  });
}

// Hands the microphone's samples to the page, 128 at a time.
const CAPTURE_WORKLET = `
registerProcessor('termag-capture', class extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
});`;
let workletUrl: string | null = null;

function result(transcript: string, isFinal: boolean): SpeechResultLike {
  return Object.assign([{ transcript }], { isFinal });
}

interface Job { audio: Float32Array; phrase: number; final: boolean }

export class LocalRecognition implements SpeechRecognitionLike {
  lang = '';
  continuous = true;
  interimResults = true;
  maxAlternatives = 1;
  onstart: SpeechRecognitionLike['onstart'] = null;
  onresult: SpeechRecognitionLike['onresult'] = null;
  onerror: SpeechRecognitionLike['onerror'] = null;
  onend: SpeechRecognitionLike['onend'] = null;
  onprogress: SpeechRecognitionLike['onprogress'] = null;

  private stream: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private segmenter: SpeechSegmenter | null = null;
  private rate = WHISPER_RATE;
  private ready = false;
  private busy = false;
  private queue: Job[] = [];
  private finals: string[] = [];
  private interim: { phrase: number; text: string } | null = null;
  private lastInterim = 0;
  /** How long the last transcription took. */
  private lastRunMs = 0;
  private stopping = false;
  private ended = false;

  start(): void {
    // Made here, in the click that started dictation: Safari and Firefox leave
    // an AudioContext made later (after the permission prompt) suspended.
    try {
      this.audio = new AudioContext();
    } catch {
      this.fail('audio-capture');
      return;
    }
    loadModel(f => { if (!this.ended) this.onprogress?.(f); }).then(
      () => {
        if (this.ended) return;
        this.ready = true;
        this.onprogress?.(null);
        this.pump();
      },
      (err: unknown) => {
        console.warn('dictation: speech model failed to load', err);
        this.fail('model-unavailable');
      },
    );
    this.capture().catch((e: unknown) => {
      const name = (e as { name?: string })?.name;
      this.fail(name === 'NotAllowedError' || name === 'SecurityError' ? 'not-allowed' : 'audio-capture');
    });
  }

  stop(): void {
    if (this.ended || this.stopping) return;
    this.stopping = true;
    // An interim pass still waiting would only be thrown away.
    this.queue = this.queue.filter(j => j.final);
    const seg = this.segmenter;
    const tail = seg?.flush();
    if (seg && tail) this.enqueue(tail, seg.phrase - 1);
    this.release();
    this.interim = null;
    this.pump();
    this.maybeEnd();
  }

  abort(): void {
    if (this.ended) return;
    this.queue = [];
    this.release();
    this.end();
  }

  private async capture(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const audio = this.audio;
    if (!audio || this.ended || this.stopping) { stream.getTracks().forEach(t => t.stop()); return; }
    this.stream = stream;
    // Still suspended when the device engine took over from the browser's
    // outside a click; the click's activation lets it resume.
    if (audio.state === 'suspended') await audio.resume();
    if (this.audio !== audio) return;
    workletUrl ??= URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'text/javascript' }));
    await audio.audioWorklet.addModule(workletUrl);
    if (this.audio !== audio) return;
    this.rate = audio.sampleRate;
    this.segmenter = new SpeechSegmenter({ sampleRate: audio.sampleRate, silenceMs: 800 });
    const node = new AudioWorkletNode(audio, 'termag-capture');
    node.port.onmessage = (e: MessageEvent<Float32Array>) => this.hear(e.data);
    // Through a muted gain to the output, so the browser keeps pulling audio through the node.
    const mute = audio.createGain();
    mute.gain.value = 0;
    audio.createMediaStreamSource(stream).connect(node).connect(mute).connect(audio.destination);
    this.onstart?.();
  }

  private hear(samples: Float32Array) {
    const seg = this.segmenter;
    if (!seg || this.ended || this.stopping) return;
    // Each phrase push ends has the number before the segmenter's current one.
    for (const phrase of seg.push(samples)) this.enqueue(phrase, seg.phrase - 1);
    const now = Date.now();
    if (seg.speaking && now - this.lastInterim >= INTERIM_MS && this.lastRunMs < INTERIM_MS
      && this.ready && !this.busy && this.queue.length === 0) {
      const heard = seg.current();
      if (heard) {
        this.lastInterim = now;
        this.queue.push({ audio: resample(heard, this.rate, WHISPER_RATE), phrase: seg.phrase, final: false });
      }
    }
    this.pump();
  }

  private enqueue(audio: Float32Array, phrase: number) {
    this.queue.push({ audio: resample(audio, this.rate, WHISPER_RATE), phrase, final: true });
  }

  private pump() {
    if (!this.ready || this.busy || this.ended) return;
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    const started = Date.now();
    transcribe(job.audio, whisperLanguage(this.lang)).then(
      raw => {
        this.busy = false;
        this.lastRunMs = Date.now() - started;
        if (this.ended) return;
        const text = cleanTranscript(raw);
        if (job.final) {
          if (text) this.finals.push(text);
          if (this.interim && this.interim.phrase <= job.phrase) this.interim = null;
        } else if (!this.stopping && job.phrase === this.segmenter?.phrase) {
          // Only for the phrase still being spoken; one that ended since gets its own final.
          this.interim = text ? { phrase: job.phrase, text } : null;
        }
        this.emit();
        this.pump();
        this.maybeEnd();
      },
      (err: unknown) => {
        this.busy = false;
        console.warn('dictation: transcription failed', err);
        this.fail('transcribe-failed');
      },
    );
  }

  private emit() {
    const results = this.finals.map(t => result(t, true));
    if (this.interim) results.push(result(this.interim.text, false));
    this.onresult?.({ results });
  }

  private maybeEnd() {
    // Phrases still queued wait for the model; a model that fails to load ends it through fail().
    if (this.stopping && !this.busy && this.queue.length === 0) this.end();
  }

  private fail(code: string) {
    if (this.ended) return;
    this.release();
    this.onerror?.({ error: code });
    this.end();
  }

  private release() {
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    void this.audio?.close().catch(() => {});
    this.audio = null;
    this.segmenter = null;
  }

  private end() {
    if (this.ended) return;
    this.ended = true;
    this.onend?.();
  }
}

type CaptureWindow = {
  AudioContext?: unknown;
  AudioWorkletNode?: unknown;
  Worker?: unknown;
  WebAssembly?: unknown;
  navigator?: { mediaDevices?: { getUserMedia?: unknown } };
};

/** The on-device recogniser, or null where this browser lacks what it needs. */
export function localRecognitionCtor(win: CaptureWindow | null | undefined): SpeechRecognitionCtor | null {
  if (!win) return null;
  const ok = typeof win.AudioContext === 'function' && typeof win.AudioWorkletNode === 'function'
    && typeof win.Worker === 'function' && typeof win.WebAssembly === 'object'
    && typeof win.navigator?.mediaDevices?.getUserMedia === 'function';
  return ok ? LocalRecognition : null;
}
