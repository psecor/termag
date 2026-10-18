import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { prisma } from '../db';
import { generateToken, hashToken } from '../routes/agentTokens';
import { isProjectAgentConnected } from './agentRegistry';
import { explainHostUnixUsername } from './hostUnixUsername';

// Host accounts on the orchestrator, created on demand.
//
// "This host" projects and MetaTerm live on the orchestrator and run through
// the user's own termag-agent there (the backend runs as the `termag` service
// user and cannot write into anyone's home). That agent used to be installed
// by hand, per user, over a shell on the host. Where cloud-init sets
// HOST_AUTOSETUP=true (the Termag-account orchestrator), the backend instead
// provisions it the first time it's needed: it mints the user's host agent
// token and hands it to one root-owned helper (deploy/termag-host-setup, the
// only thing the backend may sudo), which creates the unix account if needed,
// writes ~/.termag/agent.config.json and starts the user's agent unit.
//
// The token's raw value exists only in this process and in that 0600 file; the
// database keeps its hash like any other agent token.
//
// Host homes live on a data volume that reaches a new orchestrator only after
// the previous one has terminated. Until
// deploy/termag-data-attach has mounted it and written HOST_STORAGE_READY_FILE,
// nothing here mints a token or runs the helper: an account created before the
// mount would land on the root disk, take a UID a home on the volume uses, and
// stay hidden under the volume's /home with a revoked token.

export const HOST_TOKEN_NAME = 'host (orchestrator)';

const HELPER = '/usr/local/sbin/termag-host-setup';
const DEFAULT_CONNECT_HOLD_MS = 30_000;
const CONNECT_POLL_MS = 250;
const HOST_SETUP_RETRY_ERROR = 'Setting up your termag-agent on the orchestrator; try again in a few seconds.';
const HOST_STORAGE_ATTACHING_ERROR = 'Host storage is attaching after a deploy; try again in a few minutes.';
export const HOST_STORAGE_READY_FILE = '/run/termag/host-storage-ready';
const STORAGE_READY_CACHE_MS = 1_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function hostSetupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HOST_AUTOSETUP === 'true';
}

let storageReadyCache: { at: number; ready: boolean } | null = null;

/** Whether the host data volume is mounted on this instance (cached for a second). */
export function hostStorageReady(now: number = Date.now(), exists: (path: string) => boolean = existsSync): boolean {
  if (!storageReadyCache || now - storageReadyCache.at >= STORAGE_READY_CACHE_MS) {
    storageReadyCache = { at: now, ready: exists(HOST_STORAGE_READY_FILE) };
  }
  return storageReadyCache.ready;
}

export interface HostSetupUser {
  id: string;
  unixUsername: string;
}

/** Runs the helper for `unixUsername`, passing the raw token on stdin (never argv). */
export type HostSetupRunner = (unixUsername: string, token: string) => Promise<void>;

export const sudoHelperRunner: HostSetupRunner = (unixUsername, token) =>
  new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', HELPER, unixUsername], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`termag-host-setup exited ${code}: ${stderr.trim().slice(-500)}`));
    });
    child.stdin.end(`${token}\n`);
  });

export interface HostSetupDeps {
  enabled: boolean;
  isConnected: (userId: string) => boolean;
  storageReady: () => boolean;
  run: HostSetupRunner;
  connectHoldMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultDeps = (): HostSetupDeps => ({
  enabled: hostSetupEnabled(),
  isConnected: (userId) => isProjectAgentConnected({ userId, instanceId: null }),
  storageReady: () => hostStorageReady(),
  run: sudoHelperRunner,
  connectHoldMs: DEFAULT_CONNECT_HOLD_MS,
  sleep,
});

export type HostAgentUnavailableResponse =
  | { status: 400; error: string }
  | { status: 503; error: string };

export function hostAgentUnavailableResponse(
  user: HostSetupUser,
  connected: boolean,
  enabled: boolean = hostSetupEnabled(),
  storageReady: boolean = hostStorageReady(),
): HostAgentUnavailableResponse | null {
  if (!enabled || connected) return null;

  const usernameError = explainHostUnixUsername(user.unixUsername);
  if (usernameError) return { status: 400, error: usernameError };
  if (!storageReady) return { status: 503, error: HOST_STORAGE_ATTACHING_ERROR };

  return { status: 503, error: HOST_SETUP_RETRY_ERROR };
}

// One setup per user at a time: a login and a MetaTerm open racing each other
// would otherwise mint two tokens and fight over the config file.
const inFlight = new Map<string, Promise<boolean>>();

/**
 * Make sure `user` has a host agent. Resolves true when one is connected or was
 * just installed, false when disabled or when setup failed (logged, never
 * thrown: callers fire this from login and must not break it).
 */
export function ensureHostSetup(user: HostSetupUser, deps: HostSetupDeps = defaultDeps()): Promise<boolean> {
  if (!deps.enabled) return Promise.resolve(false);
  if (deps.isConnected(user.id)) {
    inFlight.delete(user.id);
    return Promise.resolve(true);
  }

  const usernameError = explainHostUnixUsername(user.unixUsername);
  if (usernameError) {
    console.warn(`[host-setup] ${user.unixUsername}: ${usernameError}`);
    return Promise.resolve(false);
  }
  if (!deps.storageReady()) return Promise.resolve(false);

  const pending = inFlight.get(user.id);
  if (pending) return pending;

  let attempt: Promise<boolean>;
  attempt = setUp(user, deps).finally(() => {
    if (inFlight.get(user.id) === attempt) inFlight.delete(user.id);
  });
  inFlight.set(user.id, attempt);
  return attempt;
}

async function setUp(user: HostSetupUser, deps: HostSetupDeps): Promise<boolean> {
  const raw = generateToken();
  let tokenId: string | undefined;
  try {
    const token = await prisma.agentToken.create({
      data: {
        userId: user.id,
        name: HOST_TOKEN_NAME,
        tokenHash: hashToken(raw),
        tokenPrefix: raw.substring(0, 13) + '...',
      },
    });
    tokenId = token.id;

    await deps.run(user.unixUsername, raw);
    // Replace, don't accumulate: revoke the previous auto-minted host token,
    // but only now that the helper has written the new one. A refused or
    // failed run leaves the agent that still holds the old token working.
    // Tokens a user created by hand (laptop agents) have other names and are
    // left alone.
    await prisma.agentToken.updateMany({
      where: { userId: user.id, instanceId: null, name: HOST_TOKEN_NAME, revokedAt: null, id: { not: token.id } },
      data: { revokedAt: new Date() },
    });
    const connectHoldMs = deps.connectHoldMs ?? DEFAULT_CONNECT_HOLD_MS;
    const wait = deps.sleep ?? sleep;
    let elapsedMs = 0;
    while (!deps.isConnected(user.id) && elapsedMs < connectHoldMs) {
      const delayMs = Math.min(CONNECT_POLL_MS, connectHoldMs - elapsedMs);
      await wait(delayMs);
      elapsedMs += delayMs;
    }
    return true;
  } catch (err) {
    console.warn(`[host-setup] ${user.unixUsername}: ${(err as Error).message}`);
    if (tokenId) {
      // The helper never installed it, so nothing can use it; don't leave it live.
      await prisma.agentToken
        .update({ where: { id: tokenId }, data: { revokedAt: new Date() } })
        .catch(() => {});
    }
    return false;
  }
}
