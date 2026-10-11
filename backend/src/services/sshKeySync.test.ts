import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Box { id: string; name: string; status: string; hostHome: string | null }
const state = {
  keys: [] as string[],
  boxes: [] as Box[],
  connected: new Set<string>(),
  files: new Map<string, string>(),
  failWrites: new Set<string>(),
};

vi.mock('../db', () => ({
  prisma: {
    sshPublicKey: { findMany: async () => state.keys.map((publicKey) => ({ publicKey })) },
    instance: {
      findMany: async () => [...state.boxes].sort((a, b) => a.name.localeCompare(b.name)),
    },
  },
}));

vi.mock('./agentRegistry', () => ({
  isInstanceAgentConnected: (id: string) => state.connected.has(id),
  sendToInstanceAgent: async (id: string, type: string, payload: { path: string; content?: string }) => {
    if (type === 'read-file') return { ok: true, content: state.files.get(`${id}:${payload.path}`) ?? null };
    if (state.failWrites.has(id)) throw new Error('EACCES: permission denied');
    state.files.set(`${id}:${payload.path}`, payload.content!);
    return { ok: true };
  },
}));

const { pushSshKeysToBoxes } = await import('./sshKeySync');
const { managedBlock } = await import('./sshKeys');

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBAbYOa2X2cb3APrq0kCH4nqKhJ7K02+SmcLB3Y5DcE2 alice@laptop';
const box = (id: string, status = 'ready', hostHome: string | null = '/home/alice'): Box =>
  ({ id, name: id, status, hostHome });

beforeEach(() => {
  state.keys = [KEY];
  state.boxes = [];
  state.connected.clear();
  state.files.clear();
  state.failWrites.clear();
});

describe('pushSshKeysToBoxes', () => {
  it('reports the boxes it wrote to', async () => {
    state.boxes = [box('box-2'), box('box-1')];
    state.connected = new Set(['box-1', 'box-2']);
    await expect(pushSshKeysToBoxes('u1')).resolves.toEqual({ updated: ['box-1', 'box-2'], pending: [] });
    expect(state.files.get('box-1:/home/alice/.ssh/authorized_keys')).toBe(managedBlock([KEY]));
  });

  it('reports offline, never-connected and failed-write boxes as pending', async () => {
    state.boxes = [box('up'), box('offline'), box('booting', 'provisioning', null), box('locked')];
    state.connected = new Set(['up', 'locked']);
    state.failWrites.add('locked');
    await expect(pushSshKeysToBoxes('u1')).resolves.toEqual({ updated: ['up'], pending: ['booting', 'locked', 'offline'] });
  });

  it('leaves out failed boxes whose agent is gone', async () => {
    state.boxes = [box('dead', 'failed')];
    await expect(pushSshKeysToBoxes('u1')).resolves.toEqual({ updated: [], pending: [] });
  });

  it('counts a box whose file already matches as updated', async () => {
    state.boxes = [box('box-1')];
    state.connected.add('box-1');
    state.files.set('box-1:/home/alice/.ssh/authorized_keys', managedBlock([KEY]));
    await expect(pushSshKeysToBoxes('u1')).resolves.toEqual({ updated: ['box-1'], pending: [] });
  });
});
