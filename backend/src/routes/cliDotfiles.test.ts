import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { CliSessionRecord, CliStore, CliUser } from '../services/cliStore';
import type { CliDotfiles } from './cliDotfiles';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('../middleware/auth', () => ({ requireAuth: () => {} }));

const { cliApiRouter } = await import('./cliApi');
const { AuthCodeStore, sha256Hex } = await import('../services/cliAuth');

const alice: CliUser = { id: 'alice', googleEmail: 'alice@example.com', unixUsername: 'alice', displayName: 'Alice' };
const DEVICE = 'tmcli_' + 'd'.repeat(64);
const BOX = 'tmag_box';
const now = new Date('2026-10-31T00:00:00Z');

const store: CliStore = {
  async findSessionByHash(hash) {
    if (hash !== sha256Hex(DEVICE)) return null;
    return {
      id: 's1', userId: 'alice', user: alice, deviceName: 'mbp', tokenPrefix: 'tmcli_ddd',
      createdAt: now, lastUsedAt: now, revokedAt: null,
    } satisfies CliSessionRecord;
  },
  async validateAgentToken(raw) {
    return raw === BOX ? { user: alice, instanceId: 'b1' } : null;
  },
  createSession: async () => { throw new Error('unused'); },
  touchSession: async () => {},
  revokeSession: async () => {},
  listBoxes: async () => [],
  listProjects: async () => [],
  listDevices: async () => [],
  revokeDevice: async () => false,
};

const state = { url: null as string | null, newBoxes: true, saves: [] as Array<string | null> };
const deps: CliDotfiles = {
  read: async () => ({ dotfilesRepoUrl: state.url, newBoxes: state.newBoxes }),
  save: async (_userId, url) => { state.url = url; state.saves.push(url); },
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/cli/v1', cliApiRouter({ store, codes: new AuthCodeStore(), now: () => now, dotfiles: deps }));
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  state.url = 'https://github.com/alice/dotfiles';
  state.newBoxes = true;
  state.saves = [];
});

const read = (token = DEVICE) =>
  fetch(`${base}/api/cli/v1/dotfiles`, { headers: { authorization: `Bearer ${token}` } });
const save = (body: unknown, token = DEVICE) =>
  fetch(`${base}/api/cli/v1/dotfiles`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('GET /dotfiles', () => {
  it('answers the saved repository and whether new boxes apply it, for a device or a box', async () => {
    for (const token of [DEVICE, BOX]) {
      const res = await read(token);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ dotfilesRepoUrl: 'https://github.com/alice/dotfiles', newBoxes: true });
    }
  });
});

describe('PUT /dotfiles', () => {
  it('saves the repository as web Settings normalizes it', async () => {
    const res = await save({ dotfilesRepoUrl: ' https://github.com/alice/dots.git ' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dotfilesRepoUrl: 'https://github.com/alice/dots' });
    expect(state.saves).toEqual(['https://github.com/alice/dots']);
  });

  it('clears it with null or an empty string', async () => {
    for (const dotfilesRepoUrl of [null, '']) {
      const res = await save({ dotfilesRepoUrl });
      expect(await res.json()).toEqual({ dotfilesRepoUrl: null });
    }
    expect(state.saves).toEqual([null, null]);
  });

  it("refuses what isn't a GitHub repository, with the web's reason", async () => {
    const res = await save({ dotfilesRepoUrl: 'git@github.com:alice/dots.git' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'dotfilesRepoUrl must be a valid URL', code: 'invalid_dotfiles_url' });
    expect(state.saves).toEqual([]);
  });

  it("refuses a box's own token", async () => {
    const res = await save({ dotfilesRepoUrl: 'https://github.com/mallory/dots' }, BOX);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'box_credential' });
    expect(state.saves).toEqual([]);
  });
});
