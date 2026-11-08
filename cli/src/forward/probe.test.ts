import { describe, expect, it } from 'vitest';
import { Api } from '../api.js';
import { CliError } from '../errors.js';
import { probeForward } from './probe.js';

const box = { id: 'b1', name: 'zane-dev' };
const apiAnswering = (res: () => Response) => new Api({ host: 'https://termag.example', token: 't', fetch: (async () => res()) as typeof fetch });

describe('probeForward', () => {
  it('throws an edge 502/503/504 (HTML, no JSON) as unreachable, not a forward refusal', async () => {
    for (const status of [502, 503, 504]) {
      const err = await probeForward(apiAnswering(() => new Response('<html>Bad Gateway</html>', { status, headers: { 'content-type': 'text/html' } })), box, [], { retryDelayMs: 0 })
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe('unreachable');
      expect((err as CliError).status).toBe(status);
      expect((err as CliError).message).toContain(`HTTP ${status}`);
    }
  });

  it('still returns a JSON 502 tunnel_failed as a refusal', async () => {
    const r = await probeForward(apiAnswering(() => new Response(JSON.stringify({ error: 'no tunnel', code: 'tunnel_failed' }), { status: 502, headers: { 'content-type': 'application/json' } })), box, [], { retryDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, code: 'tunnel_failed', status: 502 });
  });
});
