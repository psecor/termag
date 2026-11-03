// An ask finish notice's send answer (routes/chat.ts askNoticeSendResult): what
// a later tick can get past is handed back, the rest settles failed.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));

import { chatRpcFailure } from '../services/chatRunner';
import { askNoticeSendResult } from './chat';

describe('askNoticeSendResult', () => {
  it('is sent on a 202', () => {
    expect(askNoticeSendResult({ status: 202, body: { queued: true } })).toEqual({ kind: 'sent' });
  });

  it('tries again after a stop, a clear, a not-ready chat or a gateway error', () => {
    for (const m of ['chat-stopped: the chat was stopped before this message went in', 'chat-clearing: this chat is being stopped', 'chat-busy', 'queue-full', 'checkout-pending', 't3-busy: Claude is working on this in the desktop app']) {
      expect(askNoticeSendResult(chatRpcFailure(m))).toEqual({ kind: 'not-ready' });
    }
    expect(askNoticeSendResult(chatRpcFailure('socket hang up'))).toEqual({ kind: 'not-ready' });
    expect(askNoticeSendResult({ status: 409, body: { error: 'x', code: 'offline' } })).toEqual({ kind: 'not-ready' });
  });

  it('settles failed on a refusal that will not pass', () => {
    expect(askNoticeSendResult(chatRpcFailure('mode-refused'))).toEqual({ kind: 'refused', error: expect.stringContaining('trusted turn') });
    expect(askNoticeSendResult({ status: 404, body: null })).toEqual({ kind: 'refused', error: 'refused (404)' });
  });
});
