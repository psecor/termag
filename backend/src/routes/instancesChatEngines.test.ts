import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));

import { chatEnginesView } from './instances';

describe('the box list says which chat engines its agent runs (chatEngines)', () => {
  it("names the ones its connected agent announced, and nothing while it isn't connected", () => {
    const agents: Record<string, { capabilities: readonly string[] }> = {
      new: { capabilities: ['chat-runner-v1', 'chat-cursor-v1', 'chat-devin-v1'] },
      old: { capabilities: ['chat-runner-v1', 'chat-cursor-v1'] },
    };
    const transport = (id: string) => agents[id] ?? null;
    expect(chatEnginesView('new', transport)).toEqual({ chatEngines: ['cursor', 'devin'] });
    expect(chatEnginesView('old', transport)).toEqual({ chatEngines: ['cursor'] });
    // Asleep or waking: nothing known, so the browser keeps Devin's pane there.
    expect(chatEnginesView('asleep', transport)).toEqual({});
  });
});
