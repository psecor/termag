import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../db';
import { eventDetail, notifyCloudSessionChange, recordSessionEvent, setCloudSessionChangeCallback } from './claudeSessionEvents';

vi.mock('../db', () => ({ prisma: { claudeSessionEvent: { create: vi.fn() } } }));

const owner = { id: 'u1', unixUsername: 'ada' };

describe('recordSessionEvent', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => setCloudSessionChangeCallback(null));

  it('appends the row and tells the owner', async () => {
    const changed = vi.fn();
    setCloudSessionChangeCallback(changed);
    await recordSessionEvent({ owner, sessionId: 'cse_01A', orderId: 'ord.1', instanceId: 'box-a', kind: 'placed', detail: 'ada-box slot 2' });
    expect(prisma.claudeSessionEvent.create).toHaveBeenCalledWith({
      data: { userId: 'u1', sessionId: 'cse_01A', orderId: 'ord.1', instanceId: 'box-a', kind: 'placed', detail: 'ada-box slot 2' },
    });
    expect(changed).toHaveBeenCalledWith(owner, 'cse_01A');
  });

  it('never throws: a failed insert is logged and the owner is still told', async () => {
    const changed = vi.fn();
    setCloudSessionChangeCallback(changed);
    vi.mocked(prisma.claudeSessionEvent.create).mockRejectedValueOnce(new Error('db down'));
    await expect(recordSessionEvent({ owner, sessionId: 'cse_01A', orderId: 'ord.1', kind: 'queued', detail: 'no box' })).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('[CLAUDE-RUNNER] order ord.1: recording the queued event failed:', 'db down');
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing change callback', () => {
    setCloudSessionChangeCallback(() => { throw new Error('socket gone'); });
    expect(() => notifyCloudSessionChange(owner, 'cse_01A')).not.toThrow();
  });

  it('trims a detail to the column: control characters out, 500 characters at most, null for nothing', () => {
    expect(eventDetail(' box \u0007off \n')).toBe('box off');
    expect(eventDetail('x'.repeat(600))!.length).toBe(500);
    expect(eventDetail('   ')).toBeNull();
    expect(eventDetail(undefined)).toBeNull();
  });
});
