import { describe, it, expect } from 'vitest';
import { draftAfterSend, flattenForSend, isSendKey, sendErrorText } from './compose';

describe('flattenForSend', () => {
  it('joins pasted lines with single spaces', () => {
    expect(flattenForSend('fix the bug\n  in app.ts\r\nand add a test')).toBe('fix the bug in app.ts and add a test');
  });
  it('trims, and a draft of only whitespace sends nothing', () => {
    expect(flattenForSend('  hello  ')).toBe('hello');
    expect(flattenForSend(' \n\n ')).toBe('');
  });
  it('leaves spaces inside a line alone', () => {
    expect(flattenForSend('a  b')).toBe('a  b');
  });
});

describe('draftAfterSend', () => {
  it('empties the box when nothing was typed during the send', () => {
    expect(draftAfterSend('fix the bug', 'fix the bug')).toBe('');
  });
  it('keeps what was typed after the sent text while it was in flight', () => {
    expect(draftAfterSend('fix the bugc', 'fix the bug')).toBe('c');
  });
  it('leaves a draft that was edited during the send alone', () => {
    expect(draftAfterSend('fix a bug', 'fix the bug')).toBe('fix a bug');
  });
});

describe('sendErrorText', () => {
  it('prefers the route error', () => {
    expect(sendErrorText({ response: { status: 503, data: { error: "Owner's agent is offline" } } })).toBe("Owner's agent is offline");
  });
  it('names a rate limit', () => {
    expect(sendErrorText({ response: { status: 429 } })).toBe('Too fast. Try again in a moment.');
  });
  it('falls back for anything else', () => {
    expect(sendErrorText(new Error('network'))).toBe('Send failed');
    expect(sendErrorText(null)).toBe('Send failed');
  });
});

describe('isSendKey', () => {
  it('sends on Enter and Ctrl/Cmd+Enter, not Shift+Enter or mid-composition', () => {
    expect(isSendKey({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(isSendKey({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(isSendKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
    expect(isSendKey({ key: 'a', shiftKey: false })).toBe(false);
  });
});
