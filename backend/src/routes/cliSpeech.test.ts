/**
 * GET /api/cli/v1/speech/whisper-base/<file> (routes/cliSpeech.ts) through the
 * real cliApiRouter and its bearer check: a device sign-in downloads the
 * model's files, a box token, the flag off and anything but the model's own
 * files don't.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import { SPEECH_MODEL_DIR } from './cliSpeech';

vi.mock('../db', () => ({ prisma: {} }));

const { cliApiRouter } = await import('./cliApi');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');

const cliUser = (id: string): CliUser => ({ id, googleEmail: `${id}@example.com`, unixUsername: id, displayName: id });
const DEVICE = 'tmcli_' + 'a'.repeat(64);
const BOX = 'tmag_alice_box';
const now = new Date('2026-10-30T06:00:00Z');

const store: CliStore = {
  async findSessionByHash(hash) {
    if (sha256Hex(DEVICE) !== hash) return null;
    return { id: 's-alice', userId: 'alice', user: cliUser('alice'), deviceName: 'mbp', tokenPrefix: 'tmcli_xxx', createdAt: now, lastUsedAt: now, revokedAt: null } satisfies CliSessionRecord;
  },
  async validateAgentToken(raw) {
    return raw === BOX ? { user: cliUser('alice'), instanceId: 'i-1' } : null;
  },
  createSession: async () => { throw new Error('unused'); },
  findSessionById: async () => null,
  touchSession: async () => {},
  revokeSession: async () => {},
  listBoxes: async () => [],
  listProjects: async () => [],
  listDevices: async () => [],
  revokeDevice: async () => false,
};

let dir: string;
let desktopOn = true;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cli-speech-'));
  mkdirSync(join(dir, SPEECH_MODEL_DIR, 'onnx'), { recursive: true });
  writeFileSync(join(dir, SPEECH_MODEL_DIR, 'config.json'), '{"model_type":"whisper"}');
  writeFileSync(join(dir, SPEECH_MODEL_DIR, 'onnx/encoder_model_quantized.onnx'), Buffer.from([1, 2, 3, 4]));
  writeFileSync(join(dir, 'secret.txt'), 'not the model');
  const app = express();
  app.use('/api/cli/v1', cliApiRouter({
    store, codes: new AuthCodeStore(), jwt: new Promise(() => {}), now: () => now,
    speech: { dir, desktopOn: async () => desktopOn },
  }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => { desktopOn = true; });

const get = (path: string, token: string | null = DEVICE) =>
  fetch(`${base}/api/cli/v1/speech/whisper-base/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('GET /api/cli/v1/speech/whisper-base/<file>', () => {
  it("serves the model's files to a device sign-in", async () => {
    const config = await get('config.json');
    expect(config.status).toBe(200);
    expect(await config.text()).toBe('{"model_type":"whisper"}');
    const encoder = await get('onnx/encoder_model_quantized.onnx');
    expect(encoder.status).toBe(200);
    expect([...new Uint8Array(await encoder.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it("refuses a box's own token with 403, and no token with 401", async () => {
    const box = await get('config.json', BOX);
    expect(box.status).toBe(403);
    expect((await box.json()).code).toBe('forbidden');
    expect((await get('config.json', null)).status).toBe(401);
  });

  it("answers 404 with the flag off, for a file that isn't the model's, and for one the build lacks", async () => {
    desktopOn = false;
    expect((await get('config.json')).status).toBe(404);
    desktopOn = true;
    for (const path of ['../../secret.txt', '..%2F..%2Fsecret.txt', 'secret.txt', 'onnx%2F..%2Fconfig.json']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
    const missing = await get('tokenizer.json');
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe('not_found');
  });
});
