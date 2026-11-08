import { describe, expect, it } from 'vitest';
import { CHAT_EFFORT_CAPABILITY, chatEffortForSend, chatEffortFrom, chatEffortInput } from './chatEffort';

const capable = { capabilities: [CHAT_EFFORT_CAPABILITY], ask: false, backend: null };

describe('chatEffortFrom', () => {
  it('takes the five CLI levels and nothing else', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) expect(chatEffortFrom(level)).toBe(level);
    for (const raw of [undefined, null, '', 'default', 'HIGH', 'max;rm', 'extreme', 3, {}]) expect(chatEffortFrom(raw)).toBeNull();
  });
});

describe('chatEffortInput', () => {
  it('needs a runner with chat-effort-v1, and a chat on Claude\'s own models', () => {
    expect(chatEffortInput(capable)).toBe(true);
    expect(chatEffortInput({ ...capable, capabilities: ['chat-runner-v1'] })).toBe(false);
    expect(chatEffortInput({ ...capable, ask: true })).toBe(false);
    expect(chatEffortInput({ ...capable, backend: 'fireworks' })).toBe(false);
  });
});

describe('chatEffortForSend', () => {
  it('passes a level on, and drops it (never refuses) wherever the composer would offer none', () => {
    expect(chatEffortForSend('high', capable)).toBe('high');
    expect(chatEffortForSend('bogus', capable)).toBeNull();
    expect(chatEffortForSend(undefined, capable)).toBeNull();
    expect(chatEffortForSend('high', { ...capable, capabilities: [] })).toBeNull();
    expect(chatEffortForSend('max', { ...capable, backend: 'fireworks' })).toBeNull();
    expect(chatEffortForSend('max', { ...capable, ask: true })).toBeNull();
  });
});
