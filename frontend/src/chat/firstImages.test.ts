import { beforeEach, describe, expect, it } from 'vitest';
import { ATTACHMENTS_ONLY, finishFirstMessage, firstMessageText, queuedFirstText } from './firstImages';

function memoryStore(refuse = false) {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { if (refuse) throw new Error('QuotaExceededError'); m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
  };
}

describe('a first message of attachments alone', () => {
  let store: ReturnType<typeof memoryStore>;
  beforeEach(() => { store = memoryStore(); });

  it('queues text as it is, and the stand-in only for attachments with no text', () => {
    expect(queuedFirstText(store, 'p1', 'look', 1)).toBe('look');
    expect(queuedFirstText(store, 'p1', '', 0)).toBe('');
    expect(queuedFirstText(store, 'p1', '  ', 2)).toBe(ATTACHMENTS_ONLY);
  });

  it('reads the stand-in as no text only in a queue marked for it, keeping what follows as typed', () => {
    expect(firstMessageText(store, 'p1', ATTACHMENTS_ONLY)).toBe(ATTACHMENTS_ONLY);
    queuedFirstText(store, 'p1', '', 1);
    expect(firstMessageText(store, 'p1', ATTACHMENTS_ONLY)).toBe('');
    expect(firstMessageText(store, 'p1', `${ATTACHMENTS_ONLY} one\n  two`)).toBe('one\n  two');
    expect(firstMessageText(store, 'p1', `say ${ATTACHMENTS_ONLY}`)).toBe(`say ${ATTACHMENTS_ONLY}`);
    expect(firstMessageText(store, 'p2', ATTACHMENTS_ONLY)).toBe(ATTACHMENTS_ONLY);
    finishFirstMessage(store, 'p1');
    expect(firstMessageText(store, 'p1', ATTACHMENTS_ONLY)).toBe(ATTACHMENTS_ONLY);
  });

  it('is not queued when storage would not keep its mark', () => {
    expect(queuedFirstText(memoryStore(true), 'p1', '', 1)).toBeNull();
  });
});
