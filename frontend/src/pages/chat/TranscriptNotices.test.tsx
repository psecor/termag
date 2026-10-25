// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatError, UnsentMessages } from './TranscriptNotices';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => { act(() => root.unmount()); });

describe('UnsentMessages', () => {
  it('shows each message Stop took back with its own Send and Discard', () => {
    const calls: string[] = [];
    act(() => root.render(<UnsentMessages texts={['one', 'two']} onSend={i => calls.push(`send ${i}`)} onDiscard={i => calls.push(`discard ${i}`)} />));
    expect([...host.querySelectorAll('.sdk-unsent .sdk-user-bubble')].map(b => b.textContent)).toEqual(['one', 'two']);
    expect(host.textContent).toContain('Not sent');
    act(() => (host.querySelectorAll<HTMLButtonElement>('.sdk-unsent-send')[1]).click());
    act(() => (host.querySelectorAll<HTMLButtonElement>('.sdk-unsent-discard')[0]).click());
    expect(calls).toEqual(['send 1', 'discard 0']);
  });

  it('can still discard while sending is not possible', () => {
    act(() => root.render(<UnsentMessages texts={['one']} disabled onSend={() => {}} onDiscard={() => {}} />));
    expect(host.querySelector<HTMLButtonElement>('.sdk-unsent-send')!.disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('.sdk-unsent-discard')!.disabled).toBe(false);
  });
});

describe('ChatError', () => {
  it('explains an overloaded API in plain words, keeps the raw text, and retries', () => {
    let retried = 0;
    act(() => root.render(<ChatError text='API Error: 529 {"type":"overloaded_error"}' onRetry={() => { retried++; }} />));
    expect(host.querySelector('.sdk-error-hint')!.textContent).toMatch(/overloaded/);
    expect(host.querySelector('.sdk-error-raw')!.textContent).toContain('529');
    act(() => host.querySelector<HTMLButtonElement>('.sdk-error-retry')!.click());
    expect(retried).toBe(1);
  });

  it('has no Retry when there is nothing to resend', () => {
    act(() => root.render(<ChatError text="Claude stopped (error_max_turns)" />));
    expect(host.querySelector('.sdk-error-retry')).toBeNull();
    expect(host.querySelector('.sdk-error-hint')).toBeNull();
  });
});
