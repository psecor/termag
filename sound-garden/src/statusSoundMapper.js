const VALID_STATUSES = new Set(['working', 'waiting', 'idle', 'not_running']);

export function normalizeStatus(status) {
  return VALID_STATUSES.has(status) ? status : 'not_running';
}

export function cueForTransition(previousStatus, nextStatus) {
  const prev = normalizeStatus(previousStatus);
  const next = normalizeStatus(nextStatus);
  if (prev === next) return null;

  if ((prev === 'idle' || prev === 'not_running') && next === 'working') return 'start';
  if (prev === 'working' && next === 'waiting') return 'waiting';
  if (prev === 'waiting' && next === 'working') return 'resume';
  if ((prev === 'working' || prev === 'waiting') && next === 'idle') return 'done';

  return null;
}

export function shouldAmbientPlay(status, mode) {
  if (mode !== 'ambient') return false;
  return status === 'working' || status === 'waiting';
}

export function formatEvent(session, previousStatus, nextStatus, cue) {
  const from = previousStatus || 'new';
  return `${session}: ${from} -> ${nextStatus}${cue ? ` (${cue})` : ''}`;
}
