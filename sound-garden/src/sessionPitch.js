const KEY_POOL = [
  { name: 'C', root: 261.63 },
  { name: 'D', root: 293.66 },
  { name: 'E', root: 329.63 },
  { name: 'F', root: 349.23 },
  { name: 'G', root: 392.00 },
  { name: 'A', root: 440.00 },
  { name: 'Bb', root: 466.16 },
  { name: 'Eb', root: 311.13 },
];

const ROLE_SUFFIXES = ['agent', 'ctrl', 'data'];

export function projectNameFromSession(session) {
  if (!session || typeof session !== 'string') return 'unknown';
  const parts = session.split('-').filter(Boolean);
  if (parts.length <= 2) return session;

  const maybeRole = parts[parts.length - 1];
  const withoutRole = ROLE_SUFFIXES.includes(maybeRole) ? parts.slice(0, -1) : parts;
  if (withoutRole.length <= 1) return withoutRole.join('-') || session;

  return withoutRole.slice(1).join('-') || session;
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function pitchForSession(session) {
  const project = projectNameFromSession(session);
  const key = KEY_POOL[hashString(project) % KEY_POOL.length];
  return {
    project,
    keyName: key.name,
    root: key.root,
    major: [key.root, key.root * 1.2599, key.root * 1.4983],
    minor: [key.root, key.root * 1.1892, key.root * 1.4983],
    suspended: [key.root, key.root * 1.3348, key.root * 1.4983],
  };
}
