import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({ project: { findUnique: vi.fn() } }));
vi.mock('../db', () => ({ prisma }));
vi.mock('./productEvents', () => ({ recordProductEvent: vi.fn() }));

import { recordSessionTitle } from './sessionTitleEvent';

const change = { projectId: 'p1', workstream: 'main', title: 'Billing export retry verifier', source: 'claude' as const };

describe('recordSessionTitle', () => {
  beforeEach(() => { prisma.project.findUnique.mockReset(); });

  it('records the title with its project, workstream and box for an owner who leaves it on', async () => {
    prisma.project.findUnique.mockResolvedValue({ name: 'system-verifiers', instanceId: 'box1', user: { id: 'u1', telemetryTitles: true } });
    const record = vi.fn();
    await recordSessionTitle(change, record);
    expect(record).toHaveBeenCalledWith('session.titled', { user: 'u1', box: 'box1' },
      { title: 'Billing export retry verifier', source: 'claude', project: 'system-verifiers', workstream: 'main' });
  });

  it('records nothing for an owner who turned it off, or an unknown project', async () => {
    const record = vi.fn();
    prisma.project.findUnique.mockResolvedValue({ name: 'p', instanceId: null, user: { id: 'u1', telemetryTitles: false } });
    await recordSessionTitle(change, record);
    prisma.project.findUnique.mockResolvedValue(null);
    await recordSessionTitle(change, record);
    expect(record).not.toHaveBeenCalled();
  });

  it('never throws on a failed lookup', async () => {
    prisma.project.findUnique.mockImplementation(async () => { throw new Error('db down'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const record = vi.fn();
    let threw: unknown = null;
    try { await recordSessionTitle(change, record); } catch (e) { threw = e; }
    expect(threw).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
