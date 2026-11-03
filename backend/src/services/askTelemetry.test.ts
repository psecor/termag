import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../db';
import { askTelemetry, askTelemetryFor } from './askTelemetry';

vi.mock('../db', () => ({ prisma: { project: { findUnique: vi.fn() } } }));

const findUnique = vi.mocked(prisma.project.findUnique);

const SID = '0b7c2f7e-1c1d-4c55-9a43-2f0e6d1b8a10';

describe('askTelemetry', () => {
  it('names the thread, the hop and the parent session in full', () => {
    expect(askTelemetry({ id: 'thr1', parentProjectId: 'p1', parentWorkstream: 'main', parentClaudeSession: SID }, { project: 'termag', box: 'devbox' }, 3))
      .toEqual({ thread: 'thr1', hop: 3, parent: { project: 'termag', workstream: 'main', box: 'devbox', session: SID } });
  });

  it("leaves out what is not known: a person's turn has no hop, a laptop asker no project or box", () => {
    expect(askTelemetry({ id: 'thr1', parentClaudeSession: SID }, null)).toEqual({ thread: 'thr1', parent: { session: SID } });
    expect(askTelemetry({ id: 'thr1' }, null, 1)).toEqual({ thread: 'thr1', hop: 1 });
    expect(askTelemetry({ id: 'thr1', parentProjectId: 'p1', parentWorkstream: 'main' }, { project: 'termag', box: null }))
      .toEqual({ thread: 'thr1', parent: { project: 'termag', workstream: 'main' } });
    expect(askTelemetry({ id: 'thr1', parentProjectId: 'p1', parentWorkstream: null }, { project: 'termag', box: 'devbox' }), 'no workstream, no pair').toEqual({ thread: 'thr1' });
    expect(askTelemetry({ id: 'thr1' }, null, 0)).toEqual({ thread: 'thr1' });
  });
});

describe('askTelemetryFor', () => {
  beforeEach(() => { findUnique.mockReset(); });

  it("reads the parent project's current name and box", async () => {
    findUnique.mockResolvedValue({ name: 'termag', instance: { name: 'devbox' } } as never);
    expect(await askTelemetryFor({ id: 'thr1', parentProjectId: 'p1', parentWorkstream: 'main', parentClaudeSession: null }, 2))
      .toEqual({ thread: 'thr1', hop: 2, parent: { project: 'termag', workstream: 'main', box: 'devbox' } });
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'p1' } }));
  });

  it('never reads without a parent project, and a gone project only drops the parent', async () => {
    expect(await askTelemetryFor({ id: 'thr1', parentClaudeSession: SID })).toEqual({ thread: 'thr1', parent: { session: SID } });
    expect(findUnique).not.toHaveBeenCalled();
    findUnique.mockResolvedValue(null);
    expect(await askTelemetryFor({ id: 'thr1', parentProjectId: 'p1', parentWorkstream: 'main' }, 1)).toEqual({ thread: 'thr1', hop: 1 });
  });

  it('a failed read only drops the parent', async () => {
    findUnique.mockRejectedValue(new Error('db down'));
    const r = await askTelemetryFor({ id: 'thr1', parentProjectId: 'p1', parentWorkstream: 'main' }, 1);
    expect(r).toEqual({ thread: 'thr1', hop: 1 });
  });
});
