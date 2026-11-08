// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { decodeText, formatFileSize, queueJoinRefusal, MAX_CHAT_TEXT, MAX_TEXT_FILE_CHARS, messageTooLong, pastedTextFile, pastesAsFile, PASTE_AS_FILE_BREAKS, PASTE_AS_FILE_CHARS, prepareTextFile, splitTextFiles, textFileKind, withTextFiles } from './chatTextFiles';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('withTextFiles and splitTextFiles', () => {
  it('puts each file after the typed text as a fenced block headed with its name', () => {
    const message = withTextFiles('What is in these?', [{ name: 'data.csv', text: 'a,b\n1,2\n' }, { name: 'notes.md', text: '# Hi' }]);
    expect(message).toBe('What is in these?\n\nAttached file: data.csv\n```csv\na,b\n1,2\n\n```\n\nAttached file: notes.md\n```md\n# Hi\n```');
    expect(splitTextFiles(message)).toEqual({ text: 'What is in these?', files: [{ name: 'data.csv', text: 'a,b\n1,2\n' }, { name: 'notes.md', text: '# Hi' }] });
  });

  it('leaves a message with no files as it is', () => {
    expect(withTextFiles('hello', [])).toBe('hello');
    expect(splitTextFiles('hello')).toEqual({ text: 'hello', files: [] });
    // A mention of the heading in the middle of the text is not a file.
    expect(splitTextFiles('Attached file: x\nis what I said')).toEqual({ text: 'Attached file: x\nis what I said', files: [] });
  });

  it('takes files alone, and an empty file', () => {
    const message = withTextFiles('', [{ name: 'empty.txt', text: '' }, { name: 'Makefile', text: 'all:\n\techo hi\n' }]);
    expect(message.startsWith('Attached file: empty.txt\n```txt\n\n```')).toBe(true);
    expect(splitTextFiles(message)).toEqual({ text: '', files: [{ name: 'empty.txt', text: '' }, { name: 'Makefile', text: 'all:\n\techo hi\n' }] });
  });

  // Devin on #1476: a file came back with a newline it never had, or without the one it was.
  it('gives every file back exactly: no final newline, only a newline, blank lines, CRLF', () => {
    for (const text of ['x=1', '\n', '\n\n', 'a\n\n', '\nlead', 'a\r\nb\r\n', '``', '```']) {
      const message = withTextFiles('q', [{ name: 'f.txt', text }]);
      expect(splitTextFiles(message).files, JSON.stringify(text)).toEqual([{ name: 'f.txt', text }]);
    }
  });

  it('fences a file holding backticks with a longer fence, so nothing inside closes it', () => {
    const readme = 'Run:\n```sh\nnpm test\n```\n\nAttached file: fake\n````\nnot a file\n````\n';
    const message = withTextFiles('see', [{ name: 'README.md', text: readme }]);
    expect(message).toContain('\n`````md\n');
    expect(splitTextFiles(message)).toEqual({ text: 'see', files: [{ name: 'README.md', text: readme }] });
  });

  it('finds the files after a typed block that looks like one', () => {
    const typed = 'Attached file: mine\n```\nI typed this\n```\n\nand then a question';
    const message = withTextFiles(typed, [{ name: 'a.json', text: '{}' }]);
    expect(splitTextFiles(message)).toEqual({ text: typed, files: [{ name: 'a.json', text: '{}' }] });
  });

  it('keeps a file name to one bounded line', () => {
    const message = withTextFiles('', [{ name: 'bad\nname.txt', text: 'x' }]);
    expect(splitTextFiles(message).files[0].name).toBe('badname.txt');
  });
});

describe('box files', () => {
  const kept = { path: '.termag-attachments/0123456789abcdef/report.xlsx', size: 52_100 };
  it('names where the box keeps each one after the text files, and reads them back', () => {
    const message = withTextFiles('sum it', [{ name: 'a.csv', text: 'x' }], [kept]);
    expect(message).toBe('sum it\n\nAttached file: a.csv\n```csv\nx\n```\n\nAttached file on the box: .termag-attachments/0123456789abcdef/report.xlsx (52.1 KB)');
    expect(splitTextFiles(message)).toEqual({
      text: 'sum it', files: [{ name: 'a.csv', text: 'x' }],
      boxFiles: [{ name: 'report.xlsx', path: '.termag-attachments/0123456789abcdef/report.xlsx', size: '52.1 KB' }],
    });
    // Alone, and as a size read back again.
    const alone = withTextFiles('', [], [{ path: kept.path, size: '52.1 KB' }]);
    expect(splitTextFiles(alone)).toEqual({ text: '', files: [], boxFiles: [{ name: 'report.xlsx', path: kept.path, size: '52.1 KB' }] });
  });

  it('reads no line as a box file unless it names a kept path', () => {
    for (const line of ['Attached file on the box: /etc/passwd (1 KB)', 'Attached file on the box: .termag-attachments/../x (1 KB)', 'Attached file on the box: .termag-attachments/0123456789abcdef/a b (1 KB)']) {
      expect(splitTextFiles(`hi\n\n${line}`)).toEqual({ text: `hi\n\n${line}`, files: [] });
    }
  });

  it('never joins a queued message either way', () => {
    expect(queueJoinRefusal(withTextFiles('one', [], [kept]), 'two')).toMatch(/files go in a message of their own/);
    expect(queueJoinRefusal('one', withTextFiles('two', [], [kept]))).toMatch(/files go in a message of their own/);
  });
});

