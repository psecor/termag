import { describe, expect, it } from 'vitest';
import { chatModelFromWire } from './composer';
import { chatModelCanChoose, chatModelView } from './useChatModel';

describe('chatModelView', () => {
  it('does not guess a tier before the session\'s model is known', () => {
    expect(chatModelView(null, null)).toBeNull();
    expect(chatModelView(null, 'sonnet')).toBe('sonnet');
    expect(chatModelView('haiku', 'sonnet')).toBe('haiku');
    expect(chatModelView('opus', null)).toBe('opus');
  });
});

describe('chatModelCanChoose', () => {
  it('refuses a choice until history has reported the current model', () => {
    expect(chatModelCanChoose(false)).toBe(false);
    expect(chatModelCanChoose(true)).toBe(true);
  });
});

describe('chatModelFromWire', () => {
  it('accepts the three tiers and nothing else', () => {
    expect(chatModelFromWire('opus')).toBe('opus');
    expect(chatModelFromWire('sonnet')).toBe('sonnet');
    expect(chatModelFromWire(undefined)).toBeNull();
    expect(chatModelFromWire('auto')).toBeNull();
    expect(chatModelFromWire('gpt')).toBeNull();
  });
});
