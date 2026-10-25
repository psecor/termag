import { describe, expect, it, vi } from 'vitest';
import { CHARGE_MATCH_WINDOW_MS, EVENT_RETENTION_MS, MULTIPART_MAX_AGE_MS, spacesSweep, sweepSpaces } from './spaceSweeper';
import { MemorySpaceObjects, MemorySpaceStore } from './spacesTestkit';

describe('sweepSpaces', () => {
  it('makes no AWS call when there are no spaces', async () => {
    const objects = vi.fn();
    await sweepSpaces(new MemorySpaceStore(), objects);
    expect(objects).not.toHaveBeenCalled();
  });

  it('purges deleted spaces, recounts live ones from every version, and prunes', async () => {
    const store = new MemorySpaceStore();
    const s3 = new MemorySpaceObjects();
    store.addUser('alice');
    const live = await store.createSpace({ name: 'live', description: null, userId: 'alice' });
    const gone = await store.createSpace({ name: 'gone', description: null, userId: 'alice' });
    s3.put(`${live.id}/a`, 10);
    s3.put(`${live.id}/a`, 4);
    s3.put(`${gone.id}/b`, 7);
    await store.markDeleted(gone.id);
    store.addBox('dead', 'alice', 'dead', 'terminated');
    await store.addGrant(live.id, 'dead', 'alice');
    const now = Date.now();
    store.eventRows.push({ id: 'old', at: new Date(now - EVENT_RETENTION_MS - 1), spaceId: live.id, actorUserId: 'alice', action: 'file.get' });

    const r = await sweepSpaces(store, async () => s3, now);
    expect(r).toEqual({ purged: 1, recounted: 1, uploadsAborted: 0, grantsPruned: 1, eventsPruned: 1, errors: [] });
    expect(store.spaces.has(gone.id)).toBe(false);
    expect(s3.versions.has(`${gone.id}/b`)).toBe(false);
    expect(store.spaces.get(live.id)!.usedBytes).toBe(14n);
  });

  it('keeps charges whose URLs are still live on top of what S3 holds, and prunes expired ones after the match window', async () => {
    const store = new MemorySpaceStore();
    const s3 = new MemorySpaceObjects();
    store.addUser('alice');
    const live = await store.createSpace({ name: 'live', description: null, userId: 'alice' });
    const now = Date.now();
    s3.put(`${live.id}/done`, 5);
    await store.chargeBytes(live.id, 5n, new Date(now - CHARGE_MATCH_WINDOW_MS - 1), { key: `${live.id}/done` });
    await store.chargeBytes(live.id, 40n, new Date(now + 15 * 60_000), { key: `${live.id}/pending` });
    await sweepSpaces(store, async () => s3, now);
    expect(store.spaces.get(live.id)!.usedBytes).toBe(45n);
    expect(store.charges.map(c => c.bytes)).toEqual([40n]);
    await sweepSpaces(store, async () => s3, now + 16 * 60_000);
    expect(store.spaces.get(live.id)!.usedBytes).toBe(5n);
    expect(store.charges.map(c => c.bytes)).toEqual([40n]);
    await sweepSpaces(store, async () => s3, now + 15 * 60_000 + CHARGE_MATCH_WINDOW_MS + 1);
    expect(store.charges).toEqual([]);
  });

  it('counts the parts of unfinished multipart uploads, and aborts stale ones and a deleted space\'s', async () => {
    const store = new MemorySpaceStore();
    const s3 = new MemorySpaceObjects();
    store.addUser('alice');
    const live = await store.createSpace({ name: 'live', description: null, userId: 'alice' });
    const gone = await store.createSpace({ name: 'gone', description: null, userId: 'alice' });
    const now = Date.now();
    s3.put(`${live.id}/done`, 5);
    const fresh = await s3.createMultipart(`${live.id}/big`, 'application/octet-stream');
    s3.uploads.get(fresh)!.parts.set(1, 100);
    const stale = await s3.createMultipart(`${live.id}/old`, 'application/octet-stream');
    s3.uploads.get(stale)!.parts.set(1, 50);
    s3.uploads.get(stale)!.initiated = new Date(now - MULTIPART_MAX_AGE_MS - 1);
    const orphan = await s3.createMultipart(`${gone.id}/x`, 'application/octet-stream');
    s3.uploads.get(orphan)!.initiated = new Date(now + 60_000);
    await store.markDeleted(gone.id);

    const r = await sweepSpaces(store, async () => s3, now);
    expect(r.uploadsAborted).toBe(2);
    expect([...s3.uploads.keys()]).toEqual([fresh]);
    expect(s3.uploads.has(orphan)).toBe(false);
    expect(store.spaces.get(live.id)!.usedBytes).toBe(105n);
  });

  it('drops a single PUT\'s live charge once its object has landed, and keeps it while only an older version is there', async () => {
    const store = new MemorySpaceStore();
    const s3 = new MemorySpaceObjects();
    store.addUser('alice');
    const live = await store.createSpace({ name: 'live', description: null, userId: 'alice' });
    const now = Date.now();
    const signedAt = new Date(now - 5 * 60_000 + 300);
    const liveUntil = new Date(now + 10 * 60_000);
    s3.put(`${live.id}/old`, 10, 'text/plain', new Date(signedAt.getTime() - 60_000));
    await store.chargeBytes(live.id, 30n, liveUntil, { key: `${live.id}/old` }, signedAt);
    await store.chargeBytes(live.id, 20n, liveUntil, { key: `${live.id}/new` }, signedAt);
    s3.put(`${live.id}/new`, 20, 'text/plain', new Date(Math.floor(signedAt.getTime() / 1000) * 1000));

    await sweepSpaces(store, async () => s3, now);
    expect(store.spaces.get(live.id)!.usedBytes).toBe(10n + 20n + 30n);
    s3.put(`${live.id}/old`, 30, 'text/plain', new Date(now - 60_000));
    await sweepSpaces(store, async () => s3, now);
    expect(store.spaces.get(live.id)!.usedBytes).toBe(10n + 20n + 30n);
  });

  it('settles one same-key PUT charge per landed version, so a second URL stays charged until its own write lands', async () => {
    const store = new MemorySpaceStore();
    const s3 = new MemorySpaceObjects();
    store.addUser('alice');
    const live = await store.createSpace({ name: 'live', description: null, userId: 'alice' });
    const now = Date.now();
    const key = `${live.id}/a`;
    const liveUntil = new Date(now + 10 * 60_000);
    await store.chargeBytes(live.id, 7n, liveUntil, { key }, new Date(now - 4 * 60_000));
    await store.chargeBytes(live.id, 7n, liveUntil, { key }, new Date(now - 3 * 60_000));
    s3.put(key, 7, 'text/plain', new Date(now - 2 * 60_000));

    await sweepSpaces(store, async () => s3, now);
    expect(store.spaces.get(live.id)!.usedBytes).toBe(7n + 7n);
    s3.put(key, 7, 'text/plain', new Date(now - 60_000));
    await sweepSpaces(store, async () => s3, now);
    expect(store.spaces.get(live.id)!.usedBytes).toBe(7n + 7n);
    s3.put(key, 9, 'text/plain', new Date(now - 30_000));
    await sweepSpaces(store, async () => s3, now);
    expect(store.spaces.get(live.id)!.usedBytes).toBe(7n + 7n + 9n);
  });

  it('matches a version an expired URL wrote to its own charge, not to a newer live one', async () => {
    const store = new MemorySpaceStore();
    const s3 = new MemorySpaceObjects();
    store.addUser('alice');
    const live = await store.createSpace({ name: 'live', description: null, userId: 'alice' });
    const now = Date.now();
    const key = `${live.id}/a`;
    await store.chargeBytes(live.id, 7n, new Date(now - 60_000), { key }, new Date(now - 16 * 60_000));
    await store.chargeBytes(live.id, 7n, new Date(now + 13 * 60_000), { key }, new Date(now - 2 * 60_000));
    s3.put(key, 7, 'text/plain', new Date(now - 90_000));

    await sweepSpaces(store, async () => s3, now);
    expect(store.spaces.get(live.id)!.usedBytes).toBe(7n + 7n);
  });

  it('does not let an expired, unused charge claim a version written after its URL expired', async () => {
    const store = new MemorySpaceStore();
    const s3 = new MemorySpaceObjects();
    store.addUser('alice');
    const live = await store.createSpace({ name: 'live', description: null, userId: 'alice' });
    const now = Date.now();
    const key = `${live.id}/a`;
    await store.chargeBytes(live.id, 7n, new Date(now - 5 * 60_000), { key }, new Date(now - 20 * 60_000));
    await store.chargeBytes(live.id, 7n, new Date(now + 13 * 60_000), { key }, new Date(now - 2 * 60_000));
    s3.put(key, 7, 'text/plain', new Date(now - 60_000));

    await sweepSpaces(store, async () => s3, now);
    expect(store.spaces.get(live.id)!.usedBytes).toBe(7n);
  });

  it('drops a part batch\'s live charge once its upload completed, and counts an open upload\'s parts no live charge covers', async () => {
    const store = new MemorySpaceStore();
    const s3 = new MemorySpaceObjects();
    store.addUser('alice');
    const live = await store.createSpace({ name: 'live', description: null, userId: 'alice' });
    const now = Date.now();
    const liveUntil = new Date(now + 20 * 60_000);
    const done = await s3.createMultipart(`${live.id}/done`, 'application/octet-stream');
    await store.chargeBytes(live.id, 20n, liveUntil, { key: `${live.id}/done`, uploadId: done, partNumbers: [1, 2] });
    await s3.completeMultipart(`${live.id}/done`, done, [{ partNumber: 1, etag: 'a' }, { partNumber: 2, etag: 'b' }]);
    const open = await s3.createMultipart(`${live.id}/open`, 'application/octet-stream');
    await store.chargeBytes(live.id, 64n, new Date(now - 1), { key: `${live.id}/open`, uploadId: open, partNumbers: [1] });
    await store.chargeBytes(live.id, 128n, liveUntil, { key: `${live.id}/open`, uploadId: open, partNumbers: [2, 3] });
    s3.uploads.get(open)!.parts.set(1, 64).set(2, 64);

    await sweepSpaces(store, async () => s3, now);
    expect(store.spaces.get(live.id)!.usedBytes).toBe(20n + 64n + 128n);
    await s3.abortMultipart(`${live.id}/open`, open);
    await sweepSpaces(store, async () => s3, now);
    expect(store.spaces.get(live.id)!.usedBytes).toBe(20n);
  });
});

describe('spacesSweep', () => {
  it('cancels the delayed first sweep on stop, so a process that lost leadership sweeps nothing', async () => {
    vi.useFakeTimers();
    try {
      const objects = vi.fn();
      const store = new MemorySpaceStore();
      const liveSpaces = vi.spyOn(store, 'liveSpaces');
      const sweeper = spacesSweep(store, objects);
      sweeper.start();
      sweeper.stop();
      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
      expect(liveSpaces).not.toHaveBeenCalled();
      sweeper.start();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(liveSpaces).toHaveBeenCalled();
      sweeper.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
