/**
 * A t3 automation's run: termag
 * keeps *when* (cron and timezone, waking a parked box, the run budget, the
 * pause after failures) and the run is one call to a T3 Code scheduled task's
 * webhook on the box's t3 server, which starts that task's thread there with
 * its own prompt, model and worktree. termag sends no prompt: the task's own
 * runs, and the webhook's body only says which occurrence this is.
 *
 * The webhook's path (`/api/hooks/<hook>/<token>`) is the credential to start
 * that task, so it is sealed in the user's credential store as `t3h-<id>`
 * (services/credentialStore.ts), never in the automations table. The box's
 * t3 server answers only on the box's loopback, so the call goes through the
 * box agent's tunnel, as the desktop's relay does (routes/cliT3.ts).
 */
import http from 'http';
import { deleteCredentials, getCredentialStoreConfig, readCredential, writeCredentials } from '../credentialStore';
import type { OpenedTunnel } from '../agentTunnels';
import type { CliUser } from '../cliStore';

export const T3_AUTOMATION_KIND = 't3';

// What T3's webhook route answers to (apps/server/src/environmentHttp.ts in
// the fork): its hook id, then a 32-byte base64url token.
const HOOK_PATH = /^\/api\/hooks\/[A-Za-z0-9_.:%-]{1,200}\/[A-Za-z0-9_-]{20,200}$/;
const TASK_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

export interface T3Fields {
  taskId: string;
  hookPath: string;
}

/** `t3: { taskId, hookPath }` from a create or update body. */
export function parseT3Fields(raw: unknown): { ok: true; value: T3Fields } | { ok: false; error: string } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof r.taskId !== 'string' || !TASK_ID.test(r.taskId)) return { ok: false, error: 't3.taskId must be the T3 scheduled task\'s id' };
  if (typeof r.hookPath !== 'string' || !HOOK_PATH.test(r.hookPath)) {
    return { ok: false, error: 't3.hookPath must be the task\'s webhook path, /api/hooks/<hook>/<token>' };
  }
  return { ok: true, value: { taskId: r.taskId, hookPath: r.hookPath } };
}

/** The credential row a t3 automation's webhook is sealed in. */
export function t3HookProvider(automationId: string): string {
  if (!/^[a-z0-9]{8,27}$/.test(automationId)) throw new Error('invalid automation id for a T3 webhook');
  return `t3h-${automationId}`;
}

export class T3HookStoreUnavailable extends Error {}

const STORE_OFF = "This termag has no credential store, so it cannot keep a T3 task's webhook";

/** Whether this termag can keep (and read) a T3 task's webhook: it has a credential store. */
export function t3HookStoreReady(): boolean {
  return getCredentialStoreConfig() !== null;
}

/** Seals the webhook's path for the automation; throws T3HookStoreUnavailable with no credential store. */
export async function saveT3Hook(userId: string, automationId: string, hookPath: string): Promise<void> {
  const cfg = getCredentialStoreConfig();
  if (!cfg) throw new T3HookStoreUnavailable(STORE_OFF);
  await writeCredentials(cfg, userId, { [t3HookProvider(automationId)]: { value: { path: hookPath }, label: 'T3 scheduled task webhook' } });
}

export async function readT3Hook(userId: string, automationId: string): Promise<string | null> {
  const cfg = getCredentialStoreConfig();
  if (!cfg) return null;
  const value = await readCredential(cfg, userId, t3HookProvider(automationId)) as { path?: unknown } | null;
  return typeof value?.path === 'string' && HOOK_PATH.test(value.path) ? value.path : null;
}

export async function forgetT3Hook(userId: string, automationId: string): Promise<void> {
  await deleteCredentials(userId, [t3HookProvider(automationId)]);
}

export type T3HookOutcome =
  | { kind: 'started'; deliveryId: string | null }
  /** The box or its t3 server is still coming up (after a wake, say): try again on the next tick. */
  | { kind: 'wait'; reason: string; error: string }
  /** `pause`: the task is gone or unreachable for good, so later runs would fail the same way. */
  | { kind: 'failed'; reason: string; error: string; pause?: true };

/** What the box's t3 server's answer to the webhook means for the run. */
export function t3HookOutcome(status: number, text: string): T3HookOutcome {
  if (status === 202 || status === 200) {
    let deliveryId: string | null = null;
    try {
      const id = (JSON.parse(text) as { deliveryId?: unknown }).deliveryId;
      deliveryId = typeof id === 'string' ? id : null;
    } catch { /* an empty or non-JSON 202 still started it */ }
    return { kind: 'started', deliveryId };
  }
  if (status === 404 || status === 410) {
    return { kind: 'failed', reason: 't3_task_gone', error: 'The T3 task is gone, or its webhook URL was rotated: save it again from the desktop', pause: true };
  }
  if (status === 409) return { kind: 'failed', reason: 't3_task_disabled', error: 'The T3 task is turned off in T3' };
  if (status === 429) return { kind: 'failed', reason: 't3_busy', error: 'The T3 task had too many requests waiting' };
  return { kind: 'failed', reason: 't3_hook_failed', error: `The box's t3 server answered ${status}` };
}

