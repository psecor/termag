import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../context.js';
import { run } from '../main.js';

// As after an `npm ci` that emptied node_modules and then failed: `ws` doesn't resolve.
// vi.mock is hoisted above the imports, so a static `ws` import anywhere under main.js fails this file.
vi.mock('ws', () => {
  throw Object.assign(new Error("Cannot find package 'ws' imported from dist/forward/dial.js"), { code: 'ERR_MODULE_NOT_FOUND' });
});

const home = mkdtempSync(join(tmpdir(), 'termag-lazy-ws-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

function ctx(out: string[], err: string[]): Ctx {
  return {
    env: { TERMAG_URL: 'http://127.0.0.1:9/termag' },
    home,
    hostname: 'laptop.local',
    interactive: false,
    out: t => out.push(t),
    err: t => err.push(t),
    fetch: globalThis.fetch,
    openBrowser: () => {},
    readFile: () => null,
  };
}

describe('without ws installed', () => {
  it('still loads the command table and runs other commands', async () => {
    const out: string[] = [];
    expect(await run(['--help'], ctx(out, []))).toBe(0);
    expect(out.join('\n')).toContain('forward');
    expect(out.join('\n')).toContain('update');
    expect(await run(['--version'], ctx(out, []))).toBe(0);
  });

  it('fails only termag forward, saying what is missing', async () => {
    const { loadForwarder } = await import('./command.js');
    await expect(loadForwarder()).rejects.toThrow('termag forward needs the `ws` package, which this install is missing');
  });
});
