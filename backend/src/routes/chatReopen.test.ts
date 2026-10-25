import { describe, expect, it, vi } from 'vitest';
import type { UnarchiveWorkflow } from './unarchive';
import { relaunchChatOrRestore } from './chatReopen';

const agent: UnarchiveWorkflow = { type: 'agent', provider: 'claude-chat', workstream: 'main' };
const data: UnarchiveWorkflow = { type: 'data', provider: null, workstream: 'main' };

describe('relaunchChatOrRestore', () => {
  it('relaunches leftover agent and data workflows, and does not add an agent', async () => {
    const order: string[] = [];
    const result = await relaunchChatOrRestore({
      workflows: [data, agent],
      launchAgent: async wf => { order.push(`${wf.type}:${wf.workstream}`); },
      launchData: async wf => { order.push(`${wf.type}:${wf.workstream}`); },
      restore: async () => { order.push('restore'); },
    });
    expect(result).toEqual({ ok: true });
    expect(order).toEqual(['agent:main', 'data:main']);
  });

  it('restores the archived row when a launch throws, and does not continue', async () => {
    const order: string[] = [];
    const restore = vi.fn(async () => { order.push('restore'); });
    const result = await relaunchChatOrRestore({
      workflows: [agent, data],
      launchAgent: async () => { throw new Error('pane refused'); },
      launchData: async () => { order.push('data'); },
      restore,
    });
    expect(result).toEqual({ ok: false, error: 'pane refused' });
    expect(restore).toHaveBeenCalledOnce();
    expect(order).toEqual(['restore']);
  });

  it('still restores when a later data launch throws after the agent came up', async () => {
    const order: string[] = [];
    const result = await relaunchChatOrRestore({
      workflows: [agent, data],
      launchAgent: async () => { order.push('agent'); },
      launchData: async () => { throw new Error('data session missing'); },
      restore: async () => { order.push('restore'); },
    });
    expect(result).toEqual({ ok: false, error: 'data session missing' });
    expect(order).toEqual(['agent', 'restore']);
  });
});
