import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseWebhookField, SEND_DEADLINE_MS, signWebhook, webhookBody, webhookProvider, webhookSender } from './webhook';

describe('parseWebhookField', () => {
  it('takes an https URL on a host name, and null to remove', () => {
    expect(parseWebhookField({ url: 'https://hooks.example.com/services/T/B/x?y=1' })).toEqual({ ok: true, value: { url: 'https://hooks.example.com/services/T/B/x?y=1' } });
    expect(parseWebhookField(null)).toEqual({ ok: true, value: null });
  });

  it('refuses http, an IP address, another port, credentials in the URL and anything but a URL', () => {
    for (const url of ['http://hooks.example.com/x', 'https://10.0.0.1/x', 'https://[::1]/x', 'https://hooks.example.com:8443/x', 'https://u:p@hooks.example.com/x', 'not a url', '']) {
      expect(parseWebhookField({ url }).ok, url).toBe(false);
    }
    expect(parseWebhookField('https://hooks.example.com').ok).toBe(false);
  });
});

describe('signWebhook', () => {
  it('is an HMAC-SHA256 of "<t>.<body>" with the secret', () => {
    const body = '{"event":"run.done"}';
    const expected = createHmac('sha256', 'whsec_x').update(`1700000000.${body}`).digest('hex');
    expect(signWebhook('whsec_x', body, 1700000000)).toBe(`t=1700000000,v1=${expected}`);
  });
});

describe('webhookProvider', () => {
  it('names the credential row after the automation, and refuses an id that is not one', () => {
    expect(webhookProvider('cmabc12345')).toBe('awh-cmabc12345');
    expect(() => webhookProvider('../x')).toThrow();
  });
});

describe('webhookBody', () => {
  it('carries the run id, the automation id, the state, the reason, the summary and the times', () => {
    const body = webhookBody({
      event: 'run.failed', at: new Date('2026-11-09T09:12:00Z'), automation: { id: 'a1', projectId: 'p1', name: 'triage' },
      run: { id: 'r1', state: 'failed', reason: 'timeout', summary: 'stopped after 60 minutes', trigger: 'schedule', scheduledFor: new Date('2026-11-09T08:00:00Z'), startedAt: new Date('2026-11-09T08:00:05Z'), finishedAt: new Date('2026-11-09T09:00:05Z'), prUrl: null },
      links: { run: null, automation: 'https://termag.example.com/automations/p1' },
    });
    expect(body).toEqual({
      event: 'run.failed', at: '2026-11-09T09:12:00.000Z',
      text: 'triage run failed (timeout): stopped after 60 minutes · https://termag.example.com/automations/p1',
      automationName: 'triage', runState: 'failed', summary: 'stopped after 60 minutes', url: 'https://termag.example.com/automations/p1',
      automation: { id: 'a1', projectId: 'p1', name: 'triage', url: 'https://termag.example.com/automations/p1' },
      run: { id: 'r1', state: 'failed', reason: 'timeout', summary: 'stopped after 60 minutes', trigger: 'schedule', scheduledFor: '2026-11-09T08:00:00.000Z', startedAt: '2026-11-09T08:00:05.000Z', finishedAt: '2026-11-09T09:00:05.000Z', prUrl: null, url: null },
    });
  });
});

describe('webhookText', () => {
  const run = { id: 'r1', state: 'blocked', reason: null, summary: 'BLOCKER: needs a human', trigger: 'schedule', scheduledFor: new Date('2026-11-09T08:00:00Z'), startedAt: null, finishedAt: null, prUrl: null };
  const base = { at: new Date('2026-11-09T09:00:00Z'), automation: { id: 'a1', projectId: 'p1', name: 'pr-watcher' } };

  it('says a run in one line, with its state, its summary and the run link before the automation link', () => {
    expect(webhookBody({ ...base, event: 'run.done', run, links: { run: 'https://t.example/run', automation: 'https://t.example/a' } }).text)
      .toBe('pr-watcher run blocked: BLOCKER: needs a human · https://t.example/run');
    expect(webhookBody({ ...base, event: 'run.done', run: { ...run, state: 'needs_input' }, links: { run: null, automation: null } }).text)
      .toBe('pr-watcher run needs input: BLOCKER: needs a human');
  });

  it('says a pause with its cause, and a run with no summary without one', () => {
    const paused = webhookBody({ ...base, event: 'automation.paused', run: null, pause: { reason: 'consecutive_failures', cause: '3 runs failed in a row' }, links: { run: null, automation: 'https://t.example/a' } });
    expect(paused).toMatchObject({ text: 'pr-watcher is paused: 3 runs failed in a row · https://t.example/a', runState: null, summary: null, url: 'https://t.example/a' });
    expect(webhookBody({ ...base, event: 'run.done', run: { ...run, state: 'done', summary: null }, links: { run: null, automation: null } }).text).toBe('pr-watcher run done');
  });

  it('cuts a long summary in the line, and withholds one that looks like a secret everywhere', () => {
    const long = webhookBody({ ...base, event: 'run.done', run: { ...run, summary: 'x'.repeat(2000) }, links: { run: null, automation: null } });
    expect((long.text as string).length).toBeLessThan(560);
    expect(long.summary).toHaveLength(2000);
    const secret = webhookBody({ ...base, event: 'run.done', run: { ...run, summary: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, links: { run: null, automation: null } });
    expect(secret.summary).toMatch(/^\[summary withheld/);
    expect(secret.text).not.toContain('ghp_');
    expect((secret.run as { summary: string }).summary).toBe(secret.summary);
  });
});

describe('webhookSender', () => {
  it('posts the signed body with the delivery id', async () => {
    const http = vi.fn(async () => ({ status: 204, headers: {}, text: '' }));
    const send = webhookSender(http);
    expect(await send('https://hooks.example.com/x', 'whsec_x', '{}', 'n1', new Date(1700000000_000))).toEqual({ ok: true });
    expect(http).toHaveBeenCalledWith('https://hooks.example.com/x', expect.objectContaining({
      method: 'POST', body: '{}', deadlineMs: SEND_DEADLINE_MS,
      headers: expect.objectContaining({ 'content-type': 'application/json', 'x-termag-delivery': 'n1', 'x-termag-signature': signWebhook('whsec_x', '{}', 1700000000) }),
    }));
  });

  it('retries a 5xx, 429, 408, a redirect and a network error; not another 4xx', async () => {
    const cases: Array<[number | Error, boolean]> = [[500, true], [503, true], [429, true], [408, true], [302, true], [400, false], [404, false], [410, false], [new Error('ECONNREFUSED'), true]];
    for (const [answer, retry] of cases) {
      const send = webhookSender(async () => { if (answer instanceof Error) throw answer; return { status: answer, headers: {}, text: '' }; });
      const r = await send('https://hooks.example.com/x', 's', '{}', 'n1');
      expect(r, String(answer)).toEqual({ ok: false, error: expect.any(String), retry });
    }
  });
});
