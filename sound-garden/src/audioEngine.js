const AudioContextCtor = window.AudioContext || window.webkitAudioContext;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function setGain(gainNode, value, when, ramp = 0.02) {
  gainNode.gain.cancelScheduledValues(when);
  gainNode.gain.setTargetAtTime(value, when, ramp);
}

function oscillatorTone(ctx, destination, frequency, start, duration, options = {}) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = options.type || 'sine';
  osc.frequency.setValueAtTime(frequency, start);

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(options.gain || 0.08, start + (options.attack || 0.018));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  osc.connect(gain);
  gain.connect(destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

function chirpTone(ctx, destination, startFrequency, endFrequency, start, duration, options = {}) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = options.type || 'sine';
  osc.frequency.setValueAtTime(startFrequency, start);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, endFrequency), start + duration);

  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(options.gain || 0.035, start + (options.attack || 0.01));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  osc.connect(gain);
  gain.connect(destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.limiter = null;
    this.volume = 0.45;
    this.enabled = false;
    this.mode = 'ambient';
    this.speedSound = 'engine';
    this.speedTuning = { level: 1, brightness: 1, density: 1 };
    this.voices = new Map();
    this.revVoices = new Map();
    this.noiseBuffer = null;
    this.maxAmbientVoices = 5;
  }

  async enable() {
    if (!AudioContextCtor) throw new Error('Web Audio is not supported in this browser.');
    if (!this.ctx) {
      this.ctx = new AudioContextCtor();
      this.master = this.ctx.createGain();
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -18;
      this.limiter.knee.value = 12;
      this.limiter.ratio.value = 8;
      this.limiter.attack.value = 0.004;
      this.limiter.release.value = 0.18;
      this.master.gain.value = this.volume;
      this.master.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);
    }
    await this.ctx.resume();
    this.enabled = true;
  }

  suspend() {
    this.enabled = false;
    this.stopAllAmbient();
    this.stopAllRevs();
    if (this.ctx) this.ctx.suspend();
  }

  setVolume(value) {
    this.volume = clamp(value, 0, 1);
    if (this.master && this.ctx) {
      setGain(this.master, this.volume, this.ctx.currentTime, 0.05);
    }
  }

  setMode(mode) {
    this.mode = mode;
    if (mode !== 'ambient') {
      this.stopAllAmbient();
      this.stopAllRevs();
    }
  }

  setSpeedSound(kind) {
    const next = ['engine', 'fan', 'whoosh', 'xylophone', 'rain', 'waves', 'birds', 'chimes', 'wind', 'off'].includes(kind) ? kind : 'engine';
    if (next === this.speedSound) return;
    this.speedSound = next;
    this.stopAllRevs();
  }

  setSpeedTuning(tuning = {}) {
    this.speedTuning = {
      level: clamp(Number(tuning.level) || 0, 0, 2),
      brightness: clamp(Number(tuning.brightness) || 0, 0.2, 2.2),
      density: clamp(Number(tuning.density) || 0, 0.25, 2.5),
    };
  }

  playCue(cue, pitch) {
    if (!this.enabled || !this.ctx || this.mode === 'silent') return;
    const now = this.ctx.currentTime;
    const dest = this.master;

    if (cue === 'start') {
      oscillatorTone(this.ctx, dest, pitch.root, now, 0.22, { gain: 0.055 });
      oscillatorTone(this.ctx, dest, pitch.root * 1.2599, now + 0.08, 0.22, { gain: 0.045 });
      oscillatorTone(this.ctx, dest, pitch.root * 1.4983, now + 0.16, 0.28, { gain: 0.04 });
    } else if (cue === 'waiting') {
      oscillatorTone(this.ctx, dest, pitch.root * 1.4983, now, 0.16, { gain: 0.07, type: 'triangle' });
      oscillatorTone(this.ctx, dest, pitch.root * 1.3348, now + 0.13, 0.2, { gain: 0.065, type: 'triangle' });
      oscillatorTone(this.ctx, dest, pitch.root * 1.6818, now + 0.26, 0.24, { gain: 0.055, type: 'triangle' });
    } else if (cue === 'resume') {
      oscillatorTone(this.ctx, dest, pitch.root * 1.1225, now, 0.14, { gain: 0.052 });
      oscillatorTone(this.ctx, dest, pitch.root * 1.4983, now + 0.1, 0.24, { gain: 0.048 });
    } else if (cue === 'done') {
      oscillatorTone(this.ctx, dest, pitch.root * 1.4983, now, 0.18, { gain: 0.05 });
      oscillatorTone(this.ctx, dest, pitch.root * 1.2599, now + 0.12, 0.2, { gain: 0.045 });
      oscillatorTone(this.ctx, dest, pitch.root, now + 0.24, 0.42, { gain: 0.04 });
    }
  }

  updateAmbient(session, status, activityScore, pitch, warpSpeed = 0.1) {
    if (!this.enabled || !this.ctx || this.mode !== 'ambient') return;
    this.updateSpeedRev('global-warp-speed', warpSpeed);

    if (status !== 'working' && status !== 'waiting') {
      if (this.voices.has(session)) this.playAmbientRelease(session, pitch);
      this.stopAmbient(session, 1.5);
      return;
    }

    if (!this.voices.has(session) && this.voices.size >= this.maxAmbientVoices) return;

    let voice = this.voices.get(session);
    if (!voice) {
      voice = this.createAmbientVoice(session);
      this.voices.set(session, voice);
    }

    voice.status = status;
    voice.activity = Math.max(0, Number(activityScore) || 0);
    voice.pitch = pitch;
    setGain(voice.gain, status === 'waiting' ? 0.045 : 0.038, this.ctx.currentTime, 0.18);
  }

  updateWarpSpeed(warpSpeed) {
    if (!this.enabled || !this.ctx || this.mode !== 'ambient') return;
    this.updateSpeedRev('global-warp-speed', warpSpeed);
  }

  createAmbientVoice(session) {
    const gain = this.ctx.createGain();
    gain.gain.value = 0.0001;
    gain.connect(this.master);

    const voice = {
      session,
      gain,
      status: 'working',
      activity: 0,
      pitch: null,
      step: 0,
      timer: null,
    };

    const tick = () => {
      if (!this.enabled || !this.ctx || this.mode !== 'ambient' || !this.voices.has(session)) return;
      if (voice.pitch) this.playAmbientStep(voice);
      const ambientActivity = clamp(voice.activity, 0, 1);
      const base = voice.status === 'waiting' ? 1650 : 1200;
      const interval = base - ambientActivity * 650;
      voice.timer = window.setTimeout(tick, clamp(interval, 420, 2200));
    };

    tick();
    return voice;
  }

  updateSpeedRev(session, speed) {
    if (this.speedSound === 'off') {
      this.stopRev(session, 0.18);
      return;
    }

    const speedC = clamp(Number(speed) || 0, 0, 8);
    const continuousSounds = new Set(['waves', 'wind', 'fan', 'whoosh']);
    if (speedC < 0.03 && !continuousSounds.has(this.speedSound)) {
      this.stopRev(session, 0.18);
      return;
    }

    const now = this.ctx.currentTime;
    const rpm = speedC * 1000;
    const rpmWithAgentLift = rpm;
    const { level, brightness, density } = this.speedTuning;

    if (this.speedSound === 'xylophone') {
      this.updateXylophone(session, speedC);
      return;
    }

    if (['rain', 'birds', 'chimes'].includes(this.speedSound)) {
      this.updateTexture(session, speedC);
      return;
    }

    let voice = this.revVoices.get(session);
    if (!voice || voice.kind !== this.speedSound) {
      this.stopRev(session, 0.08);
      voice = this.createSpeedVoice(this.speedSound, now);
      this.revVoices.set(session, voice);
    }

    if (this.speedSound === 'engine') {
      // Convert RPM to a rough 6-cylinder firing frequency: rpm / 60 * 3.
      voice.revOsc.frequency.setTargetAtTime(Math.max(0.0001, rpmWithAgentLift / 20) * density, now, 0.08);
      voice.revPulse.frequency.setTargetAtTime((2 + rpmWithAgentLift / 95) * density, now, 0.08);
      voice.revFilter.frequency.setTargetAtTime((180 + rpmWithAgentLift * 1.35) * brightness, now, 0.08);
      voice.revGain.gain.setTargetAtTime((0.002 + Math.min(speedC, 4) * 0.008) * level, now, 0.12);
    } else if (this.speedSound === 'fan') {
      voice.revOsc.frequency.setTargetAtTime(Math.max(0.0001, rpmWithAgentLift / 60) * density, now, 0.12);
      voice.revPulse.frequency.setTargetAtTime((4 + rpmWithAgentLift / 42) * density, now, 0.12);
      voice.revFilter.frequency.setTargetAtTime((240 + rpmWithAgentLift * 0.55) * brightness, now, 0.16);
      voice.revGain.gain.setTargetAtTime((0.004 + Math.min(speedC, 4) * 0.006) * level, now, 0.18);
    } else if (this.speedSound === 'whoosh') {
      voice.revOsc.frequency.setTargetAtTime((28 + speedC * 62) * density, now, 0.14);
      voice.revFilter.frequency.setTargetAtTime((440 + speedC * 820) * brightness, now, 0.16);
      voice.revGain.gain.setTargetAtTime((0.005 + Math.min(speedC, 4) * 0.009) * level, now, 0.18);
    } else if (this.speedSound === 'wind') {
      voice.revOsc.frequency.setTargetAtTime((18 + speedC * 28) * density, now, 0.2);
      voice.revFilter.frequency.setTargetAtTime((260 + speedC * 520) * brightness, now, 0.25);
      voice.revGain.gain.setTargetAtTime((0.005 + Math.min(speedC, 4) * 0.007) * level, now, 0.25);
    } else if (this.speedSound === 'waves') {
      voice.revOsc.frequency.setTargetAtTime((0.12 + speedC * 0.08) * density, now, 0.6);
      voice.revFilter.frequency.setTargetAtTime((300 + speedC * 260) * brightness, now, 0.5);
      voice.revGain.gain.setTargetAtTime((0.018 + Math.min(speedC, 4) * 0.018) * level, now, 0.5);
      voice.swellGain.gain.setTargetAtTime((45 + Math.min(speedC, 4) * 28) * brightness * density, now, 0.6);
    }
  }

  createSpeedVoice(kind, now) {
    const revGain = this.ctx.createGain();
    const revFilter = this.ctx.createBiquadFilter();
    const sources = [];
    revGain.gain.value = 0.0001;
    revGain.connect(this.master);

    if (kind === 'engine') {
      const revOsc = this.ctx.createOscillator();
      const revPulse = this.ctx.createOscillator();
      revOsc.type = 'sawtooth';
      revPulse.type = 'square';
      revFilter.type = 'lowpass';
      revFilter.Q.value = 4;
      revOsc.connect(revFilter);
      revPulse.connect(revFilter);
      revFilter.connect(revGain);
      revOsc.start(now);
      revPulse.start(now);
      sources.push(revOsc, revPulse);
      return { kind, revOsc, revPulse, revGain, revFilter, sources };
    }

    if (kind === 'fan') {
      const revOsc = this.ctx.createOscillator();
      const revPulse = this.ctx.createOscillator();
      revOsc.type = 'sine';
      revPulse.type = 'triangle';
      revFilter.type = 'lowpass';
      revFilter.Q.value = 0.8;
      revOsc.connect(revFilter);
      revPulse.connect(revFilter);
      revFilter.connect(revGain);
      revOsc.start(now);
      revPulse.start(now);
      sources.push(revOsc, revPulse);
      return { kind, revOsc, revPulse, revGain, revFilter, sources };
    }

    if (kind === 'waves') {
      const noise = this.ctx.createBufferSource();
      const revOsc = this.ctx.createOscillator();
      const swellGain = this.ctx.createGain();
      const baseGain = this.ctx.createGain();
      noise.buffer = this.getNoiseBuffer();
      noise.loop = true;
      revOsc.type = 'sine';
      revOsc.frequency.value = 0.16;
      swellGain.gain.value = 60;
      baseGain.gain.value = 0.65;
      revFilter.type = 'lowpass';
      revFilter.Q.value = 0.55;
      noise.connect(revFilter);
      revFilter.connect(baseGain);
      baseGain.connect(revGain);
      revOsc.connect(swellGain);
      swellGain.connect(revFilter.frequency);
      revGain.connect(this.master);
      noise.start(now);
      revOsc.start(now);
      sources.push(noise, revOsc);
      return { kind, revOsc, revGain, revFilter, swellGain, sources };
    }

    const noise = this.ctx.createBufferSource();
    const revOsc = this.ctx.createOscillator();
    noise.buffer = this.getNoiseBuffer();
    noise.loop = true;
    revOsc.type = 'sine';
    revFilter.type = kind === 'wind' ? 'lowpass' : 'bandpass';
    revFilter.Q.value = kind === 'wind' ? 0.45 : 0.7;
    noise.connect(revFilter);
    revOsc.connect(revFilter);
    revFilter.connect(revGain);
    noise.start(now);
    revOsc.start(now);
    sources.push(noise, revOsc);
    return { kind, revOsc, revGain, revFilter, sources };
  }

  getNoiseBuffer() {
    if (this.noiseBuffer) return this.noiseBuffer;
    const length = Math.floor(this.ctx.sampleRate * 9);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }

  updateXylophone(session, speedC) {
    let voice = this.revVoices.get(session);
    if (!voice || voice.kind !== 'xylophone') {
      this.stopRev(session, 0.08);
      voice = { kind: 'xylophone', speed: speedC, step: 0, timer: null };
      this.revVoices.set(session, voice);
      this.scheduleXylophone(session);
      return;
    }
    voice.speed = speedC;
  }

  updateTexture(session, speedC) {
    let voice = this.revVoices.get(session);
    if (!voice || voice.kind !== this.speedSound) {
      this.stopRev(session, 0.08);
      voice = { kind: this.speedSound, speed: speedC, step: 0, timer: null };
      this.revVoices.set(session, voice);
      this.scheduleTexture(session);
      return;
    }
    voice.speed = speedC;
  }

  scheduleTexture(session) {
    const voice = this.revVoices.get(session);
    if (!voice || !['rain', 'waves', 'birds', 'chimes'].includes(voice.kind) || !this.enabled || this.mode !== 'ambient') return;

    const speedC = clamp(voice.speed || 0.1, 0.1, 8);
    if (voice.kind === 'rain') {
      this.playRain(speedC);
    } else if (voice.kind === 'birds') {
      this.playBirds(speedC, voice.step);
    } else {
      this.playChime(speedC, voice.step);
    }
    voice.step += 1;

    const density = this.speedTuning.density;
    const intervals = {
      rain: clamp(900 / Math.max(0.45, speedC * density), 90, 1200),
      birds: clamp(2400 / Math.max(0.5, speedC * density), 360, 3200),
      chimes: clamp(1800 / Math.max(0.55, speedC * density), 240, 2600),
    };
    voice.timer = window.setTimeout(() => this.scheduleTexture(session), intervals[voice.kind]);
  }

  playRain(speedC) {
    const { level, brightness, density } = this.speedTuning;
    const drops = 1 + Math.floor(clamp(speedC, 0, 4) * 1.5 * density);
    for (let i = 0; i < drops; i += 1) {
      const start = this.ctx.currentTime + Math.random() * 0.18;
      const source = this.ctx.createBufferSource();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();
      source.buffer = this.getNoiseBuffer();
      filter.type = 'highpass';
      filter.frequency.value = (1200 + Math.random() * 2200) * brightness;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime((0.008 + Math.min(speedC, 3) * 0.002) * level, start + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.055 + Math.random() * 0.04);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      source.start(start);
      source.stop(start + 0.14);
      window.setTimeout(() => {
        try {
          source.disconnect();
          filter.disconnect();
          gain.disconnect();
        } catch { /* ok */ }
      }, 220);
    }
  }

  playBirds(speedC, step) {
    const now = this.ctx.currentTime;
    const { level, brightness } = this.speedTuning;
    const base = (980 + (step % 5) * 90 + Math.random() * 180) * brightness;
    const gain = (0.013 + Math.min(speedC, 3) * 0.003) * level;
    chirpTone(this.ctx, this.master, base, base * (1.38 + Math.random() * 0.25), now, 0.09, { gain, attack: 0.008 });
    chirpTone(this.ctx, this.master, base * 1.22, base * (0.92 + Math.random() * 0.12), now + 0.11, 0.08, { gain: gain * 0.8, attack: 0.006 });
    if (speedC > 1.4) {
      chirpTone(this.ctx, this.master, base * 1.55, base * 1.15, now + 0.22, 0.07, { gain: gain * 0.65, attack: 0.005 });
    }
  }

  playChime(speedC, step) {
    const now = this.ctx.currentTime;
    const { level, brightness } = this.speedTuning;
    const scale = [1, 1.1225, 1.2599, 1.4983, 1.6818, 2];
    const root = 330 * (speedC > 2.5 ? 1.5 : 1) * brightness;
    const frequency = root * scale[step % scale.length];
    oscillatorTone(this.ctx, this.master, frequency, now, 0.72, {
      gain: (0.016 + Math.min(speedC, 3) * 0.002) * level,
      attack: 0.012,
      type: 'sine',
    });
    oscillatorTone(this.ctx, this.master, frequency * 2.01, now + 0.015, 0.48, {
      gain: 0.006 * level,
      attack: 0.014,
      type: 'sine',
    });
  }

  scheduleXylophone(session) {
    const voice = this.revVoices.get(session);
    if (!voice || voice.kind !== 'xylophone' || !this.enabled || this.mode !== 'ambient') return;

    const speedC = clamp(voice.speed || 0.1, 0.1, 8);
    const { level, brightness, density } = this.speedTuning;
    const arpeggio = [1, 1.2599, 1.4983, 2, 1.4983, 1.2599];
    const octave = (speedC > 3.2 ? 1.5 : 1) * brightness;
    const now = this.ctx.currentTime;
    const frequency = 220 * octave * arpeggio[voice.step % arpeggio.length];
    oscillatorTone(this.ctx, this.master, frequency, now, 0.16, {
      gain: (0.014 + Math.min(speedC, 3) * 0.003) * level,
      attack: 0.004,
      type: 'triangle',
    });

    voice.step += 1;
    const interval = clamp(420 / Math.max(0.55, speedC * density), 70, 520);
    voice.timer = window.setTimeout(() => this.scheduleXylophone(session), interval);
  }

  stopRev(session, ramp = 0.1) {
    const voice = this.revVoices.get(session);
    if (!voice || !this.ctx) return;

    if (['xylophone', 'rain', 'birds', 'chimes'].includes(voice.kind)) {
      window.clearTimeout(voice.timer);
      this.revVoices.delete(session);
      return;
    }

    const now = this.ctx.currentTime;
    voice.revGain.gain.cancelScheduledValues(now);
    voice.revGain.gain.setTargetAtTime(0.0001, now, ramp);

    const sources = voice.sources || [voice.revOsc, voice.revPulse].filter(Boolean);
    const revGain = voice.revGain;
    const revFilter = voice.revFilter;
    window.setTimeout(() => {
      try {
        for (const source of sources) {
          source.stop();
          source.disconnect();
        }
        revFilter.disconnect();
        revGain.disconnect();
      } catch {
        // Oscillators may already be stopped during rapid status changes.
      }
    }, ramp * 1000 + 120);

    this.revVoices.delete(session);
  }

  playAmbientStep(voice) {
    const now = this.ctx.currentTime;
    const chord = voice.status === 'waiting' ? voice.pitch.suspended : voice.pitch.major;
    const frequency = chord[voice.step % chord.length];
    const duration = voice.status === 'waiting' ? 0.34 : 0.42;
    const type = voice.status === 'waiting' ? 'triangle' : 'sine';
    oscillatorTone(this.ctx, voice.gain, frequency / 2, now, duration, {
      gain: voice.status === 'waiting' ? 0.42 : 0.36,
      attack: 0.035,
      type,
    });
    voice.step += 1;
  }

  playAmbientRelease(session, pitch) {
    const voice = this.voices.get(session);
    if (!voice || !pitch) return;

    const now = this.ctx.currentTime;
    oscillatorTone(this.ctx, this.master, pitch.root / 2, now, 1.7, {
      gain: 0.026,
      attack: 0.06,
      type: 'sine',
    });
    oscillatorTone(this.ctx, this.master, pitch.root * 0.7492, now + 0.08, 1.45, {
      gain: 0.018,
      attack: 0.08,
      type: 'sine',
    });
  }

  stopAmbient(session, fadeSeconds = 0.8) {
    const voice = this.voices.get(session);
    if (!voice || !this.ctx) return;
    window.clearTimeout(voice.timer);
    setGain(voice.gain, 0.0001, this.ctx.currentTime, Math.max(0.05, fadeSeconds / 4));
    window.setTimeout(() => {
      voice.gain.disconnect();
      this.voices.delete(session);
    }, fadeSeconds * 1000 + 100);
  }

  stopAllAmbient() {
    for (const session of this.voices.keys()) {
      this.stopAmbient(session, 0.3);
    }
  }

  stopAllRevs() {
    for (const session of this.revVoices.keys()) {
      this.stopRev(session, 0.1);
    }
  }
}
