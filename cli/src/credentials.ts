import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What `termag login` keeps per orchestrator. The two tokens are the only secrets. */
export interface StoredLogin {
  /** The device token (`tmcli_`), which only ever refreshes the access token. */
  token: string;
  accessToken?: string;
  /** On this machine's clock, from the server's expires-in, so clock skew does not matter. */
  accessTokenExpiresAt?: string;
  deviceName: string;
  email: string;
  unixUsername: string;
  expiresAt: string;
  maxExpiresAt: string;
}

interface CredentialsFile {
  version: 1;
  hosts: Record<string, StoredLogin>;
}

export function credentialsPath(env: NodeJS.ProcessEnv, home: string): string {
  const base = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'termag', 'credentials.json');
}

function readFile(path: string): CredentialsFile {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { return { version: 1, hosts: {} }; }
  try {
    const parsed = JSON.parse(text) as Partial<CredentialsFile>;
    if (parsed && typeof parsed.hosts === 'object' && parsed.hosts) return { version: 1, hosts: parsed.hosts };
  } catch { /* unreadable: treat as empty; the next save rewrites it */ }
  return { version: 1, hosts: {} };
}

function isStoredLogin(v: unknown): v is StoredLogin {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o.token === 'string' && o.token.startsWith('tmcli_') && typeof o.deviceName === 'string';
}

export function loadLogin(path: string, host: string): StoredLogin | null {
  const entry = readFile(path).hosts[host];
  return isStoredLogin(entry) ? entry : null;
}

/** Owner-only file in an owner-only directory, replaced atomically. */
function writeFile(path: string, file: CredentialsFile): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export function saveLogin(path: string, host: string, login: StoredLogin): void {
  const file = readFile(path);
  file.hosts[host] = login;
  writeFile(path, file);
}

export function removeLogin(path: string, host: string): boolean {
  const file = readFile(path);
  if (!(host in file.hosts)) return false;
  delete file.hosts[host];
  writeFile(path, file);
  return true;
}
