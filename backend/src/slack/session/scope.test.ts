import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claudeSessionFor, hydrateAgentThreads, rememberClaudeSession, resetAgentThreadsForTests, setAgentThreadStore,
  setThreadBinding, threadBindingOf, type AgentThreadStore,
} from '../agentSession';
import { isPersonalBinding, parseThreadScope, PERSONAL_BINDING } from './scope';

beforeEach(() => resetAgentThreadsForTests());

describe('thread scope', () => {
  it('parses stored scopes, and anything unknown is personal', () => {
    expect(parseThreadScope('space')).toBe('space');
    expect(parseThreadScope('router')).toBe('router');
    expect(parseThreadScope('personal')).toBe('personal');
    expect(parseThreadScope('admin')).toBe('personal');
    expect(parseThreadScope(null)).toBe('personal');
  });

  it('is personal for a thread nobody bound', () => {
    expect(threadBindingOf('C1:1.0')).toEqual(PERSONAL_BINDING);
    expect(isPersonalBinding(threadBindingOf('C1:1.0'))).toBe(true);
  });

  it('saves a binding through the store, and a personal one clears it', () => {
    const saveThread = vi.fn();
    setAgentThreadStore({ saveThread, saveDmLast: vi.fn() } as unknown as AgentThreadStore);
    try {
      setThreadBinding('C1:1.0', { scope: 'space', spaceId: 'sp', routeSeq: 2, frozenAt: null });
      expect(threadBindingOf('C1:1.0')).toMatchObject({ scope: 'space', spaceId: 'sp', routeSeq: 2 });
      expect(saveThread).toHaveBeenCalledWith('C1', '1.0', { scope: 'space', spaceId: 'sp', routeSeq: 2, frozenAt: null });
      setThreadBinding('C1:1.0', { ...PERSONAL_BINDING });
      expect(threadBindingOf('C1:1.0')).toEqual(PERSONAL_BINDING);
      expect(saveThread).toHaveBeenLastCalledWith('C1', '1.0', { scope: 'personal', spaceId: null, routeSeq: 0, frozenAt: null });
    } finally {
      setAgentThreadStore(null);
    }
  });

  it('hydrates bindings from rows, without replacing a live one', () => {
    const updatedAt = new Date();
    setThreadBinding('C2:1.0', { scope: 'router', spaceId: null, routeSeq: 1, frozenAt: null });
    hydrateAgentThreads([
      { channelId: 'C1', threadTs: '1.0', ownerSlackId: 'U', claudeSessionId: null, workingDir: null, resetAt: null, updatedAt, scope: 'space', spaceId: 'sp', routeSeq: 4, frozenAt: null },
      { channelId: 'C2', threadTs: '1.0', ownerSlackId: 'U', claudeSessionId: null, workingDir: null, resetAt: null, updatedAt, scope: 'space', spaceId: 'other', routeSeq: 9, frozenAt: null },
      // A row from before the columns existed.
      { channelId: 'C3', threadTs: '1.0', ownerSlackId: 'U', claudeSessionId: null, workingDir: null, resetAt: null, updatedAt },
    ], []);
    expect(threadBindingOf('C1:1.0')).toEqual({ scope: 'space', spaceId: 'sp', routeSeq: 4, frozenAt: null });
    expect(threadBindingOf('C2:1.0')).toMatchObject({ scope: 'router', routeSeq: 1 });
    expect(threadBindingOf('C3:1.0')).toEqual(PERSONAL_BINDING);
  });

  it('carries a DM\'s conversation over only within the same space binding', () => {
    setThreadBinding('D1:1.0', { scope: 'space', spaceId: 'sp', routeSeq: 0, frozenAt: null });
    rememberClaudeSession('D1:1.0', 's-space', '/p', 'D1');
    // A personal thread does not pick up a space thread's conversation...
    expect(claudeSessionFor('D1:2.0', '/p', 'D1')).toBeUndefined();
    // ...and a thread bound to the same space does.
    setThreadBinding('D1:3.0', { scope: 'space', spaceId: 'sp', routeSeq: 0, frozenAt: null });
    expect(claudeSessionFor('D1:3.0', '/p', 'D1')).toMatchObject({ sessionId: 's-space', carried: true });
  });
});