/** One call to the box's t3 server: the status and body it answered. */
export type T3HookCaller = (owner: CliUser, boxId: string, path: string, body: unknown) => Promise<{ status: number; text: string }>;

let caller: T3HookCaller | null = null;

/** index.ts sets it, over the desktop bridge's tunnels (routes/cliT3Prisma.ts). */
export function setT3HookCaller(next: T3HookCaller | null): void {
  caller = next;
}

/** Fires the automation's T3 task on its box. Never throws. */
export async function fireT3Hook(owner: CliUser, boxId: string, automationId: string, body: unknown): Promise<T3HookOutcome> {
  // A store that's off (an outage, a replica missing its key) is no reason to
  // pause: it fails the run, as a read that fails does, not as a missing hook.
  if (!t3HookStoreReady()) return { kind: 'failed', reason: 't3_store_off', error: STORE_OFF };
  let path: string | null;
  try {
    path = await readT3Hook(owner.id, automationId);
  } catch (err) {
    return { kind: 'failed', reason: 't3_hook_unreadable', error: `termag could not read the task's webhook: ${(err as Error).message}` };
  }
  if (!path) return { kind: 'failed', reason: 't3_hook_missing', error: 'termag has no webhook for this T3 task: save it again from the desktop', pause: true };
  if (!caller) return { kind: 'failed', reason: 'launch', error: 'This termag cannot reach t3 servers' };
  try {
    const answer = await caller(owner, boxId, path, body);
    return t3HookOutcome(answer.status, answer.text);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_YET.has(code)) return { kind: 'wait', reason: code, error: (err as Error).message };
    return { kind: 'failed', reason: 'launch', error: (err as Error).message };
  }
}

/**
 * What the desktop bridge answers for a box that is up but not yet serving
 * (routes/cliT3Prisma.ts): its agent not connected yet, or its t3 server still
 * starting, as right after a wake. The desktop retries those; so does a run.
 */
const NOT_YET = new Set(['box_not_ready', 't3_starting', 't3_not_running']);

/** Waits this long for the box's t3 server to answer the webhook. */
const ANSWER_TIMEOUT_MS = 20_000;
/** A webhook's answer is a delivery id; nothing longer is read. */
const MAX_ANSWER_BYTES = 16 * 1024;

/** http.request, so a test can answer without a tunnel. */
export interface Net {
  request: typeof http.request;
}

export interface T3Tunnels {
  /** The desktop bridge's gate: the owner, desktop-app-enabled, a ready box whose agent speaks t3-v1. */
  access(user: CliUser, boxId: string): Promise<{ ok: true } | { ok: false; error: string; code?: string }>;
  openTunnel(user: CliUser, boxId: string): Promise<OpenedTunnel>;
}

/** A T3HookCaller over the box agent's tunnel to its t3 server: a POST of `body` as JSON. */
export function t3HookCallerFor(tunnels: T3Tunnels, net: Net = { request: http.request }): T3HookCaller {
  return async (owner, boxId, path, body) => {
    const access = await tunnels.access(owner, boxId);
    // The code goes with it (fireT3Hook reads box_not_ready as "try again"); a TunnelError from openTunnel carries its own.
    if (!access.ok) throw Object.assign(new Error(access.error), { code: access.code });
    const tunnel = await tunnels.openTunnel(owner, boxId);
    const payload = Buffer.from(JSON.stringify(body ?? {}), 'utf8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { request.destroy(new Error("The box's t3 server did not answer in time")); }, ANSWER_TIMEOUT_MS);
      const done = () => { clearTimeout(timer); tunnel.stream.destroy(); };
      const request = net.request({
        // No `agent`: with one (even `false`) http ignores createConnection.
        createConnection: () => tunnel.stream as unknown as import('net').Socket,
        method: 'POST',
        path,
        headers: {
          host: `127.0.0.1:${tunnel.port ?? 80}`,
          'content-type': 'application/json',
          'content-length': String(payload.length),
          connection: 'close',
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_ANSWER_BYTES) chunks.push(chunk);
        });
        response.on('end', () => { done(); resolve({ status: response.statusCode ?? 502, text: Buffer.concat(chunks).toString('utf8') }); });
        response.on('error', (err) => { done(); reject(err); });
      });
      request.on('error', (err) => { done(); reject(err); });
      request.end(payload);
    });
  };
}
