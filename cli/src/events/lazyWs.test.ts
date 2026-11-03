import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../context.js';
import { run } from '../main.js';

// As in forward/lazyWs.test.ts: an install whose `ws` is gone.
vi.mock('ws', () => {
  throw Object.assign(new Error("Cannot find package 'ws' imported from dist/events/socket.js"), { code: 'ERR_MODULE_NOT_FOUND' });
});

const home = mkdtempSync(join(tmpdir(), 'termag-events-lazy-ws-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('termag events without ws installed', () => {
  it('fails, saying what is missing, and the help still shows', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const ctx: Ctx = {
      env: { TERMAG_URL: 'http://127.0.0.1:9/termag' }, home, hostname: 'laptop.local', interactive: false,
      out: t => out.push(t), err: t => err.push(t), fetch: globalThis.fetch, openBrowser: () => {}, readFile: () => null,
    };
    expect(await run(['events', '--help'], ctx)).toBe(0);
    expect(out.join('\n')).toContain('termag events [--json]');
    expect(await run(['events'], ctx)).toBe(1);
    expect(err.join('\n')).toContain('termag events needs the `ws` package');
  });
});
