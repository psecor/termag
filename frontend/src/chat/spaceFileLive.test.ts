import { describe, expect, it } from 'vitest';
import { effectOnFile, holdsOnChange, touchesSpace, type SpaceFileFrame } from './spaceFileLive';

const f = (x: Omit<SpaceFileFrame, 'type'>): SpaceFileFrame => ({ type: 'space-file', ...x });

describe('effectOnFile', () => {
  it('a put of this file is a change, with its version', () => {
    expect(effectOnFile(f({ space: 's', kind: 'put', path: 'a/b.md', etag: '"e"' }), 's', 'a/b.md')).toEqual({ kind: 'changed', etag: '"e"' });
    expect(effectOnFile(f({ space: 's', kind: 'put', path: 'a/c.md' }), 's', 'a/b.md')).toBeNull();
    expect(effectOnFile(f({ space: 't', kind: 'put', path: 'a/b.md' }), 's', 'a/b.md')).toBeNull();
  });

  it('a remove of this file or a folder above it is gone', () => {
    expect(effectOnFile(f({ space: 's', kind: 'rm', path: 'a/b.md' }), 's', 'a/b.md')).toEqual({ kind: 'gone' });
    expect(effectOnFile(f({ space: 's', kind: 'rm', path: 'a/' }), 's', 'a/b.md')).toEqual({ kind: 'gone' });
    expect(effectOnFile(f({ space: 's', kind: 'rm', path: 'a' }), 's', 'a/b.md')).toBeNull();
    expect(effectOnFile(f({ space: 's', kind: 'rm', path: 'ab/' }), 's', 'a/b.md')).toBeNull();
  });

  it('a move away is gone, with where it went; a move onto it is a change', () => {
    expect(effectOnFile(f({ space: 's', kind: 'mv', path: 'a/b.md', to: 'c.md' }), 's', 'a/b.md')).toEqual({ kind: 'gone', movedTo: 'c.md' });
    expect(effectOnFile(f({ space: 's', kind: 'mv', path: 'a/', to: 'z/a/' }), 's', 'a/b.md')).toEqual({ kind: 'gone', movedTo: 'z/a/b.md' });
    expect(effectOnFile(f({ space: 's', kind: 'mv', path: 'x.md', to: 'a/b.md' }), 's', 'a/b.md')).toEqual({ kind: 'changed' });
    expect(effectOnFile(f({ space: 's', kind: 'mv', path: 'y/', to: 'a/' }), 's', 'a/b.md')).toEqual({ kind: 'changed' });
    expect(effectOnFile(f({ space: 's', kind: 'mv', path: 'x.md', to: 'y.md' }), 's', 'a/b.md')).toBeNull();
  });

  it('a frame without paths, or a resync, means ask the server', () => {
    expect(effectOnFile(f({ space: 's', kind: 'mv' }), 's', 'a.md')).toEqual({ kind: 'check' });
    expect(effectOnFile(f({ resync: true }), 's', 'a.md')).toEqual({ kind: 'check' });
    expect(effectOnFile(f({ space: 't', kind: 'mv' }), 's', 'a.md')).toBeNull();
  });
});

describe('touchesSpace', () => {
  it('is its own space, or a resync', () => {
    expect(touchesSpace(f({ space: 's', kind: 'rm', path: 'x' }), 's')).toBe(true);
    expect(touchesSpace(f({ space: 't', kind: 'rm', path: 'x' }), 's')).toBe(false);
    expect(touchesSpace(f({ resync: true }), 's')).toBe(true);
  });
});

describe('holdsOnChange', () => {
  it('holds framed PDFs and players, not text, code, Markdown or images', () => {
    expect(holdsOnChange({ state: 'ok', show: { kind: 'frame' }, type: 'application/pdf' })).toBe(true);
    expect(holdsOnChange({ state: 'ok', show: { kind: 'frame' }, type: 'video/mp4' })).toBe(true);
    expect(holdsOnChange({ state: 'ok', show: { kind: 'frame' }, type: 'image/png' })).toBe(false);
    expect(holdsOnChange({ state: 'ok', show: { kind: 'frame' }, type: 'text/plain', text: 'x' })).toBe(false);
    expect(holdsOnChange({ state: 'ok', show: { kind: 'markdown' }, type: 'text/plain', text: 'x' })).toBe(false);
    expect(holdsOnChange({ state: 'gone' })).toBe(false);
  });
});