// Devin on #1476: a queue taken off as its prefix can't have files moved behind a message that joined it.
describe('queueJoinRefusal', () => {
  it('lets plain messages join, but none with files, and none past one message\'s length', () => {
    expect(queueJoinRefusal('first', 'second')).toBeNull();
    const a = withTextFiles('look', [{ name: 'a.md', text: '# A' }]);
    expect(queueJoinRefusal(a, 'and this')).toMatch(/files go in a message of their own/);
    expect(queueJoinRefusal('first', a)).toMatch(/files go in a message of their own/);
    expect(queueJoinRefusal('a'.repeat(MAX_CHAT_TEXT - 10), 'b'.repeat(20))).toMatch(/too long to send together/);
  });
});

describe('decodeText', () => {
  it('takes UTF-8 and refuses what is not text', () => {
    expect(decodeText(bytes('héllo ✓'))).toBe('héllo ✓');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x00, 0x41]))).toBeNull();
    // Valid UTF-8 with a NUL is a binary file.
    expect(decodeText(new Uint8Array([0x41, 0x00, 0x42]))).toBeNull();
    // A file's start may end inside a character.
    const check = bytes('✓');
    expect(decodeText(check.slice(0, 2), true)).toBe('');
    expect(decodeText(check.slice(0, 2))).toBeNull();
  });
});

describe('prepareTextFile', () => {
  it('reads a text file of any name, by its bytes', async () => {
    const f = await prepareTextFile(new File(['x = 1\r\ny = 2\r\n'], 'conf', { type: '' }));
    expect(f.name).toBe('conf');
    expect(f.text).toBe('x = 1\r\ny = 2\r\n');
    await expect(prepareTextFile(new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])], 'a.zip'))).rejects.toThrow("a.zip can't be attached: only text files, images and PDFs can");
  });

  it('says when a file is over the cap, or would not fit beside the others', async () => {
    const big = new File(['a'.repeat(MAX_TEXT_FILE_CHARS + 1)], 'big.log');
    await expect(prepareTextFile(big)).rejects.toThrow('big.log is 90.1 KB: text files go in the message up to 90 KB');
    const huge = new File(['a'.repeat(MAX_TEXT_FILE_CHARS * 4 + 1)], 'huge.log');
    await expect(prepareTextFile(huge)).rejects.toThrow('huge.log is 360.1 KB');
    await expect(prepareTextFile(new File(['abc'], 'c.txt'), 2)).rejects.toThrow("c.txt doesn't fit: a message's text files go in the message up to 90 KB in all");
  });
});

describe('labels', () => {
  it('names a chip by its extension', () => {
    expect(textFileKind('data.csv')).toBe('CSV');
    expect(textFileKind('a.yaml')).toBe('YAML');
    expect(textFileKind('Makefile')).toBe('TXT');
    expect(textFileKind('x.typescript')).toBe('TXT');
  });

  it('says sizes as Finder does', () => {
    expect(formatFileSize(900)).toBe('900 bytes');
    expect(formatFileSize(90_000)).toBe('90 KB');
    expect(formatFileSize(1_250_000)).toBe('1.3 MB');
  });

  it('says when a message is over what the send route takes', () => {
    expect(messageTooLong('a'.repeat(MAX_CHAT_TEXT))).toBeNull();
    expect(messageTooLong('a'.repeat(MAX_CHAT_TEXT + 1))).toMatch(/100,001 characters, over the 100,000/);
  });
});

describe('pasted text', () => {
  it('holds a paste as a file over PASTE_AS_FILE_CHARS characters or PASTE_AS_FILE_BREAKS line breaks', () => {
    expect(pastesAsFile('a short question')).toBe(false);
    expect(pastesAsFile('x'.repeat(PASTE_AS_FILE_CHARS))).toBe(false);
    expect(pastesAsFile('x'.repeat(PASTE_AS_FILE_CHARS + 1))).toBe(true);
    expect(pastesAsFile('a\n'.repeat(PASTE_AS_FILE_BREAKS))).toBe(false);
    expect(pastesAsFile('a\r\n'.repeat(PASTE_AS_FILE_BREAKS + 1))).toBe(true);
  });

  it('names a paste by its number and its line breaks, and keeps its text exactly', () => {
    const text = Array.from({ length: 40 }, (_, i) => `${i}:00 line`).join('\n');
    const first = pastedTextFile(text, []);
    expect(first.name).toBe('Pasted text #1 +39 lines');
    expect(first.text).toBe(text);
    expect(pastedTextFile('x'.repeat(2000), [first]).name).toBe('Pasted text #2');
    // Numbered after the highest held, so removing one never repeats a number still shown.
    expect(pastedTextFile(text, [{ name: 'notes.txt' }, { name: 'Pasted text #3 +1 lines' }]).name).toBe('Pasted text #4 +39 lines');
  });

  it('goes in the message whole and reads back as its chip', () => {
    const text = 'y'.repeat(50_000);
    const file = pastedTextFile(text, []);
    const message = withTextFiles('Summarize this', [file]);
    expect(messageTooLong(message)).toBeNull();
    expect(splitTextFiles(message)).toEqual({ text: 'Summarize this', files: [{ name: 'Pasted text #1', text }] });
    expect(textFileKind(file.name)).toBe('TXT');
  });
});
