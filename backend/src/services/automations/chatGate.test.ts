import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ prisma: {} }));

import { runChatRefusal } from './chatGate';

describe('runChatRefusal', () => {
  it('leaves every other conversation alone', () => {
    expect(runChatRefusal({ projectKind: 'normal', workstream: 'run-20261020-0900', run: null })).toBeNull();
    expect(runChatRefusal({ projectKind: 'automation', workstream: 'main', run: null })).toBeNull();
    expect(runChatRefusal({ projectKind: undefined, workstream: 'feat', run: null })).toBeNull();
  });

  it('takes no message in a run before its row is linked, or while it is live', () => {
    expect(runChatRefusal({ projectKind: 'automation', workstream: 'run-20261020-0900', run: null })).toBe('run_starting');
    expect(runChatRefusal({ projectKind: 'automation', workstream: 'run-20261020-0900', run: { state: 'pending' } })).toBe('run_live');
    expect(runChatRefusal({ projectKind: 'automation', workstream: 'run-20261020-0900-2', run: { state: 'running' } })).toBe('run_live');
  });

  it('takes a follow-up once the run has finished', () => {
    for (const state of ['done', 'blocked', 'needs_input', 'failed', 'skipped']) {
      expect(runChatRefusal({ projectKind: 'automation', workstream: 'run-20261020-0900', run: { state } })).toBeNull();
    }
  });
});
