import { describe, it, expect } from 'vitest';
import { flattenForSend, sendErrorText } from './compose';

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
