import { createECDH, randomBytes } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';
import {
  appBaseUrl, buildChatTurnPayload, plainPreview, buildTestPayload, buildWaitingPayload, isAllowedPushEndpoint, isLiveSubscription,
  parseEndpointBody, parseSubscriptionBody, sendToSubscriptions, sendToUser, vapidConfigFromEnv, vapidSubjectProblem,
  PUSH_TTL_SECONDS, type PushStore, type SendDeps, type StoredSubscription,
} from './webPush';

vi.mock('../db', () => ({ prisma: {} }));

describe('isAllowedPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/fake-registration:not-a-real-fcm-token',
    'https://web.push.apple.com/not-a-real-apns-token',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk-abc_DEF123',
    'https://wns2-par02p.notify.windows.com/w/?token=not%2Breal',
    'https://fcm.googleapis.com:443/fcm/send/abc',
  ])('allows a real push-service endpoint: %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(true);
  });

  it.each([
    ['plain http', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['another scheme', 'ftp://fcm.googleapis.com/fcm/send/abc'],
    ['scheme-relative', '//fcm.googleapis.com/fcm/send/abc'],
    ['uppercase scheme sneaking past', 'HTTPS://fcm.googleapis.com/fcm/send/abc'],
    ['an allowed host as a prefix of another domain', 'https://fcm.googleapis.com.evil.com/fcm/send/abc'],
    ['an allowed host in the path', 'https://evil.com/fcm.googleapis.com'],
    ['an allowed host in the query', 'https://evil.com/?h=fcm.googleapis.com'],
    ['userinfo naming the allowed host', 'https://user@fcm.googleapis.com/fcm/send/abc'],
    ['userinfo with a password', 'https://user:pw@fcm.googleapis.com/fcm/send/abc'],
    ['allowed host as userinfo of an evil host', 'https://fcm.googleapis.com@evil.com/x'],
    ['backslash parser confusion', 'https://fcm.googleapis.com\\@evil.com/x'],
    ['backslash host split', 'https://evil.com\\.fcm.googleapis.com/x'],
    ['a non-443 port', 'https://fcm.googleapis.com:8443/fcm/send/abc'],
    ['port 80', 'https://fcm.googleapis.com:80/fcm/send/abc'],
    ['an empty port', 'https://fcm.googleapis.com:/fcm/send/abc'],
    ['IPv4 literal', 'https://142.250.72.10/fcm/send/abc'],
    ['loopback', 'https://127.0.0.1/x'],
    ['decimal IPv4', 'https://2130706433/x'],
    ['IPv6 literal', 'https://[::1]/x'],
    ['metadata service', 'https://169.254.169.254/latest/meta-data/'],
    ['bare apple suffix', 'https://push.apple.com/x'],
    ['dot-prefixed apple suffix', 'https://.push.apple.com/x'],
    ['lookalike apple suffix', 'https://evilpush.apple.com.evil.com/x'],
    ['apple suffix without the dot', 'https://evil-push.apple.com/x'],
    ['bare windows suffix', 'https://notify.windows.com/x'],
    ['trailing-dot FQDN', 'https://fcm.googleapis.com./fcm/send/abc'],
    ['uppercase host', 'https://FCM.googleapis.com/fcm/send/abc'],
    ['no path', 'https://fcm.googleapis.com'],
    ['fragment', 'https://fcm.googleapis.com/fcm/send/abc#frag'],
    ['whitespace', 'https://fcm.googleapis.com/fcm/send/a bc'],
    ['leading whitespace', ' https://fcm.googleapis.com/fcm/send/abc'],
    ['newline', 'https://fcm.googleapis.com/fcm/send/abc\n'],
    ['tab inside host', 'https://fcm.google\tapis.com/x'],
    ['percent-encoded host', 'https://fcm%2egoogleapis.com/x'],
    ['unicode lookalike host', 'https://fcm.googleаpis.com/x'],
    ['empty label', 'https://fcm..googleapis.com/x'],
    ['an unknown push-ish host', 'https://push.example.com/x'],
    ['google but not fcm', 'https://android.googleapis.com/gcm/send/abc'],
    ['empty string', ''],
  ])('refuses %s', (_label, url) => {
    expect(isAllowedPushEndpoint(url)).toBe(false);
  });

  it('refuses non-strings and overlong URLs', () => {
    expect(isAllowedPushEndpoint(undefined)).toBe(false);
    expect(isAllowedPushEndpoint(null)).toBe(false);
    expect(isAllowedPushEndpoint(42)).toBe(false);
    expect(isAllowedPushEndpoint({ toString: () => 'https://fcm.googleapis.com/x' })).toBe(false);
    expect(isAllowedPushEndpoint(`https://fcm.googleapis.com/${'a'.repeat(2100)}`)).toBe(false);
  });
});

