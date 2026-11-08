import { describe, expect, it } from 'vitest';
import { chatFileInput, chatFileName, chatFileRpcFailure } from './chatFiles';

describe('chatFileInput', () => {
  it('offers files with the flag on, on a box that takes them, outside an ask', () => {
    expect(chatFileInput(false, ['chat-files-v1'], false)).toEqual({ fileInput: false });
    expect(chatFileInput(true, ['chat-files-v1'], false)).toEqual({ fileInput: true });
  });

  it('says why not where the flag is on but the box or the chat cannot', () => {
    expect(chatFileInput(true, ['chat-runner-v1'], false)).toEqual({ fileInput: false, fileRefusal: "This box's agent can't take files yet; it needs an update and a restart" });
    expect(chatFileInput(true, ['chat-files-v1'], true)).toEqual({ fileInput: false, fileRefusal: "Files can't be attached in an ask's thread yet" });
  });
});

describe('chatFileName', () => {
  it('keeps a name to one bounded line, and refuses none', () => {
    expect(chatFileName('Q3 report.xlsx')).toBe('Q3 report.xlsx');
    expect(chatFileName('a\nb.zip')).toBe('ab.zip');
    expect(chatFileName('x'.repeat(300))).toHaveLength(200);
    expect(chatFileName('  ')).toBeNull();
    expect(chatFileName(['a'])).toBeNull();
  });
});

describe('chatFileRpcFailure', () => {
  it('says what the box refused, an old agent, and anything else', () => {
    expect(chatFileRpcFailure('file-refused: the file is larger than 20 MB')).toEqual({ status: 400, body: { error: 'The file is larger than 20 MB', code: 'file-refused' } });
    expect(chatFileRpcFailure('Unknown command: chat-file-put').body.code).toBe('files-unsupported');
    expect(chatFileRpcFailure('timeout')).toEqual({ status: 502, body: { error: 'The box did not keep the file: timeout', code: 'file-failed' } });
  });
});
