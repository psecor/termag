import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spaStatic, isBuildFilePath } from './spaStatic';

let server: Server;
let base: string;
let dist: string;

beforeAll(async () => {
  dist = mkdtempSync(join(tmpdir(), 'spa-static-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>termag</title>');
  writeFileSync(join(dist, 'assets', 'index-abc.js'), 'console.log(1);\n//# sourceMappingURL=index-abc.js.map');
  writeFileSync(join(dist, 'assets', 'index-abc.js.map'), '{"version":3,"sources":[],"mappings":""}');
  const app = express();
  app.use('/termag/', spaStatic(dist));
  server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/termag`;
});
afterAll(() => { server.close(); rmSync(dist, { recursive: true, force: true }); });

describe('spaStatic', () => {
  it('serves a built chunk and its sourcemap', async () => {
    const js = await fetch(`${base}/assets/index-abc.js`);
    expect(js.status).toBe(200);
    const map = await fetch(`${base}/assets/index-abc.js.map`);
    expect(map.status).toBe(200);
    expect(await map.json()).toMatchObject({ version: 3 });
  });

  it('404s a missing sourcemap instead of serving index.html', async () => {
    const res = await fetch(`${base}/assets/index-gone.js.map`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<');
  });

  it('404s a missing chunk under /assets/', async () => {
    expect((await fetch(`${base}/assets/index-gone.js`)).status).toBe(404);
  });

  it('404s a missing .map outside /assets/', async () => {
    expect((await fetch(`${base}/whatever.js.map`)).status).toBe(404);
  });

  it('keeps the SPA fallback for app routes', async () => {
    for (const path of ['/', '/projects/abc', '/m/prs', '/settings/appearance']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('<title>termag</title>');
    }
  });
});

describe('isBuildFilePath', () => {
  it('names build files, not client routes', () => {
    expect(isBuildFilePath('/assets/x.js')).toBe(true);
    expect(isBuildFilePath('/x.css.map')).toBe(true);
    expect(isBuildFilePath('/speech/models/onnx-community/whisper-base/config.json')).toBe(true);
    expect(isBuildFilePath('/projects/assets')).toBe(false);
    expect(isBuildFilePath('/projects/my.app')).toBe(false);
  });
});
