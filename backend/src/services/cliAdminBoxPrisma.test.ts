import { describe, it, expect, vi, beforeEach } from 'vitest';

// The admin-box gate's share check (routes/cliAdminBox.ts) counts a share to
// anyone: the query names the box's projects and nothing about the sharee, so
// a project shared with another admin refuses the box too.
const findFirst = vi.fn();
vi.mock('../db', () => ({ prisma: { projectShare: { findFirst } } }));
const { prismaCliAdminBox } = await import('./cliAdminBoxPrisma');

beforeEach(() => findFirst.mockReset());

describe('prismaCliAdminBox.boxHasSharedProject', () => {
  it('looks for a share of any project on the box, whoever it is with', async () => {
    findFirst.mockResolvedValue({ id: 'share1' });
    expect(await prismaCliAdminBox.boxHasSharedProject('i-1')).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({ where: { project: { instanceId: 'i-1' } }, select: { id: true } });
  });

  it('is false when no project on the box is shared', async () => {
    findFirst.mockResolvedValue(null);
    expect(await prismaCliAdminBox.boxHasSharedProject('i-1')).toBe(false);
  });
});
