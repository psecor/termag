/**
 * Keeps the termag-managed block of each owned EC2 box's
 * ~/.ssh/authorized_keys in step with the owner's registered keys. New boxes
 * get the block from cloud-init (boxProvisioner); running boxes get it over
 * the agent's read-file/write-file RPCs, on every key change and on connect.
 * External boxes are the user's own machines and are never touched.
 */

import { posix } from 'path';
import { prisma } from '../db';
import { isInstanceAgentConnected, sendToInstanceAgent } from './agentRegistry';
import { rewriteAuthorizedKeys } from './sshKeys';

export async function ownerAuthorizedKeyLines(userId: string): Promise<string[]> {
  const keys = await prisma.sshPublicKey.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    select: { publicKey: true },
  });
  return keys.map((k) => k.publicKey);
}

// Per-box chain so two quick edits can't land their writes out of order.
const inFlight = new Map<string, Promise<unknown>>();

export function syncBoxAuthorizedKeys(instanceId: string, userId: string, home: string): Promise<void> {
  const run = async () => {
    const path = posix.join(home, '.ssh', 'authorized_keys');
    const lines = await ownerAuthorizedKeyLines(userId);
    const read = await sendToInstanceAgent(instanceId, 'read-file', { path });
    const existing = typeof read?.content === 'string' ? read.content : null;
    const next = rewriteAuthorizedKeys(existing, lines);
    // No keys and no file: nothing to create, as cloud-init's step 4c.
    if (existing === null && next === '') return;
    // Written even when unchanged: sshd's StrictModes refuses the keys while
    // ~/.ssh or the file is group-writable, which a warm-pool box's first sync
    // left them (the agent's umask), and the write is what fixes the modes.
    await sendToInstanceAgent(instanceId, 'write-file', { path, content: next, mode: 0o600, dirMode: 0o700 });
    console.log(`[SSH-KEYS] instance ${instanceId}: wrote ${lines.length} managed key(s)`);
  };
  const next = (inFlight.get(instanceId) ?? Promise.resolve()).then(run);
  const tail = next.catch(() => {});
  inFlight.set(instanceId, tail);
  void tail.then(() => { if (inFlight.get(instanceId) === tail) inFlight.delete(instanceId); });
  return next;
}

/** Box names, by outcome. `pending` boxes catch up when their agent next connects. */
export interface SshKeySyncResult {
  updated: string[];
  pending: string[];
}

/** Push the owner's current keys to every connected EC2 box they own. */
export async function pushSshKeysToBoxes(userId: string): Promise<SshKeySyncResult> {
  const boxes = await prisma.instance.findMany({
    where: { userId, kind: 'ec2', status: { not: 'terminated' } },
    select: { id: true, name: true, status: true, hostHome: true },
    orderBy: { name: 'asc' },
  });
  const outcomes = await Promise.all(boxes.map(async (b): Promise<'updated' | 'pending' | 'skip'> => {
    if (!b.hostHome || !isInstanceAgentConnected(b.id)) return b.status === 'failed' ? 'skip' : 'pending';
    try {
      await syncBoxAuthorizedKeys(b.id, userId, b.hostHome);
      return 'updated';
    } catch (err) {
      console.error(`[SSH-KEYS] instance ${b.name}: sync failed:`, err instanceof Error ? err.message : String(err));
      return 'pending';
    }
  }));
  return {
    updated: boxes.filter((_, i) => outcomes[i] === 'updated').map((b) => b.name),
    pending: boxes.filter((_, i) => outcomes[i] === 'pending').map((b) => b.name),
  };
}
