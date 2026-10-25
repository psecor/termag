// Voice dictation into the simple UI's composers (chat-voice-input-enabled),
// on the browser's own Web Speech API where it works: Chrome, Edge and Safari
// recognise the speech (Chrome and Edge on their vendor's servers). Where it
// can't (Arc, Brave and other Chromium forks fail with `network`; Firefox has
// none), Whisper runs on the device instead (chat/localRecognition.ts).
// termag never sees the audio, and what is said is typed into the prompt box
// for the person to review before sending.
//
// The pieces here are pure or take the recognition constructor as an
// argument, so they test without a browser; chat/useDictation.ts wires them
// to React and the composer's text.

/** One alternative of one result, as the browser reports it. */
interface SpeechAlternativeLike { transcript: string }
/** One result: the best alternative at [0], final or still interim. */
export interface SpeechResultLike { readonly isFinal: boolean; readonly length: number; readonly [i: number]: SpeechAlternativeLike }
export interface SpeechResultListLike { readonly length: number; readonly [i: number]: SpeechResultLike }

/** The part of SpeechRecognition dictation uses (lib.dom has no types for it). */
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((e: { results: SpeechResultListLike }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  /** The on-device engine's model download, 0–1, and null once it is loaded. The browser's has none. */
  onprogress?: ((fraction: number | null) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

type SpeechWindow = {
  isSecureContext?: boolean;
  SpeechRecognition?: unknown;
  webkitSpeechRecognition?: unknown;
};

/**
 * The browser's recogniser, or null where dictation cannot work: Firefox (no
 * recogniser), and any page not on HTTPS or localhost (the microphone is
 * only offered to a secure context).
 */
export function speechRecognitionCtor(win: SpeechWindow | null | undefined): SpeechRecognitionCtor | null {
  if (!win || win.isSecureContext === false) return null;
  const ctor = win.SpeechRecognition ?? win.webkitSpeechRecognition;
  return typeof ctor === 'function' ? (ctor as SpeechRecognitionCtor) : null;
}

/** Remembers, per browser, that its own recogniser can't work here. */
export interface EngineMemory {
  prefersDevice(): boolean;
  useDevice(): void;
}

const ENGINE_KEY = 'termag.dictation.engine';

export function engineMemory(storage: Pick<Storage, 'getItem' | 'setItem'> | null | undefined): EngineMemory {
  return {
    prefersDevice: () => { try { return storage?.getItem(ENGINE_KEY) === 'device'; } catch { return false; } },
    useDevice: () => { try { storage?.setItem(ENGINE_KEY, 'device'); } catch { /* private mode */ } },
  };
}

/**
 * The browser recogniser's errors that mean it can't work here but the
 * device's can: no speech service (`network`: Arc, Brave and the other
 * Chromium forks have no key for Google's), Safari with Siri/Dictation off,
 * or a language its service lacks.
 */
const DEVICE_CAN_DO: ReadonlySet<string> = new Set(['network', 'service-not-allowed', 'language-not-supported']);

/**
 * A recogniser that starts the browser's and, when that fails with one of
 * the errors above before hearing anything, switches to the device's in the
 * same session, and remembers to start there next time.
 */
export function withDeviceFallback(Browser: SpeechRecognitionCtor, Device: SpeechRecognitionCtor, memory: EngineMemory): SpeechRecognitionCtor {
  return class implements SpeechRecognitionLike {
    lang = '';
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    onstart: SpeechRecognitionLike['onstart'] = null;
    onresult: SpeechRecognitionLike['onresult'] = null;
    onerror: SpeechRecognitionLike['onerror'] = null;
    onend: SpeechRecognitionLike['onend'] = null;
    onprogress: SpeechRecognitionLike['onprogress'] = null;
    private inner: SpeechRecognitionLike | null = null;
    private heard = false;
    private stopped = false;

    // Checked on every start: the page keeps this class after a switch.
    start() {
      if (memory.prefersDevice()) this.run(new Device(), false);
      else this.run(new Browser(), true);
    }
    stop() { this.stopped = true; this.inner?.stop(); }
    abort() { this.stopped = true; this.inner?.abort(); }

    private run(rec: SpeechRecognitionLike, canSwitch: boolean) {
      rec.lang = this.lang;
      rec.continuous = this.continuous;
      rec.interimResults = this.interimResults;
      rec.maxAlternatives = this.maxAlternatives;
      rec.onstart = () => { if (this.inner === rec) this.onstart?.(); };
      rec.onresult = e => { if (this.inner === rec) { this.heard = true; this.onresult?.(e); } };
      rec.onprogress = f => { if (this.inner === rec) this.onprogress?.(f); };
      rec.onerror = e => {
        if (this.inner !== rec) return;
        if (canSwitch && !this.heard && !this.stopped && DEVICE_CAN_DO.has(e.error)) {
          memory.useDevice();
          // It has usually ended already; abort() then has nothing to do, or throws.
          try { rec.abort(); } catch { /* already idle */ }
          this.run(new Device(), false);
          return;
        }
        this.onerror?.(e);
      };
      rec.onend = () => { if (this.inner === rec) this.onend?.(); };
      this.inner = rec;
      rec.start();
    }
  };
}

/**
 * The recogniser dictation uses here, or null for no button: the browser's,
 * falling back to the device's (`device`, null where the browser lacks what
 * it needs); the device's alone where the browser has none or failed before;
 * nothing off a secure context, where the microphone is not offered.
 */
export function dictationEngine(win: SpeechWindow | null | undefined, device: SpeechRecognitionCtor | null, memory: EngineMemory): SpeechRecognitionCtor | null {
  const browser = speechRecognitionCtor(win);
  if (!win || win.isSecureContext === false) return null;
  if (!device) return browser;
  if (!browser || memory.prefersDevice()) return device;
  return withDeviceFallback(browser, device, memory);
}

/**
 * What has been said so far: the finished phrases, and the phrase still being
 * recognised. Every event carries the whole session's results, so this is
 * rebuilt from all of them rather than appended to.
 */
export function transcriptOf(results: SpeechResultListLike): { final: string; interim: string } {
  const final: string[] = [];
  const interim: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const words = r && r.length > 0 ? r[0].transcript.trim() : '';
    if (words) (r.isFinal ? final : interim).push(words);
  }
  return { final: final.join(' '), interim: interim.join(' ') };
}

/** The composer's text with the spoken words after what was already there. */
export function joinDictation(base: string, spoken: string): string {
  const words = spoken.trim();
  if (!words) return base;
  const head = base.replace(/\s+$/, '');
  if (!head) return words;
  // Keep a newline the person typed before speaking; otherwise a space.
  return /\n\s*$/.test(base) ? `${head}\n${words}` : `${head} ${words}`;
}

/** Why dictation stopped, for the note under the composer. Null for nothing to say. */
export function dictationErrorText(code: string): string | null {
  switch (code) {
    case 'aborted':
      return null;
    case 'not-allowed':
      return 'Microphone blocked. Allow it for this site in the browser, then try again.';
    case 'service-not-allowed':
      return "This browser's speech recognition is turned off (on a Mac: System Settings → Siri / Dictation).";
    case 'audio-capture':
      return 'No microphone found.';
    case 'no-speech':
      return "Didn't hear anything. Try again.";
    case 'network':
      return "Couldn't reach the browser's speech service. Check the connection and try again.";
    case 'language-not-supported':
      return "Dictation doesn't support this browser's language.";
    case 'model-unavailable':
      return "Couldn't load the speech model. Check the connection and try again.";
    case 'transcribe-failed':
      return "The speech model couldn't transcribe that. Try again.";
    default:
      return 'Dictation stopped unexpectedly. Try again.';
  }
}

/** Errors that mean the microphone is refused until the person changes a setting. */
export function isBlockedError(code: string): boolean {
  return code === 'not-allowed' || code === 'service-not-allowed';
}

/** The toggle shortcut: Ctrl+Shift+Space, or ⌘+Shift+Space on a Mac. */
export function isDictationShortcut(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  const space = e.key === ' ' || e.code === 'Space';
  return space && e.shiftKey && !e.altKey && (e.ctrlKey || e.metaKey);
}

export function dictationShortcutLabel(platform: string | undefined): string {
  return /mac|iphone|ipad/i.test(platform ?? '') ? '⌘⇧Space' : 'Ctrl+Shift+Space';
}

export type DictationState = 'idle' | 'starting' | 'listening' | 'stopping';

export interface DictationEvents {
  /** The composer's new text: what was there when dictation started plus what has been said. */
  onText(text: string): void;
  onState(state: DictationState): void;
  /** The session ended on an error (aborted ones excluded). */
  onError(code: string): void;
  /** The on-device model's download, 0–1, or null when there is none to wait for. */
  onProgress?(fraction: number | null): void;
}

/**
 * One dictation session at a time over a recogniser. `start` remembers the
 * composer's text and appends what is said to it; `stop` lets the recogniser
 * finish its last phrase; `cancel` puts the text back as it was; `detach`
 * keeps what is shown and stops listening at once (a send, or the person
 * typing over it).
 */
export class Dictation {
  private rec: SpeechRecognitionLike | null = null;
  private base = '';
  private shown = '';
  private _state: DictationState = 'idle';

  constructor(private readonly Ctor: SpeechRecognitionCtor, private readonly lang: string, private readonly ev: DictationEvents) {}

  get state(): DictationState { return this._state; }

  start(base: string): void {
    if (this.rec) return;
    const rec = new this.Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.base = base;
    this.shown = base;
    rec.onstart = () => { if (this.rec === rec) this.setState('listening'); };
    rec.onresult = e => {
      if (this.rec !== rec) return;
      const { final, interim } = transcriptOf(e.results);
      this.shown = joinDictation(this.base, [final, interim].filter(Boolean).join(' '));
      this.ev.onText(this.shown);
    };
    rec.onerror = e => {
      if (this.rec !== rec) return;
      if (e.error !== 'aborted') this.ev.onError(e.error);
    };
    rec.onend = () => { if (this.rec === rec) this.finish(); };
    rec.onprogress = f => { if (this.rec === rec) this.ev.onProgress?.(f); };
    this.rec = rec;
    this.setState('starting');
    try {
      rec.start();
    } catch {
      // start() throws when the recogniser is already running elsewhere in the page.
      this.finish();
      this.ev.onError('start-failed');
    }
  }

  stop(): void {
    if (!this.rec || this._state === 'stopping') return;
    this.setState('stopping');
    this.rec.stop();
  }

  cancel(): void {
    if (!this.rec) return;
    const base = this.base;
    this.drop();
    this.ev.onText(base);
  }

  detach(): void {
    this.drop();
  }

  private drop(): void {
    const rec = this.rec;
    if (!rec) return;
    this.finish();
    rec.abort();
  }

  private finish(): void {
    this.rec = null;
    this.ev.onProgress?.(null);
    this.setState('idle');
  }

  private setState(s: DictationState): void {
    if (s === this._state) return;
    this._state = s;
    this.ev.onState(s);
  }
}
