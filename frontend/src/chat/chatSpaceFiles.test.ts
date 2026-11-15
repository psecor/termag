import { describe, expect, it, vi } from 'vitest';
import { keepChatFile, spaceAttachmentPath, spaceFileName, spaceUploadRefusal, type KeepChatFileDeps, type UploadProgress } from './chatSpaceFiles';
import { SPACE_ATTACHMENT_PATH_RE } from './chatTextFiles';

const NOW = new Date('2026-11-07T10:15:00.123Z');
const editor = { name: 'team-alpha', role: 'editor' as const, readOnly: false, usedBytes: 0, quotaBytes: 1_000_000_000 };
const file = (name: string, bytes = 10) => new File([new Uint8Array(bytes)], name);

describe('spaceFileName', () => {
  it('keeps a plain name and makes any other one safe to name in a shell', () => {
    expect(spaceFileName('report.zip')).toBe('report.zip');
    expect(spaceFileName('My Report (final).xlsx')).toBe('My-Report-_final_.xlsx');
    expect(spaceFileName('../../etc/passwd')).toBe('passwd');
    expect(spaceFileName('..\\..\\boot.ini')).toBe('boot.ini');
    expect(spaceFileName('$(rm -rf ~);`x`.zip')).not.toMatch(/[$`;()~ ]/);
    expect(spaceFileName('.env')).toBe('env');
    expect(spaceFileName('-rf')).toBe('rf');
    expect(spaceFileName('..')).toBe('file');
    expect(spaceFileName('')).toBe('file');
    expect(spaceFileName(`${'a'.repeat(300)}.zip`)).toHaveLength(120);
  });
});

describe('spaceAttachmentPath', () => {
  it('puts each chat\'s files under attachments/<workstream id>/<stamp>-<tag>/<name>', () => {
    const path = spaceAttachmentPath('cmw5tufc2fk19yivzd2ra02pc', 'logs dump.zip', NOW, 'a1b2c3');
    expect(path).toBe('attachments/cmw5tufc2fk19yivzd2ra02pc/20261107T101500Z-a1b2c3/logs-dump.zip');
    expect(SPACE_ATTACHMENT_PATH_RE.exec(path)?.[1]).toBe('logs-dump.zip');
  });

  it('never leaves the chat\'s folder, whatever the names', () => {
    const path = spaceAttachmentPath('../x/..', '../../../secret', NOW, 'zzzzzz');
    expect(path).toBe('attachments/___x___/20261107T101500Z-zzzzzz/secret');
    expect(path.split('/').some(seg => seg === '..' || seg === '.' || seg === '')).toBe(false);
  });

  it('gives two files attached in the same second different folders', () => {
    const a = spaceAttachmentPath('ws', 'a.zip', NOW);
    const b = spaceAttachmentPath('ws', 'a.zip', NOW);
    expect(a).not.toBe(b);
    expect(SPACE_ATTACHMENT_PATH_RE.test(a) && SPACE_ATTACHMENT_PATH_RE.test(b)).toBe(true);
  });
});

describe('spaceUploadRefusal', () => {
  it('takes a file in a space the person may write, with room for it', () => {
    expect(spaceUploadRefusal(editor, 10)).toBeNull();
    expect(spaceUploadRefusal({ ...editor, role: 'owner' }, 10)).toBeNull();
    // An older list without roles: the orchestrator decides.
    expect(spaceUploadRefusal({ ...editor, role: undefined }, 10)).toBeNull();
  });

  it('says why not where the person only reads it, or it is full', () => {
    expect(spaceUploadRefusal({ ...editor, role: 'viewer' }, 10)).toBe('you can only read team-alpha');
    expect(spaceUploadRefusal({ ...editor, readOnly: true }, 10)).toBe('you can only read team-alpha');
    expect(spaceUploadRefusal({ ...editor, usedBytes: 999_999_995 }, 10)).toMatch(/^team-alpha is full/);
  });
});

function deps(over: Partial<KeepChatFileDeps> = {}): KeepChatFileDeps {
  return {
    space: editor,
    workstreamId: 'ws1',
    toSpace: vi.fn(async (_s, _p, f: File, onProgress: (n: number) => void) => { onProgress(f.size); }),
    toBox: vi.fn(async (f: File) => ({ path: `.termag-attachments/0123456789abcdef/${f.name}`, name: f.name, size: f.size })),
    origin: 'https://app.example',
    base: '/termag/',
    now: () => NOW,
    ...over,
  };
}

describe('keepChatFile', () => {
  it('waits for the space while the list is still loading', async () => {
    let land!: (s: typeof editor) => void;
    const d = deps({ space: new Promise(r => { land = r; }) });
    const kept = keepChatFile(file('logs.zip'), () => {}, () => {}, d);
    await Promise.resolve();
    expect(d.toSpace).not.toHaveBeenCalled();
    expect(d.toBox).not.toHaveBeenCalled();
    land(editor);
    expect((await kept).space).toBe('team-alpha');
    expect(d.toBox).not.toHaveBeenCalled();
  });

  it('puts the file in the chat\'s space, new only, and links it', async () => {
    const d = deps();
    const seen: UploadProgress[] = [];
    const kept = await keepChatFile(file('logs.zip'), () => {}, p => seen.push(p), d);
    expect(d.toBox).not.toHaveBeenCalled();
    const [space, path, , , , condition] = (d.toSpace as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(space).toBe('team-alpha');
    expect(path).toMatch(/^attachments\/ws1\/20261107T101500Z-[0-9a-z]{6}\/logs\.zip$/);
    expect(condition).toEqual({ ifNoneMatch: '*' });
    expect(kept).toEqual({ path, name: 'logs.zip', size: 10, space: 'team-alpha', url: `https://app.example/termag/files/team-alpha/${path}` });
    expect(seen).toEqual([{ sent: 0, space: 'team-alpha' }, { sent: 10, space: 'team-alpha' }]);
  });

  it('keeps it on the box, as before, in a chat with no space', async () => {
    const d = deps({ space: null });
    const kept = await keepChatFile(file('logs.zip'), () => {}, () => {}, d);
    expect(d.toSpace).not.toHaveBeenCalled();
    expect(kept).toEqual({ path: '.termag-attachments/0123456789abcdef/logs.zip', name: 'logs.zip', size: 10 });
  });

  it('falls back to the box, saying why, where the person only reads the space', async () => {
    const viewer = { ...editor, role: 'viewer' as const };
    const d = deps({ space: viewer, current: vi.fn(async () => viewer) });
    const kept = await keepChatFile(file('logs.zip'), () => {}, () => {}, d);
    expect(d.current).toHaveBeenCalledWith('team-alpha');
    expect(d.toSpace).not.toHaveBeenCalled();
    expect(kept.space).toBeUndefined();
    expect(kept.fellBack).toBe('you can only read team-alpha');
  });

  it('asks for the space again where the list says it is full, and uses the room freed since', async () => {
    const d = deps({ space: { ...editor, usedBytes: 999_999_995 }, current: vi.fn(async () => ({ ...editor, usedBytes: 10 })) });
    const kept = await keepChatFile(file('logs.zip'), () => {}, () => {}, d);
    expect(d.current).toHaveBeenCalledWith('team-alpha');
    expect(d.toBox).not.toHaveBeenCalled();
    expect(kept.space).toBe('team-alpha');
  });

  it('takes the file where the person has been made an editor since the list loaded', async () => {
    const d = deps({ space: { ...editor, role: 'viewer' }, current: vi.fn(async () => editor) });
    expect((await keepChatFile(file('logs.zip'), () => {}, () => {}, d)).space).toBe('team-alpha');
    expect(d.toBox).not.toHaveBeenCalled();
  });

  it('keeps it on the box, with the fresh reason, where the space is still full', async () => {
    const d = deps({ space: { ...editor, usedBytes: 999_999_995 }, current: vi.fn(async () => ({ ...editor, usedBytes: 999_999_999 })) });
    const kept = await keepChatFile(file('logs.zip'), () => {}, () => {}, d);
    expect(d.toSpace).not.toHaveBeenCalled();
    expect(kept.fellBack).toMatch(/^team-alpha is full \(/);
  });

  it('does not ask again where the list already lets it in', async () => {
    const d = deps({ current: vi.fn(async () => editor) });
    await keepChatFile(file('logs.zip'), () => {}, () => {}, d);
    expect(d.current).not.toHaveBeenCalled();
  });

  it('tries the upload, and lets the orchestrator decide, where the space can\'t be asked again', async () => {
    const d = deps({ space: { ...editor, usedBytes: 999_999_995 }, current: vi.fn(async () => { throw new Error('offline'); }) });
    expect((await keepChatFile(file('logs.zip'), () => {}, () => {}, d)).space).toBe('team-alpha');
    expect(d.toSpace).toHaveBeenCalled();

    const refused = Object.assign(new Error('x'), { response: { status: 413, data: { error: 'Space quota exceeded' } } });
    const d2 = deps({ space: { ...editor, usedBytes: 999_999_995 }, toSpace: vi.fn(async () => { throw refused; }) });
    const kept = await keepChatFile(file('logs.zip'), () => {}, () => {}, d2);
    expect(kept.space).toBeUndefined();
    expect(kept.fellBack).toBe("team-alpha didn't take it: Space quota exceeded");
  });

  it('falls back to the box, saying why, when the orchestrator refuses the upload', async () => {
    const refused = Object.assign(new Error('Request failed with status code 413'), { response: { status: 413, data: { error: 'Space quota exceeded' } } });
    const seen: UploadProgress[] = [];
    const d = deps({ toSpace: vi.fn(async () => { throw refused; }) });
    const kept = await keepChatFile(file('logs.zip'), () => {}, p => seen.push(p), d);
    expect(kept.path).toBe('.termag-attachments/0123456789abcdef/logs.zip');
    expect(kept.fellBack).toBe("team-alpha didn't take it: Space quota exceeded");
    // The chip goes back to "uploading…" to the box.
    expect(seen.at(-1)).toEqual({ sent: 0, space: null });
  });

  it('says both when the box fails too', async () => {
    const d = deps({
      toSpace: vi.fn(async () => { throw Object.assign(new Error('x'), { response: { status: 403, data: {} } }); }),
      toBox: vi.fn(async () => { throw new Error('the box is gone'); }),
    });
    await expect(keepChatFile(file('logs.zip'), () => {}, () => {}, d)).rejects.toThrow("the box is gone (and team-alpha didn't take it: you can't write there)");
  });
});
