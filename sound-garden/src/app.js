import { AudioEngine } from './audioEngine.js';
import { cueForTransition, formatEvent, normalizeStatus, shouldAmbientPlay } from './statusSoundMapper.js';
import { pitchForSession } from './sessionPitch.js';
import { computeWarpSpeed } from './warpSpeed.js';

const els = {
  wsUrl: document.querySelector('#ws-url'),
  connect: document.querySelector('#connect'),
  audioToggle: document.querySelector('#audio-toggle'),
  mode: document.querySelector('#mode'),
  speedSound: document.querySelector('#speed-sound'),
  volume: document.querySelector('#volume'),
  volumeLabel: document.querySelector('#volume-label'),
  tuneLevel: document.querySelector('#tune-level'),
  tuneBrightness: document.querySelector('#tune-brightness'),
  tuneDensity: document.querySelector('#tune-density'),
  tuneLevelLabel: document.querySelector('#tune-level-label'),
  tuneBrightnessLabel: document.querySelector('#tune-brightness-label'),
  tuneDensityLabel: document.querySelector('#tune-density-label'),
  tuneLevelValue: document.querySelector('#tune-level-value'),
  tuneBrightnessValue: document.querySelector('#tune-brightness-value'),
  tuneDensityValue: document.querySelector('#tune-density-value'),
  connectionDot: document.querySelector('#connection-dot'),
  connectionStatus: document.querySelector('#connection-status'),
  audioStatus: document.querySelector('#audio-status'),
  eventCount: document.querySelector('#event-count'),
  sessionCount: document.querySelector('#session-count'),
  sessions: document.querySelector('#sessions'),
  emptyState: document.querySelector('#empty-state'),
  eventLog: document.querySelector('#event-log'),
  clearLog: document.querySelector('#clear-log'),
};

const audio = new AudioEngine();
const sessions = new Map();
let ws = null;
let reconnectTimer = null;
let eventCount = 0;
let manuallyDisconnected = false;
let externalWarpSpeed = null;
let externalWarpUpdatedAt = 0;

const WARP_BROADCAST_CHANNEL = 'termag-warp-speed';
const EXTERNAL_WARP_TTL_MS = 1500;

const TUNING_LABELS = {
  engine: ['Rev level', 'Engine bite', 'Response'],
  fan: ['Fan level', 'Air brightness', 'Spin response'],
  whoosh: ['Whoosh level', 'Brightness', 'Motion response'],
  xylophone: ['Note level', 'Register', 'Tempo'],
  rain: ['Rain level', 'Drop brightness', 'Drop density'],
  waves: ['Surf size', 'Wave brightness', 'Wave frequency'],
  birds: ['Bird level', 'Chirp pitch', 'Chirp density'],
  chimes: ['Chime level', 'Tone brightness', 'Chime density'],
  wind: ['Wind level', 'Air brightness', 'Gust response'],
  off: ['Intensity', 'Brightness', 'Density'],
};

function defaultWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.port && window.location.port !== '3040'
    ? 'localhost:3040'
    : window.location.host || 'localhost:3040';
  return `${protocol}//${host}/termag/ws/status`;
}

function setConnection(status, detail = '') {
  els.connectionDot.className = 'dot';
  if (status === 'connected') els.connectionDot.classList.add('connected');
  if (status === 'error') els.connectionDot.classList.add('error');
  const labels = {
    disconnected: 'Disconnected',
    connecting: 'Connecting',
    connected: 'Connected',
    error: 'Connection error',
  };
  els.connectionStatus.textContent = `${labels[status]}${detail ? `: ${detail}` : ''}`;
}

function setAudioStatus() {
  const state = audio.enabled ? `Audio enabled (${audio.mode})` : 'Audio disabled';
  els.audioStatus.textContent = state;
  els.audioToggle.textContent = audio.enabled ? 'Disable Audio' : 'Enable Audio';
}

