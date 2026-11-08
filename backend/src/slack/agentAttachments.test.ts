import { mkdtemp, mkdir, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { utimes } from 'fs/promises';
import { existsSync } from 'fs';
import {
  attachPromptBlocks, checkAttachment, createRunTempDir, isRunTempDir, offerAttachments, parseAttachValue, pruneRunTempDirs,
  RUN_DIR_TTL_MS, shareAttachment,
} from './agentAttachments';

let root: string;
let project: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'attach-test-'));
  project = join(root, 'project');
  outside = join(root, 'outside');
  await mkdir(join(project, 'out'), { recursive: true });
  await mkdir(join(project, '.secret'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(project, 'out', 'chart.png'), 'png');
  await writeFile(join(project, '.secret', 'leak.txt'), 'x');
  await writeFile(join(project, '.env.json'), '{}');
  await writeFile(join(project, 'id_rsa'), 'key');
  await writeFile(join(outside, 'other.png'), 'png');
  await symlink(join(outside, 'other.png'), join(project, 'out', 'link.png'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

// Only the project counts as a root here, so the temp-dir test fixture is "outside".
const check = (p: string) => checkAttachment(p, project, []);

describe('checkAttachment', () => {
  it('takes a file in the project, by relative or absolute path', async () => {
    expect(await check('out/chart.png')).toMatchObject({ ok: true, filename: 'chart.png' });
    expect(await check(join(project, 'out', 'chart.png'))).toMatchObject({ ok: true });
  });
  it('refuses files outside the roots, including through a symlink', async () => {
    expect(await check(join(outside, 'other.png'))).toMatchObject({ ok: false });
    expect(await check('out/link.png')).toMatchObject({ ok: false, reason: expect.stringContaining('outside') });
  });
  it('checks the type of the file a link points at, not the link\'s name', async () => {
    await writeFile(join(project, 'config.yaml'), 'secret: 1');
    await symlink(join(project, 'config.yaml'), join(project, 'out', 'notes.png'));
    expect(await check('out/notes.png')).toMatchObject({ ok: false, reason: expect.stringContaining('.yaml') });
  });
  it('refuses hidden files and directories', async () => {
    expect(await check('.secret/leak.txt')).toMatchObject({ ok: false, reason: expect.stringContaining('hidden') });
    expect(await check('.env.json')).toMatchObject({ ok: false });
  });
  it('refuses types that are not documents or images', async () => {
    expect(await check('id_rsa')).toMatchObject({ ok: false, reason: expect.stringContaining('not attached') });
    await writeFile(join(project, 'settings.json'), '{"token":"x"}');
    expect(await check('settings.json')).toMatchObject({ ok: false, reason: expect.stringContaining('.json') });
  });
  it('says when the file is missing', async () => {
    expect(await check('out/nope.png')).toEqual({ ok: false, reason: 'no such file' });
  });
});

describe('attachments wait for the person to share them', () => {
  function client() {
    return {
      chat: { postMessage: vi.fn(async (_a: any) => ({ ok: true })) },
      filesUploadV2: vi.fn(async (_a: any) => ({ ok: true })),
    };
  }

  it('offers an allowed file with its name and path, notes a refused one, and uploads nothing', async () => {
    const c = client();
    await offerAttachments(c as any, { channel: 'C1', threadTs: '1.0', paths: ['out/chart.png', 'id_rsa'], workingDir: project, forUser: 'U1' });
    expect(c.filesUploadV2).not.toHaveBeenCalled();
    const [offer, note] = c.chat.postMessage.mock.calls.map(call => call[0]);
    expect(offer.blocks[0].text.text).toContain('*chart.png*');
    expect(offer.blocks[0].text.text).toContain(join(project, 'out', 'chart.png').split('/').pop());
    const share = offer.blocks[1].elements[0];
    expect(share.action_id).toBe('agent_attach_share');
    expect(parseAttachValue(share.value)).toMatchObject({ forUser: 'U1', workingDir: project });
    expect(note.text).toContain("Couldn't attach `id_rsa`");
  });

  it('checks the file again when shared, and uploads it only then', async () => {
    const c = client();
    expect(await shareAttachment(c as any, { channel: 'C1', threadTs: '1.0', path: join(project, 'out', 'chart.png'), workingDir: project })).toBeNull();
    expect(c.filesUploadV2).toHaveBeenCalledWith(expect.objectContaining({ channel_id: 'C1', thread_ts: '1.0', filename: 'chart.png' }));
    expect(await shareAttachment(c as any, { channel: 'C1', threadTs: '1.0', path: join(project, 'out', 'gone.png'), workingDir: project })).toBe('no such file');
    expect(c.filesUploadV2).toHaveBeenCalledTimes(1);
  });

  it('puts who may decide, the path and the working directory in the buttons', () => {
    const [, actions] = attachPromptBlocks({ path: '/p/a.png', filename: 'a.png', size: 2048 }, 'U9', '/p');
    expect(actions.elements.map((e: any) => e.action_id)).toEqual(['agent_attach_share', 'agent_attach_skip']);
    expect(parseAttachValue(actions.elements[1].value)).toEqual({ forUser: 'U9', path: '/p/a.png', workingDir: '/p' });
  });
});


describe('per-run temp dirs', () => {
  it('creates a fresh, private directory per run', async () => {
    const base = await mkdtemp(join(root, 'base-'));
    const a = await createRunTempDir(base);
    const b = await createRunTempDir(base);
    expect(a).not.toEqual(b);
    expect(isRunTempDir(a, base)).toBe(true);
    const { stat } = await import('fs/promises');
    expect((await stat(a)).mode & 0o777).toBe(0o700);
  });

  it('takes a file only from the run\'s own temp dir, never the shared one or another run\'s', async () => {
    const base = await mkdtemp(join(root, 'base-'));
    const mine = await createRunTempDir(base);
    const theirs = await createRunTempDir(base);
    await writeFile(join(mine, 'mine.png'), 'png');
    await writeFile(join(theirs, 'theirs.png'), 'png');
    await writeFile(join(base, 'shared.png'), 'png');
    expect(await checkAttachment(join(mine, 'mine.png'), project, [mine])).toMatchObject({ ok: true });
    expect(await checkAttachment(join(theirs, 'theirs.png'), project, [mine])).toMatchObject({ ok: false });
    expect(await checkAttachment(join(base, 'shared.png'), project, [mine])).toMatchObject({ ok: false });
    // With no run dir, nothing in temp qualifies (the default no longer includes /tmp).
    expect(await checkAttachment(join(mine, 'mine.png'), project)).toMatchObject({ ok: false });
  });

  it('only accepts a run dir named by a Share button that really is one', () => {
    expect(isRunTempDir('/etc')).toBe(false);
    expect(isRunTempDir(join(tmpdir(), 'other'))).toBe(false);
    expect(isRunTempDir(join(tmpdir(), 'termag-slack-run-x', 'nested'))).toBe(false);
    expect(isRunTempDir(join(tmpdir(), 'termag-slack-run-abc'))).toBe(true);
  });

  it('prunes run dirs older than a day and keeps newer ones and anything else', async () => {
    const base = await mkdtemp(join(root, 'base-'));
    const old = await createRunTempDir(base);
    const fresh = await createRunTempDir(base);
    const other = join(base, 'not-ours');
    await mkdir(other);
    const past = (Date.now() - RUN_DIR_TTL_MS - 60_000) / 1000;
    await utimes(old, past, past);
    await utimes(other, past, past);
    await pruneRunTempDirs(base);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it('carries the run dir through the Share button, and leaves older buttons without one', () => {
    const [, withDir] = attachPromptBlocks({ path: '/t/a.png', filename: 'a.png', size: 1 }, 'U1', '/p', '/tmp/termag-slack-run-1');
    expect(parseAttachValue(withDir.elements[0].value)).toEqual({ forUser: 'U1', path: '/t/a.png', workingDir: '/p', runDir: '/tmp/termag-slack-run-1' });
    expect(parseAttachValue(JSON.stringify({ u: 'U1', p: '/p/a.png', w: '/p' }))).toEqual({ forUser: 'U1', path: '/p/a.png', workingDir: '/p' });
  });
});
