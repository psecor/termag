// @vitest-environment jsdom
// The owner's Activity tab says where a Slack-originated event came from and
// whom the space's runner did it for.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ events: vi.fn() }));
vi.mock('../services/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/api')>()),
  spacesApi: {
    tree: vi.fn(async () => ({ prefix: '', dirs: [], files: [], nextCursor: null })),
    events: mocks.events,
    members: vi.fn(async () => ({
      members: [
        { userId: 'u1', email: 'alice@example.com', displayName: 'Alice', role: 'owner', addedAt: '' },
        { userId: 'u2', email: 'bob@example.com', displayName: 'Bob', role: 'editor', addedAt: '' },
      ],
      invites: [],
    })),
    boxes: vi.fn(async () => ({ boxes: [] })),
  },
}));

import { SpaceDialog } from './SpaceDialog';

let root: Root;
let container: HTMLDivElement;
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  mocks.events.mockReset();
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('SpaceDialog activity', () => {
  it('renders "via Slack, for <name>" for a Slack event, and an older event as before', async () => {
    mocks.events.mockResolvedValue({
      events: [
        { id: 'e2', at: '2026-11-04T10:00:00.000Z', action: 'slack.channel_link', path: null, bytes: null, actorUserId: 'u1', actorInstanceId: null, via: null, surface: 'slack', onBehalfOfUserId: 'u2' },
        { id: 'e1', at: '2026-11-03T10:00:00.000Z', action: 'file.put', path: 'notes.md', bytes: 5, actorUserId: 'u2', actorInstanceId: null, via: null, surface: null, onBehalfOfUserId: null },
      ],
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<SpaceDialog space={{ id: 's', name: 'team', description: null, createdAt: '', usedBytes: 0, quotaBytes: 1, role: 'owner' }} tab="activity" myBoxes={[]} userId="u1" onClose={() => {}} onChanged={() => {}} />);
    });
    await flush();
    const rows = [...container.querySelectorAll('.space-events li')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('.space-event-who')?.textContent).toBe('alice@example.com via Slack, for bob@example.com');
    expect(rows[0].querySelector('.space-event-what')?.textContent).toBe('linked a Slack channel');
    expect(rows[1].querySelector('.space-event-who')?.textContent).toBe('bob@example.com');
  });
});