// 65-byte uncompressed P-256 point and 16-byte auth, as PushSubscription.toJSON() encodes them.
const P256DH = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url');
const AUTH = Buffer.alloc(16, 3).toString('base64url');
const FCM = 'https://fcm.googleapis.com/fcm/send/abc:def';

describe('parseSubscriptionBody', () => {
  const body = (over: Record<string, unknown> = {}, keys: Record<string, unknown> = {}) => ({
    subscription: { endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH, ...keys }, ...over },
    userAgent: 'Mozilla/5.0 (iPhone)',
  });

  it('accepts PushSubscription.toJSON() plus a user agent', () => {
    expect(parseSubscriptionBody(body())).toEqual({ endpoint: FCM, p256dh: P256DH, auth: AUTH, userAgent: 'Mozilla/5.0 (iPhone)' });
  });

  it('accepts padded base64url keys and a missing user agent', () => {
    const r = parseSubscriptionBody({ subscription: { endpoint: FCM, keys: { p256dh: `${P256DH}=`, auth: `${AUTH}==` } } });
    expect(r).toMatchObject({ userAgent: null });
  });

  it('truncates a long user agent', () => {
    const r = parseSubscriptionBody({ ...body(), userAgent: 'x'.repeat(2000) });
    expect('error' in r ? null : r.userAgent?.length).toBe(512);
  });

  it('refuses an endpoint off the allow-list', () => {
    expect(parseSubscriptionBody(body({ endpoint: 'https://evil.com/fcm.googleapis.com' }))).toEqual({ error: expect.stringMatching(/push service/) });
  });

  it.each([
    ['no body', undefined],
    ['an array', []],
    ['no subscription', {}],
    ['subscription not an object', { subscription: 'x' }],
    ['no endpoint', { subscription: { keys: { p256dh: P256DH, auth: AUTH } } }],
    ['no keys', { subscription: { endpoint: FCM } }],
  ])('refuses %s', (_l, b) => {
    expect(parseSubscriptionBody(b)).toHaveProperty('error');
  });

  it.each([
    ['p256dh missing', { p256dh: undefined }],
    ['p256dh not base64url', { p256dh: 'not+base64/' }],
    ['p256dh too short', { p256dh: Buffer.alloc(33, 4).toString('base64url') }],
    ['p256dh compressed point', { p256dh: Buffer.concat([Buffer.from([0x02]), Buffer.alloc(64, 7)]).toString('base64url') }],
    ['p256dh overlong', { p256dh: 'A'.repeat(500) }],
    ['auth wrong length', { auth: Buffer.alloc(8, 1).toString('base64url') }],
    ['auth not a string', { auth: 16 }],
  ])('refuses %s', (_l, keys) => {
    expect(parseSubscriptionBody(body({}, keys))).toHaveProperty('error');
  });

  it('refuses a non-string user agent', () => {
    expect(parseSubscriptionBody({ ...body(), userAgent: { ua: 1 } })).toHaveProperty('error');
  });
});

describe('parseEndpointBody', () => {
  it('takes any endpoint string (deleting needs no allow-list)', () => {
    expect(parseEndpointBody({ endpoint: 'https://anything/x' })).toEqual({ endpoint: 'https://anything/x' });
  });
  it('refuses a missing, empty or overlong endpoint', () => {
    expect(parseEndpointBody({})).toHaveProperty('error');
    expect(parseEndpointBody({ endpoint: '' })).toHaveProperty('error');
    expect(parseEndpointBody({ endpoint: 'x'.repeat(3000) })).toHaveProperty('error');
    expect(parseEndpointBody(null)).toHaveProperty('error');
  });
});

