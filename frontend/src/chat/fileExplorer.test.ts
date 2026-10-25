import { describe, expect, it } from 'vitest';
import { ancestorDirs, fetchesText, fileShow, matchParts, searchFiles, svgDataUrl } from './fileExplorer';

const f = (space: string, path: string) => ({ space, path, size: 1, modifiedAt: null });

describe('searchFiles', () => {
  const files = [f('a', 'docs/plan.md'), f('a', 'plan/notes.txt'), f('b', 'deep/folder/plan-v2.md'), f('b', 'readme.md')];

  it('matches file names at any depth, never folder names', () => {
    expect(searchFiles(files, 'plan').map(x => x.path)).toEqual(['docs/plan.md', 'deep/folder/plan-v2.md']);
    expect(searchFiles(files, 'notes').map(x => x.path)).toEqual(['plan/notes.txt']);
    expect(searchFiles(files, 'folder')).toEqual([]);
    expect(searchFiles(files, 'PLAN md').map(x => x.path)).toEqual(['docs/plan.md', 'deep/folder/plan-v2.md']);
  });

  it('ranks the exact name, then names starting with the query, then shorter paths', () => {
    const more = [f('a', 'x/my-plan.md'), f('a', 'a/b/c/plan.md'), f('a', 'plans.md')];
    expect(searchFiles(more, 'plan').map(x => x.path)).toEqual(['a/b/c/plan.md', 'plans.md', 'x/my-plan.md']);
  });

  it('finds nothing for an empty query and caps the results', () => {
    expect(searchFiles(files, '  ')).toEqual([]);
    expect(searchFiles(files, 'md', 1)).toHaveLength(1);
  });
});

describe('matchParts', () => {
  it('marks every match of every word', () => {
    expect(matchParts('Plan-v2.plan.md', 'plan md')).toEqual([
      { text: 'Plan', hit: true }, { text: '-v2.', hit: false }, { text: 'plan', hit: true }, { text: '.', hit: false }, { text: 'md', hit: true },
    ]);
    expect(matchParts('readme', '')).toEqual([{ text: 'readme', hit: false }]);
  });
});

describe('ancestorDirs', () => {
  it('lists the root and each folder holding the file', () => {
    expect(ancestorDirs('README.md')).toEqual(['']);
    expect(ancestorDirs('a/b/c.txt')).toEqual(['', 'a/', 'a/b/']);
  });
});

describe('fileShow', () => {
  const text = 'text/plain; charset=utf-8';

  it('follows the server: frames its viewer types, fetches Markdown, HTML and SVG as text', () => {
    expect(fileShow({ contentType: 'application/pdf', render: 'frame' })).toEqual({ kind: 'frame' });
    for (const render of ['markdown', 'html', 'svg'] as const) {
      const show = fileShow({ contentType: text, render });
      expect(show).toEqual({ kind: render });
      expect(fetchesText(show)).toBe(true);
    }
    expect(fetchesText({ kind: 'frame' })).toBe(false);
  });

  it('downloads what has no viewer', () => {
    expect(fileShow(null)).toEqual({ kind: 'download' });
    expect(fetchesText({ kind: 'download' })).toBe(false);
  });
});

describe('svgDataUrl', () => {
  it('encodes the SVG so no character ends the URL or the attribute', () => {
    const url = svgDataUrl('<svg xmlns="http://www.w3.org/2000/svg"><text>#1 "a" 100%</text></svg>');
    expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(url).not.toMatch(/[#"<> ]/);
    expect(decodeURIComponent(url.slice(url.indexOf(',') + 1))).toContain('#1 "a" 100%');
  });
});
