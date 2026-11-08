import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./agentRegistry', () => ({
  isProjectAgentConnected: () => true,
  sendForProject: async () => ({ sessions: ['ada-termag-agent', 'ada-termag-review', 'ada-termag-review-3'] }),
}));

const { collectSessionRows } = await import('./sessionInventory');

const project = {
  id: 'p1', name: 'termag', userId: 'u1', instanceId: 'box1', lastActiveAt: new Date('2026-10-27T00:00:00Z'),
  user: { unixUsername: 'ada' }, workstreams: [{ name: 'main' }], workflows: [{ provider: 'claude' }],
};

describe('collectSessionRows: review panes (docs/parallel-reviews.md)', () => {
  it('lists each live review slot as a review row with its slot, and no dead one', async () => {
    const rows = await collectSessionRows([{ p: project, access: 'owner' }]);
    const reviews = rows.filter(r => r.role === 'review');
    expect(reviews.map(r => [r.session, r.slot, r.alive])).toEqual([['ada-termag-review', 1, true], ['ada-termag-review-3', 3, true]]);
    // Other roles carry no slot; agent and ctrl are listed live or not.
    expect(rows.find(r => r.role === 'agent')).not.toHaveProperty('slot');
    expect(rows.find(r => r.role === 'ctrl')?.alive).toBe(false);
  });
});

describe('collectSessionRows: ask threads\' chats', () => {
  it('lists no pane rows for an ask chat, whose turns run in the chat runner with no tmux pane', async () => {
    const asked = { ...project, workstreams: [{ name: 'main', askThread: null }, { name: 'ask-cmvzxfb4u5hbxkz4bta4izuga', askThread: { id: 'cmvzxfb4u5hbxkz4bta4izuga' } }] };
    const rows = await collectSessionRows([{ p: asked, access: 'owner' }]);
    expect(rows.some(r => r.workstream.startsWith('ask-'))).toBe(false);
    expect(rows.filter(r => r.role === 'agent').map(r => r.workstream)).toEqual(['main']);
  });

  it('still lists a workstream that only looks like one (no thread behind it)', async () => {
    const lookalike = { ...project, workstreams: [{ name: 'main' }, { name: 'ask-abcdefgh12345678' }] };
    const rows = await collectSessionRows([{ p: lookalike, access: 'owner' }]);
    expect(rows.filter(r => r.role === 'agent').map(r => r.workstream)).toEqual(['main', 'ask-abcdefgh12345678']);
  });
});