function tuningFromControls() {
  return {
    level: Number(els.tuneLevel.value) / 100,
    brightness: Number(els.tuneBrightness.value) / 100,
    density: Number(els.tuneDensity.value) / 100,
  };
}

function updateTuningUi() {
  const labels = TUNING_LABELS[els.speedSound.value] || TUNING_LABELS.off;
  [els.tuneLevelLabel.textContent, els.tuneBrightnessLabel.textContent, els.tuneDensityLabel.textContent] = labels;
  els.tuneLevelValue.textContent = `${els.tuneLevel.value}%`;
  els.tuneBrightnessValue.textContent = `${els.tuneBrightness.value}%`;
  els.tuneDensityValue.textContent = `${els.tuneDensity.value}%`;
}

function applyTuning() {
  updateTuningUi();
  audio.setSpeedTuning(tuningFromControls());
  audio.updateWarpSpeed(currentWarpSpeed());
}

function addLog(text) {
  eventCount += 1;
  els.eventCount.textContent = `${eventCount} event${eventCount === 1 ? '' : 's'}`;

  const item = document.createElement('li');
  const time = new Date().toLocaleTimeString();
  item.innerHTML = `<strong>${time}</strong> ${escapeHtml(text)}`;
  els.eventLog.prepend(item);

  while (els.eventLog.children.length > 80) {
    els.eventLog.lastElementChild.remove();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderSessions() {
  const entries = [...sessions.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  els.sessions.textContent = '';
  els.emptyState.classList.toggle('hidden', entries.length > 0);
  els.sessionCount.textContent = `${entries.length} tracked`;

  for (const [session, data] of entries) {
    const card = document.createElement('article');
    card.className = `session-card ${data.status}`;
    card.innerHTML = `
      <div class="session-name">${escapeHtml(session)}</div>
      <div class="session-meta">
        <span class="pill">${escapeHtml(data.status)}</span>
        <span class="pill">${escapeHtml(data.pitch.keyName)}</span>
        <span class="pill">${Math.round((data.activityScore || 0) * 100)}%</span>
        ${Number.isFinite(data.contextTokens) ? `<span class="pill">${formatTokenCount(data.contextTokens)} ctx</span>` : ''}
        <span class="pill">${escapeHtml(data.pitch.project)}</span>
      </div>
    `;
    els.sessions.append(card);
  }
}

function formatTokenCount(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value));
}

function handleStatusMessage(message) {
  if (!message || message.type !== 'status' || !message.session) return;

  const session = message.session;
  const previous = sessions.get(session);
  const hasStatus = typeof message.status === 'string';
  const contextTokens = Number.isFinite(message.contextTokens) ? message.contextTokens : previous?.contextTokens;

  if (!hasStatus) {
    if (previous) {
      sessions.set(session, { ...previous, contextTokens });
      renderSessions();
    }
    return;
  }

  const nextStatus = normalizeStatus(message.status);
  const pitch = pitchForSession(session);
  const activityScore = Number.isFinite(message.activityScore) ? message.activityScore : 0;
  const cue = previous ? cueForTransition(previous.status, nextStatus) : null;

  sessions.set(session, {
    status: nextStatus,
    updatedAt: message.updatedAt,
    activityScore,
    contextTokens,
    pitch,
  });
  const warpSpeed = currentWarpSpeed();

  if (cue) {
    audio.playCue(cue, pitch);
    addLog(formatEvent(session, previous.status, nextStatus, cue));
  } else if (!previous) {
    addLog(`${session}: observed ${nextStatus}`);
  }

  if (shouldAmbientPlay(nextStatus, audio.mode)) {
    audio.updateAmbient(session, nextStatus, activityScore, pitch, warpSpeed);
  } else {
    audio.updateAmbient(session, nextStatus, activityScore, pitch, warpSpeed);
  }

  renderSessions();
}

function currentWarpSpeed() {
  if (Date.now() - externalWarpUpdatedAt < EXTERNAL_WARP_TTL_MS && Number.isFinite(externalWarpSpeed)) {
    return externalWarpSpeed;
  }
  return computeWarpSpeed(sessions);
}

function setupWarpBroadcastListener() {
  if (!('BroadcastChannel' in window)) return;

  const channel = new BroadcastChannel(WARP_BROADCAST_CHANNEL);
  channel.addEventListener('message', (event) => {
    const value = Number(event.data?.warpSpeed);
    if (!Number.isFinite(value)) return;

    externalWarpSpeed = value;
    externalWarpUpdatedAt = Date.now();
    audio.updateWarpSpeed(value);
  });
}

function connect() {
  manuallyDisconnected = false;
  window.clearTimeout(reconnectTimer);
  if (ws) ws.close();

  const url = els.wsUrl.value.trim();
  if (!url) return;

  setConnection('connecting');
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    setConnection('connected');
    addLog('status websocket connected');
  });

  ws.addEventListener('message', (event) => {
    try {
      handleStatusMessage(JSON.parse(event.data));
    } catch (error) {
      addLog(`ignored invalid websocket message: ${error.message}`);
    }
  });

  ws.addEventListener('close', () => {
    ws = null;
    if (manuallyDisconnected) {
      setConnection('disconnected');
      return;
    }
    setConnection('error', 'reconnecting');
    reconnectTimer = window.setTimeout(connect, 3000);
  });

  ws.addEventListener('error', () => {
    setConnection('error');
  });
}

