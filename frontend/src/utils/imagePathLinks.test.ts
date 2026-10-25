import { describe, expect, it } from 'vitest';
import { asciiRow, findImagePathLinks, imagePreviewUrl, RowText } from './imagePathLinks';

const COLS = 117;
const pad = (s: string) => s.padEnd(COLS, ' ');
const screen = (rows: string[]) => (r: number): RowText | undefined =>
  (r >= 0 && r < rows.length ? asciiRow(pad(rows[r])) : undefined);

// Verbatim from a Claude Code pane 117 columns wide.
const CLAUDE_WRAPPED = [
  '  Screenshots:',
  '  - Menu after typing b: /tmp/claude-1001/-home-termag-termag-projects-termag--worktrees-branch-shortcut/cf8049ab-daf',
  '    2-4c30-a9fa-e61a36060f47/scratchpad/pw/2-palette-b.png',
  '  - Form after Enter: /tmp/claude-1001/-home-termag-termag-projects-termag--worktrees-branch-shortcut/cf8049ab-daf2-4',
  '    c30-a9fa-e61a36060f47/scratchpad/pw/3-branch-off.png',
  '',
  '  The PR is up: https://github.com/example-org/termag/pull/477',
];
const SHOT_B = '/tmp/claude-1001/-home-termag-termag-projects-termag--worktrees-branch-shortcut/cf8049ab-daf2-4c30-a9fa-e61a36060f47/scratchpad/pw/2-palette-b.png';
const SHOT_C = '/tmp/claude-1001/-home-termag-termag-projects-termag--worktrees-branch-shortcut/cf8049ab-daf2-4c30-a9fa-e61a36060f47/scratchpad/pw/3-branch-off.png';

describe('findImagePathLinks', () => {
  it('finds a path on one row, with its columns', () => {
    const rows = screen(['Saved /tmp/shots/landing.png and done']);
    expect(findImagePathLinks(rows, 0, COLS)).toEqual([
      { path: '/tmp/shots/landing.png', start: { row: 0, col: 6 }, end: { row: 0, col: 27 } },
    ]);
  });

  it('joins a path Claude Code wrapped behind an indent, from either row', () => {
    const rows = screen(CLAUDE_WRAPPED);
    const expected = [{ path: SHOT_B, start: { row: 1, col: 25 }, end: { row: 2, col: 57 } }];
    expect(findImagePathLinks(rows, 1, COLS)).toEqual(expected);
    expect(findImagePathLinks(rows, 2, COLS)).toEqual(expected);
    expect(findImagePathLinks(rows, 3, COLS).map(l => l.path)).toEqual([SHOT_C]);
    expect(findImagePathLinks(rows, 4, COLS).map(l => l.path)).toEqual([SHOT_C]);
  });

  it('leaves URLs and plain text alone', () => {
    const rows = screen(CLAUDE_WRAPPED);
    expect(findImagePathLinks(rows, 0, COLS)).toEqual([]);
    expect(findImagePathLinks(rows, 6, COLS)).toEqual([]);
    expect(findImagePathLinks(screen(['see https://example.com/a/b.png']), 0, COLS)).toEqual([]);
    expect(findImagePathLinks(screen(['notes in /tmp/a.txt and /tmp/b.pngx']), 0, COLS)).toEqual([]);
  });

  it('takes ~/ paths, several per row, and any case of extension', () => {
    const rows = screen(['`~/shots/a.PNG`, (/tmp/b.jpeg) "/tmp/c.webp" /tmp/d.gif']);
    expect(findImagePathLinks(rows, 0, COLS).map(l => l.path)).toEqual([
      '~/shots/a.PNG', '/tmp/b.jpeg', '/tmp/c.webp', '/tmp/d.gif',
    ]);
  });

  it('does not join a row that stops short of the edge', () => {
    const rows = screen(['  - shot: /tmp/a/b', '    c.png']);
    expect(findImagePathLinks(rows, 0, COLS)).toEqual([]);
    expect(findImagePathLinks(rows, 1, COLS)).toEqual([]);
  });

  it('does not glue a whole path at the edge onto the next row', () => {
    const full = '/tmp/x/' + 'a'.repeat(COLS - 2 - 7 - 4) + '.png';
    const rows = screen([`  ${full}`, '    next.png is not part of it']);
    expect(findImagePathLinks(rows, 0, COLS).map(l => l.path)).toEqual([full]);
    expect(findImagePathLinks(rows, 1, COLS)).toEqual([]);
  });

  it('maps through wide cells to the right columns', () => {
    // "中" takes two cells, as in xterm.
    const text = '中 /tmp/a.png';
    const cells = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
    const rows = (r: number) => (r === 0 ? { text, cells } : undefined);
    expect(findImagePathLinks(rows, 0, COLS)).toEqual([
      { path: '/tmp/a.png', start: { row: 0, col: 3 }, end: { row: 0, col: 12 } },
    ]);
  });

  it('answers nothing past the buffer', () => {
    expect(findImagePathLinks(screen([]), 0, COLS)).toEqual([]);
  });
});

describe('imagePreviewUrl', () => {
  it('builds the image route with the workstream and the encoded path', () => {
    expect(imagePreviewUrl('p 1', undefined, '/tmp/a b.png'))
      .toBe('/termag/api/projects/p%201/image?workstream=main&path=%2Ftmp%2Fa+b.png');
    expect(imagePreviewUrl('p1', 'ws2', '~/a.png'))
      .toBe('/termag/api/projects/p1/image?workstream=ws2&path=%7E%2Fa.png');
  });
});
