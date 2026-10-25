import { describe, expect, it } from 'vitest';
import { actionLabel, breadcrumbs, collectDropped, formatBytes, nameError, parentPrefix, partRanges, prettyText, parseSpaceFileLink, previewKind, relPathError, roleAtLeast, spaceFileLink, SPACE_NAME_RE, type DropEntry } from './spaces';

describe('spaces helpers', () => {
  it('ranks roles', () => {
    expect(roleAtLeast('owner', 'editor')).toBe(true);
    expect(roleAtLeast('viewer', 'editor')).toBe(false);
    expect(roleAtLeast(undefined, 'viewer')).toBe(false);
    expect(roleAtLeast('admin', 'viewer')).toBe(false);
  });

  it('builds breadcrumbs from a prefix', () => {
    expect(breadcrumbs('team', '')).toEqual([{ name: 'team', prefix: '' }]);
    expect(breadcrumbs('team', 'a/b/')).toEqual([
      { name: 'team', prefix: '' }, { name: 'a', prefix: 'a/' }, { name: 'b', prefix: 'a/b/' },
    ]);
  });

  it('finds the parent folder', () => {
    expect(parentPrefix('a/b/c.txt')).toBe('a/b/');
    expect(parentPrefix('a/b/')).toBe('a/');
    expect(parentPrefix('c.txt')).toBe('');
  });

  it('checks names the way the backend normalizes paths', () => {
    expect(nameError('report.md')).toBeNull();
    expect(nameError(' ')).toMatch(/required/);
    expect(nameError('a/b')).toMatch(/\//);
    expect(nameError('..')).toMatch(/reserved/);
    expect(nameError('a\u0007')).toMatch(/control/);
    expect(nameError('é'.repeat(200))).toMatch(/too long/);
  });

  it('never previews script-capable types', () => {
    expect(previewKind('a/b.PNG')).toBe('image');
    expect(previewKind('doc.pdf')).toBe('pdf');
    expect(previewKind('notes.md')).toBe('text');
    expect(previewKind('logo.svg')).toBeNull();
    expect(previewKind('page.html')).toBeNull();
    expect(previewKind('Makefile')).toBeNull();
    expect(previewKind('.json')).toBeNull();
  });

  it('pretty-prints JSON and leaves other text alone', () => {
    expect(prettyText('a.json', '{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyText('a.json', '{oops')).toBe('{oops');
    expect(prettyText('a.txt', '{"a":1}')).toBe('{"a":1}');
  });

  it('splits an upload into numbered parts', () => {
    expect(partRanges(10, 4, 3)).toEqual([
      { partNumber: 1, start: 0, end: 4 }, { partNumber: 2, start: 4, end: 8 }, { partNumber: 3, start: 8, end: 10 },
    ]);
  });

  it('formats sizes and labels events', () => {
    expect(formatBytes(100 * 1024 ** 3)).toBe('100 GiB');
    expect(actionLabel('file.put')).toBe('uploaded');
    expect(actionLabel('file.put.signed')).toBe('started an upload of');
    expect(actionLabel('something.new')).toBe('something.new');
    expect(SPACE_NAME_RE.test('team-docs')).toBe(true);
    expect(SPACE_NAME_RE.test('Team')).toBe(false);
  });
});

describe('spaceFileLink', () => {
  it('builds the /files/ link under the base path, each segment encoded', () => {
    expect(spaceFileLink('https://app.example', '/termag/', 'assets', 'docs/My Report #1.pdf'))
      .toBe('https://app.example/termag/files/assets/docs/My%20Report%20%231.pdf');
    expect(spaceFileLink('https://app.example', '/termag', 'assets', 'a.png')).toBe('https://app.example/termag/files/assets/a.png');
  });
});

describe('collectDropped', () => {
  const file = (name: string): DropEntry => ({ name, isFile: true, isDirectory: false, file: ok => ok(new File(['x'], name)) });
  const dir = (name: string, children: DropEntry[], batch = 2): DropEntry => ({
    name, isFile: false, isDirectory: true,
    createReader: () => {
      let at = 0;
      return { readEntries: ok => { const b = children.slice(at, at + batch); at += b.length; ok(b); } };
    },
  });

  it('walks dropped folders, keeping each file under its folder, across reader batches', async () => {
    const got = await collectDropped([
      dir('site', [file('index.html'), dir('img', [file('a.png'), file('b.png'), file('c.png')]), file('a.png')]),
      file('notes.md'),
    ], []);
    expect(got.map(d => d.rel)).toEqual(['site/index.html', 'site/img/a.png', 'site/img/b.png', 'site/img/c.png', 'site/a.png', 'notes.md']);
    expect(got[0].file.name).toBe('index.html');
  });

  it('falls back to the plain file list without entries', async () => {
    const f = new File(['x'], 'a.txt');
    expect(await collectDropped([null], [f])).toEqual([{ file: f, rel: 'a.txt' }]);
    expect(await collectDropped([], [f])).toEqual([{ file: f, rel: 'a.txt' }]);
  });

  it('checks every segment of a relative path', () => {
    expect(relPathError('site/img/a.png')).toBeNull();
    expect(relPathError('site/../a.png')).toBe('That name is reserved');
  });
});

describe('parseSpaceFileLink', () => {
  const origin = 'https://host.example';
  it('reads back what spaceFileLink writes', () => {
    const link = spaceFileLink(origin, '/termag/', 'notes', 'a b/c#1.md');
    expect(parseSpaceFileLink(link, origin, '/termag/')).toEqual({ space: 'notes', path: 'a b/c#1.md' });
    expect(parseSpaceFileLink('/termag/files/notes/x.png', origin, '/termag')).toEqual({ space: 'notes', path: 'x.png' });
  });

  it('refuses other origins, other paths and bad names', () => {
    expect(parseSpaceFileLink('https://evil.example/termag/files/notes/x.md', origin, '/termag/')).toBeNull();
    expect(parseSpaceFileLink(`${origin}/termag/chat/files`, origin, '/termag/')).toBeNull();
    expect(parseSpaceFileLink(`${origin}/termag/files/notes`, origin, '/termag/')).toBeNull();
    expect(parseSpaceFileLink(`${origin}/termag/files/Bad_Name/x.md`, origin, '/termag/')).toBeNull();
    expect(parseSpaceFileLink(`${origin}/termag/files/notes/a//b`, origin, '/termag/')).toBeNull();
    expect(parseSpaceFileLink(`${origin}/termag/files/notes/%E0%A4%A`, origin, '/termag/')).toBeNull();
    expect(parseSpaceFileLink('mailto:a@b.c', origin, '/termag/')).toBeNull();
  });
});