function disconnect() {
  manuallyDisconnected = true;
  window.clearTimeout(reconnectTimer);
  if (ws) ws.close();
  ws = null;
  setConnection('disconnected');
}

els.connect.addEventListener('click', () => {
  if (ws) {
    disconnect();
    els.connect.textContent = 'Connect';
  } else {
    connect();
    els.connect.textContent = 'Disconnect';
  }
});

els.audioToggle.addEventListener('click', async () => {
  if (audio.enabled) {
    audio.suspend();
  } else {
    try {
      await audio.enable();
    } catch (error) {
      addLog(error.message);
    }
  }
  setAudioStatus();
});

els.mode.addEventListener('change', () => {
  audio.setMode(els.mode.value);
  const warpSpeed = currentWarpSpeed();
  for (const [session, data] of sessions) {
    audio.updateAmbient(session, data.status, data.activityScore, data.pitch, warpSpeed);
  }
  setAudioStatus();
});

els.speedSound.addEventListener('change', () => {
  audio.setSpeedSound(els.speedSound.value);
  updateTuningUi();
  audio.updateWarpSpeed(currentWarpSpeed());
});

[els.tuneLevel, els.tuneBrightness, els.tuneDensity].forEach((input) => {
  input.addEventListener('input', applyTuning);
});

els.volume.addEventListener('input', () => {
  const value = Number(els.volume.value) / 100;
  audio.setVolume(value);
  els.volumeLabel.textContent = `${els.volume.value}%`;
});

els.clearLog.addEventListener('click', () => {
  els.eventLog.textContent = '';
  eventCount = 0;
  els.eventCount.textContent = '0 events';
});

document.querySelectorAll('[data-test-cue]').forEach((button) => {
  button.addEventListener('click', async () => {
    if (!audio.enabled) await audio.enable();
    const pitch = pitchForSession('demo-sound-garden-agent');
    audio.playCue(button.dataset.testCue, pitch);
    setAudioStatus();
  });
});

els.wsUrl.value = defaultWsUrl();
audio.setMode(els.mode.value);
audio.setSpeedSound(els.speedSound.value);
audio.setSpeedTuning(tuningFromControls());
audio.setVolume(Number(els.volume.value) / 100);
setConnection('disconnected');
setAudioStatus();
renderSessions();
updateTuningUi();
setupWarpBroadcastListener();