describe('vapidSubjectProblem', () => {
  it('accepts a mailto: on a public domain and an https: URL', () => {
    expect(vapidSubjectProblem('mailto:termag@example.com')).toBeNull();
    expect(vapidSubjectProblem('https://termag.example.com/contact')).toBeNull();
  });

  it('refuses what Apple answers BadJwtToken for, and malformed subjects', () => {
    expect(vapidSubjectProblem('mailto:e2e@termag.local')).toMatch(/private-use/);
    expect(vapidSubjectProblem('mailto:me@localhost')).toMatch(/not a public domain/);
    expect(vapidSubjectProblem('https://box.internal')).toMatch(/private-use/);
    expect(vapidSubjectProblem('mailto:')).toMatch(/needs an address/);
    expect(vapidSubjectProblem('admin@example.com')).toMatch(/mailto: address or an https: URL/);
    expect(vapidSubjectProblem('http://example.com')).toMatch(/mailto: address or an https: URL/);
  });

  it('turns push off for a refused subject', () => {
    expect(vapidConfigFromEnv({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k', VAPID_SUBJECT: 'mailto:e2e@termag.local' })).toBeNull();
  });
});

describe('vapidConfigFromEnv / appBaseUrl', () => {
  it('is off unless all three VAPID vars are set', () => {
    expect(vapidConfigFromEnv({})).toBeNull();
    expect(vapidConfigFromEnv({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k' })).toBeNull();
    expect(vapidConfigFromEnv({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: ' ', VAPID_SUBJECT: 'mailto:a@b.c' })).toBeNull();
    expect(vapidConfigFromEnv({ VAPID_PUBLIC_KEY: 'p', VAPID_PRIVATE_KEY: 'k', VAPID_SUBJECT: 'mailto:a@b.c' }))
      .toEqual({ publicKey: 'p', privateKey: 'k', subject: 'mailto:a@b.c' });
  });

  it('joins FRONTEND_URL and BASE_PATH without doubled slashes', () => {
    expect(appBaseUrl({ FRONTEND_URL: 'https://example.com/', BASE_PATH: '/termag' })).toBe('https://example.com/termag');
    expect(appBaseUrl({ FRONTEND_URL: 'https://example.com', BASE_PATH: '' })).toBe('https://example.com');
  });
});

describe('plainPreview', () => {
  it('drops markdown emphasis, code ticks and a leading marker', () => {
    expect(plainPreview("Here's what I can tell from reading **orchestrator**:")).toBe("Here's what I can tell from reading orchestrator:");
    expect(plainPreview('## Ran `npm test`  ok')).toBe('Ran npm test ok');
    expect(plainPreview('- __one__ item')).toBe('one item');
    expect(plainPreview('snake_case stays')).toBe('snake_case stays');
  });
});

describe('buildChatTurnPayload', () => {
  const base = { baseUrl: 'https://example.com/termag', projectId: 'proj1', projectName: 'orchestrator', session: 'alice-orchestrator-agent' };

  it('opens the chat in the simple UI, one notification per chat, no badge', () => {
    expect(buildChatTurnPayload({ ...base, workstream: 'main', message: 'The ask is waiting in the background.' })).toEqual({
      web_push: 8030,
      mutable: true,
      notification: {
        title: 'orchestrator',
        body: 'Your turn · The ask is waiting in the background.',
        navigate: 'https://example.com/termag/chat/p/proj1',
        tag: 'chat-turn:proj1:main',
        data: { key: 'chat-turn:proj1:main', kind: 'chat-turn' },
      },
      termag: { session: 'alice-orchestrator-agent', projectId: 'proj1', workstream: 'main', kind: 'chat-turn' },
    });
  });

  it('names a workstream, and says Done without a message', () => {
    const p = buildChatTurnPayload({ ...base, workstream: 'run-20261021-0900', message: '  ' });
    expect(p.notification.title).toBe('orchestrator · run-20261021-0900');
    expect(p.notification.navigate).toBe('https://example.com/termag/chat/p/proj1?ws=run-20261021-0900');
    expect(p.notification.body).toBe('Done · your turn');
    expect(p.notification.tag).toBe('chat-turn:proj1:run-20261021-0900');
  });

  it('caps a long message', () => {
    const body = buildChatTurnPayload({ ...base, workstream: 'main', message: 'x'.repeat(400) }).notification.body;
    expect(body.length).toBe('Your turn · '.length + 180);
    expect(body.endsWith('…')).toBe(true);
  });
});

describe('buildWaitingPayload', () => {
  const base = {
    baseUrl: 'https://example.com/termag',
    projectId: 'proj1',
    projectName: 'termag',
    session: 'alice-termag-agent',
    tag: 'box-a|alice-termag-agent',
    waitingCount: 3,
  };

  it('builds the Declarative Web Push shape for the main workstream', () => {
    expect(buildWaitingPayload({ ...base, workstream: 'main', message: 'Claude needs your permission to use Bash' })).toEqual({
      web_push: 8030,
      mutable: true,
      notification: {
        title: 'termag',
        body: 'Claude needs your permission to use Bash',
        navigate: 'https://example.com/termag/m/p/proj1',
        tag: 'box-a|alice-termag-agent',
        data: { key: 'box-a|alice-termag-agent' },
      },
      app_badge: '3',
      termag: { session: 'alice-termag-agent', projectId: 'proj1', workstream: 'main' },
    });
  });

  it('names a non-main workstream in the title and the URL', () => {
    const p = buildWaitingPayload({ ...base, workstream: 'fix/login bug', session: 'alice-termag-fix-agent' });
    expect(p.notification.title).toBe('termag · fix/login bug');
    expect(p.notification.navigate).toBe('https://example.com/termag/m/p/proj1?ws=fix%2Flogin%20bug');
    expect(p.termag?.workstream).toBe('fix/login bug');
  });

  it('falls back on the waiting reason when there is no message', () => {
    expect(buildWaitingPayload({ ...base, workstream: 'main', waitingReason: 'approval' }).notification.body).toBe('Needs approval');
    expect(buildWaitingPayload({ ...base, workstream: 'main', message: '  ', waitingReason: 'user_input' }).notification.body).toBe('Asked you a question');
    expect(buildWaitingPayload({ ...base, workstream: 'main', waitingReason: null }).notification.body).toBe('Waiting for you');
  });

  it('collapses whitespace and caps a long message', () => {
    const body = buildWaitingPayload({ ...base, workstream: 'main', message: `a\n\nb ${'x'.repeat(400)}` }).notification.body;
    expect(body.startsWith('a b x')).toBe(true);
    expect(body.length).toBe(180);
    expect(body.endsWith('…')).toBe(true);
  });

  it('sends the badge as a whole, non-negative count string', () => {
    expect(buildWaitingPayload({ ...base, workstream: 'main', waitingCount: 0 }).app_badge).toBe('0');
    expect(buildWaitingPayload({ ...base, workstream: 'main', waitingCount: -2 }).app_badge).toBe('0');
    expect(buildWaitingPayload({ ...base, workstream: 'main', waitingCount: 2.7 }).app_badge).toBe('2');
  });

  it('escapes the project id in the path', () => {
    expect(buildWaitingPayload({ ...base, projectId: '../x', workstream: 'main' }).notification.navigate)
      .toBe('https://example.com/termag/m/p/..%2Fx');
  });
});

describe('buildTestPayload', () => {
  it('opens the phone inbox', () => {
    expect(buildTestPayload('https://example.com/termag')).toEqual({
      web_push: 8030,
      mutable: true,
      notification: {
        title: 'termag', body: 'Notifications are on for this device', navigate: 'https://example.com/termag/m', tag: 'termag-test',
        data: { key: 'termag-test' },
      },
    });
  });
});

describe('isLiveSubscription', () => {
  it('is live until it fails, and again once a later send succeeds', () => {
    expect(isLiveSubscription({ lastUsedAt: null, failedAt: null })).toBe(true);
    expect(isLiveSubscription({ lastUsedAt: null, failedAt: new Date(10) })).toBe(false);
    expect(isLiveSubscription({ lastUsedAt: new Date(5), failedAt: new Date(10) })).toBe(false);
    expect(isLiveSubscription({ lastUsedAt: new Date(20), failedAt: new Date(10) })).toBe(true);
  });
});

function fakeStore(subs: StoredSubscription[] = []) {
  return {
    listForUser: vi.fn(async () => subs),
    remove: vi.fn(async () => {}),
    markUsed: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
  } satisfies PushStore;
}

const VAPID = { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:ops@example.com' };
const sub = (id: string, endpoint = `https://fcm.googleapis.com/fcm/send/${id}`): StoredSubscription => ({ id, endpoint, p256dh: P256DH, auth: AUTH });
const payload = buildTestPayload('https://example.com/termag');

describe('sendToSubscriptions', () => {
  it('sends JSON with a short TTL and high urgency, and stamps lastUsedAt', async () => {
    const store = fakeStore();
    const transport = vi.fn(async () => ({ statusCode: 201 }));
    const at = new Date('2026-10-14T12:00:00Z');
    const r = await sendToSubscriptions([sub('a')], payload, { store, transport, vapid: VAPID, now: () => at });
    expect(r).toEqual({ sent: 1, failed: 0, removed: 0 });
    expect(transport).toHaveBeenCalledWith(
      { endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { p256dh: P256DH, auth: AUTH } },
      JSON.stringify(payload),
      expect.objectContaining({ TTL: PUSH_TTL_SECONDS, urgency: 'high', contentEncoding: 'aes128gcm', vapidDetails: { subject: VAPID.subject, publicKey: 'pub', privateKey: 'priv' } }),
    );
    expect(PUSH_TTL_SECONDS).toBeLessThanOrEqual(3600);
    expect(store.markUsed).toHaveBeenCalledWith('a', at);
  });

  it('deletes rows the push service says are gone (404/410) and stamps failedAt on anything else', async () => {
    const store = fakeStore();
    const fail = (statusCode: number) => Object.assign(new Error(`status ${statusCode}`), { statusCode });
    const transport = vi.fn(async (s: { endpoint: string }) => {
      if (s.endpoint.endsWith('/gone')) throw fail(410);
      if (s.endpoint.endsWith('/missing')) throw fail(404);
      if (s.endpoint.endsWith('/throttled')) throw fail(429);
      if (s.endpoint.endsWith('/net')) throw new Error('ECONNRESET');
      return { statusCode: 201 };
    });
    const r = await sendToSubscriptions(
      [sub('gone'), sub('missing'), sub('throttled'), sub('net'), sub('ok')],
      payload,
      { store, transport, vapid: VAPID, log: () => {} },
    );
    expect(r).toEqual({ sent: 1, failed: 4, removed: 2 });
    expect(store.remove.mock.calls.map(c => c[0]).sort()).toEqual(['gone', 'missing']);
    expect(store.markFailed.mock.calls.map(c => c[0]).sort()).toEqual(['net', 'throttled']);
    expect(store.markUsed.mock.calls.map(c => c[0])).toEqual(['ok']);
  });

  it('never POSTs to a stored endpoint that fails the allow-list, and drops the row', async () => {
    const store = fakeStore();
    const transport = vi.fn(async () => ({ statusCode: 201 }));
    const r = await sendToSubscriptions([sub('bad', 'https://169.254.169.254/latest')], payload, { store, transport, vapid: VAPID });
    expect(transport).not.toHaveBeenCalled();
    expect(store.remove).toHaveBeenCalledWith('bad');
    expect(r).toEqual({ sent: 0, failed: 1, removed: 1 });
  });

  it('sends nothing with push off', async () => {
    const transport = vi.fn();
    expect(await sendToSubscriptions([sub('a')], payload, { store: fakeStore(), transport, vapid: null })).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it('survives a store that throws', async () => {
    const store = { ...fakeStore(), markUsed: vi.fn(async () => { throw new Error('db down'); }) };
    const r = await sendToSubscriptions([sub('a')], payload, { store, transport: async () => ({ statusCode: 201 }), vapid: VAPID });
    expect(r.sent).toBe(1);
  });
});

describe('sendToUser', () => {
  it("reads the user's rows and sends to each", async () => {
    const store = fakeStore([sub('a'), sub('b')]);
    const transport = vi.fn(async () => ({ statusCode: 201 }));
    const deps: SendDeps = { store, transport, vapid: VAPID };
    expect(await sendToUser('u1', payload, deps)).toEqual({ sent: 2, failed: 0, removed: 0 });
    expect(store.listForUser).toHaveBeenCalledWith('u1');
  });

  it('does not read the database with push off, and never throws when it is down', async () => {
    const store = fakeStore();
    expect(await sendToUser('u1', payload, { store, transport: vi.fn(), vapid: null })).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect(store.listForUser).not.toHaveBeenCalled();
    const broken = { ...fakeStore(), listForUser: vi.fn(async () => { throw new Error('down'); }) };
    vi.spyOn(console, 'warn').mockImplementationOnce(() => {});
    expect(await sendToUser('u1', payload, { store: broken, transport: vi.fn(), vapid: VAPID })).toEqual({ sent: 0, failed: 0, removed: 0 });
  });
});

describe('the real web-push encryption path', () => {
  it('encrypts this payload for a real P-256 subscription key without throwing', () => {
    // generateRequestDetails runs everything sendNotification does except the HTTP request.
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const keys = webpush.generateVAPIDKeys();
    const details = webpush.generateRequestDetails(
      { endpoint: FCM, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } },
      JSON.stringify(buildWaitingPayload({
        baseUrl: 'https://example.com/termag', projectId: 'p', projectName: 'n', workstream: 'main',
        session: 's', tag: '|s', waitingCount: 1,
      })),
      { vapidDetails: { subject: 'mailto:ops@example.com', ...keys }, TTL: PUSH_TTL_SECONDS, urgency: 'high', contentEncoding: 'aes128gcm' },
    );
    expect(details.endpoint).toBe(FCM);
    expect(details.headers).toMatchObject({ TTL: PUSH_TTL_SECONDS, Urgency: 'high', 'Content-Encoding': 'aes128gcm' });
    expect(String(details.headers.Authorization)).toMatch(/^vapid t=.+, k=/);
    expect(details.body?.length).toBeGreaterThan(100);
  });
});
