/**
 * A t3 automation's run (services/automations/t3Hook.ts): the webhook path a
 * create takes, where it is sealed, what the box's answer means, and the one
 * POST that goes over the tunnel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'stream';
import type http from 'http';
import type { CliUser } from '../cliStore';

const stored = new Map<string, unknown>();
let storeOn = true;
vi.mock('../credentialStore', () => ({
  getCredentialStoreConfig: () => (storeOn ? { kmsKeyArn: 'arn:aws:kms:us-east-1:1:key/x' } : null),
  writeCredentials: async (_cfg: unknown, userId: string, changes: Record<string, { value: unknown } | null>) => {
    for (const [provider, change] of Object.entries(changes)) {
      if (change) stored.set(`${userId}/${provider}`, change.value);
      else stored.delete(`${userId}/${provider}`);
    }
  },
  readCredential: async (_cfg: unknown, userId: string, provider: string) => stored.get(`${userId}/${provider}`) ?? null,
  deleteCredentials: async (userId: string, providers: string[]) => { for (const p of providers) stored.delete(`${userId}/${p}`); },
}));

const {
  fireT3Hook, forgetT3Hook, parseT3Fields, saveT3Hook, setT3HookCaller, t3HookCallerFor, t3HookOutcome, t3HookProvider, t3HookStoreReady, T3HookStoreUnavailable,
} = await import('./t3Hook');

const owner: CliUser = { id: 'u1', googleEmail: 'a@example.com', unixUsername: 'alice', displayName: 'Alice' };
const AUTOMATION = 'cmh0abcdefghijklmnopqrstu';
const PATH = '/api/hooks/scheduled-task:4f1c/' + 'k'.repeat(43);

beforeEach(() => {
  stored.clear();
  storeOn = true;
  setT3HookCaller(null);
});

describe('parseT3Fields', () => {
  it('takes the T3 task id and its webhook path', () => {
    expect(parseT3Fields({ taskId: 'scheduled-task:4f1c', hookPath: PATH })).toEqual({ ok: true, value: { taskId: 'scheduled-task:4f1c', hookPath: PATH } });
  });

  it('refuses anything that is not a T3 webhook path', () => {
    for (const hookPath of ['/api/hooks/x/short', 'https://evil.example/api/hooks/a/' + 'k'.repeat(43), '/api/other/a/' + 'k'.repeat(43), '/api/hooks/a/../' + 'k'.repeat(43)]) {
      expect(parseT3Fields({ taskId: 't', hookPath }).ok, hookPath).toBe(false);
    }
    expect(parseT3Fields({ hookPath: PATH }).ok).toBe(false);
    expect(parseT3Fields(null).ok).toBe(false);
  });
});

describe('where the webhook lives', () => {
  it('is a credential row of its own per automation', () => {
    expect(t3HookProvider(AUTOMATION)).toBe(`t3h-${AUTOMATION}`);
    expect(t3HookProvider(AUTOMATION).length).toBeLessThanOrEqual(32);
    expect(() => t3HookProvider('../x')).toThrow();
  });

  it('is sealed on save, read back to fire, and gone after forget', async () => {
    await saveT3Hook('u1', AUTOMATION, PATH);
    expect(stored.get(`u1/t3h-${AUTOMATION}`)).toEqual({ path: PATH });
    const seen: string[] = [];
    setT3HookCaller(async (_o, _b, path) => { seen.push(path); return { status: 202, text: '{"deliveryId":"d1"}' }; });
    expect(await fireT3Hook(owner, 'box1', AUTOMATION, {})).toEqual({ kind: 'started', deliveryId: 'd1' });
    expect(seen).toEqual([PATH]);
    await forgetT3Hook('u1', AUTOMATION);
    expect(stored.size).toBe(0);
  });

  it('is refused with no credential store, rather than kept in the clear', async () => {
    storeOn = false;
    await expect(saveT3Hook('u1', AUTOMATION, PATH)).rejects.toBeInstanceOf(T3HookStoreUnavailable);
  });
});

describe('t3HookOutcome', () => {
  it('reads 202 as started, with its delivery id when there is one', () => {
    expect(t3HookOutcome(202, '{"deliveryId":"abc"}')).toEqual({ kind: 'started', deliveryId: 'abc' });
    expect(t3HookOutcome(202, '')).toEqual({ kind: 'started', deliveryId: null });
  });

  it('pauses for a task that is gone, and fails the run otherwise', () => {
    expect(t3HookOutcome(404, '')).toMatchObject({ kind: 'failed', reason: 't3_task_gone', pause: true });
    expect(t3HookOutcome(410, '')).toMatchObject({ kind: 'failed', reason: 't3_task_gone', pause: true });
    expect(t3HookOutcome(409, '')).toMatchObject({ kind: 'failed', reason: 't3_task_disabled' });
    expect(t3HookOutcome(429, '')).toMatchObject({ kind: 'failed', reason: 't3_busy' });
    const other = t3HookOutcome(500, '');
    expect(other).toMatchObject({ kind: 'failed', reason: 't3_hook_failed' });
    expect('pause' in other).toBe(false);
  });
});

describe('fireT3Hook', () => {
  it('fails a run, without pausing, when this termag has no credential store', async () => {
    // An outage or a replica missing its key, not a webhook the owner must save again.
    await saveT3Hook('u1', AUTOMATION, PATH);
    storeOn = false;
    expect(t3HookStoreReady()).toBe(false);
    setT3HookCaller(async () => { throw new Error('never called'); });
    const out = await fireT3Hook(owner, 'box1', AUTOMATION, {});
    expect(out).toMatchObject({ kind: 'failed', reason: 't3_store_off' });
    expect('pause' in out).toBe(false);
  });

  it('pauses an automation whose webhook termag no longer has', async () => {
    setT3HookCaller(async () => { throw new Error('never called'); });
    expect(await fireT3Hook(owner, 'box1', AUTOMATION, {})).toMatchObject({ kind: 'failed', reason: 't3_hook_missing', pause: true });
  });

  it('waits, rather than failing, while the box or its t3 server is still coming up', async () => {
    await saveT3Hook('u1', AUTOMATION, PATH);
    for (const code of ['box_not_ready', 't3_starting', 't3_not_running']) {
      setT3HookCaller(async () => { throw Object.assign(new Error('not yet'), { code }); });
      expect(await fireT3Hook(owner, 'box1', AUTOMATION, {}), code).toEqual({ kind: 'wait', reason: code, error: 'not yet' });
    }
  });

  it('passes the bridge\'s refusal code on, so a box not ready yet reads as one', async () => {
    const call = t3HookCallerFor({ access: async () => ({ ok: false, error: "The box isn't ready", code: 'box_not_ready' }), openTunnel: vi.fn() });
    await expect(call(owner, 'box1', PATH, {})).rejects.toMatchObject({ code: 'box_not_ready' });
  });

  it('fails the run when the box cannot be reached, without throwing', async () => {
    await saveT3Hook('u1', AUTOMATION, PATH);
    setT3HookCaller(async () => { throw new Error("The box isn't ready or its agent isn't connected"); });
    expect(await fireT3Hook(owner, 'box1', AUTOMATION, {})).toEqual({ kind: 'failed', reason: 'launch', error: "The box isn't ready or its agent isn't connected" });
  });
});

describe('t3HookCallerFor', () => {
  /** A request recorder standing in for http.request over the tunnel. */
  function fakeNet(status: number, answer: string) {
    const sent: { options: http.RequestOptions; body: string }[] = [];
    const net = {
      request: ((options: http.RequestOptions, onResponse: (r: http.IncomingMessage) => void) => {
        const req = new PassThrough();
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('finish', () => {
          sent.push({ options, body: Buffer.concat(chunks).toString('utf8') });
          const res = new PassThrough() as unknown as http.IncomingMessage;
          (res as { statusCode?: number }).statusCode = status;
          onResponse(res);
          (res as unknown as PassThrough).end(answer);
        });
        return req;
      }) as unknown as typeof http.request,
    };
    return { net, sent };
  }

  it('POSTs the body as JSON to the webhook path on the box\'s t3 server, and closes the tunnel', async () => {
    const stream = new PassThrough();
    const { net, sent } = fakeNet(202, '{"deliveryId":"d9"}');
    const call = t3HookCallerFor({ access: async () => ({ ok: true }), openTunnel: async () => ({ stream, port: 4173 }) }, net);
    expect(await call(owner, 'box1', PATH, { termag: { runId: 'r1' } })).toEqual({ status: 202, text: '{"deliveryId":"d9"}' });
    expect(sent).toHaveLength(1);
    expect(sent[0].options).toMatchObject({ method: 'POST', path: PATH, headers: { host: '127.0.0.1:4173', 'content-type': 'application/json' } });
    expect(JSON.parse(sent[0].body)).toEqual({ termag: { runId: 'r1' } });
    expect(stream.destroyed).toBe(true);
  });

  it('opens no tunnel when the desktop bridge refuses the box', async () => {
    const openTunnel = vi.fn();
    const call = t3HookCallerFor({ access: async () => ({ ok: false, error: 'The box is hibernated; start it first' }), openTunnel }, fakeNet(202, '').net);
    await expect(call(owner, 'box1', PATH, {})).rejects.toThrow('The box is hibernated; start it first');
    expect(openTunnel).not.toHaveBeenCalled();
  });
});
