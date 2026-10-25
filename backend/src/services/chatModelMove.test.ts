import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  project: { findMany: vi.fn(), update: vi.fn((a: unknown) => ({ op: 'project.update', a })) },
  workflow: { updateMany: vi.fn((a: unknown) => ({ op: 'workflow.updateMany', a })) },
  $transaction: vi.fn(async (ops: unknown[]) => ops),
}));
vi.mock('../db', () => ({ prisma }));

import { moveChatModelsToWorkflows } from './chatModelMove';

beforeEach(() => vi.clearAllMocks());

describe('moveChatModelsToWorkflows', () => {
  it("puts a project's tier on its chat rows that have no choice, and clears the project's in the same transaction", async () => {
    prisma.project.findMany.mockResolvedValue([{ id: 'p1', claudeModel: 'sonnet' }]);
    expect(await moveChatModelsToWorkflows()).toBe(1);
    expect(prisma.workflow.updateMany).toHaveBeenCalledWith({
      where: { projectId: 'p1', type: 'agent', provider: 'claude-chat', backend: null, model: null },
      data: { model: 'sonnet' },
    });
    expect(prisma.project.update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { claudeModel: null } });
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(2);
  });

  it('clears a value that is not a tier without copying it, and does nothing once every project is moved', async () => {
    prisma.project.findMany.mockResolvedValueOnce([{ id: 'p2', claudeModel: 'gpt' }]);
    await moveChatModelsToWorkflows();
    expect(prisma.workflow.updateMany).not.toHaveBeenCalled();
    expect(prisma.project.update).toHaveBeenCalledWith({ where: { id: 'p2' }, data: { claudeModel: null } });
    prisma.project.findMany.mockResolvedValueOnce([]);
    expect(await moveChatModelsToWorkflows()).toBe(0);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
