import { describe, expect, it } from 'vitest';
import { ancestorDirs, fetchesText, fileCrumbs, foldedCrumbs, headerNeedsMenu, fileShow, matchParts, searchFiles, svgDataUrl } from './fileExplorer';

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

  it('of a folder prefix includes the folder itself', () => {
    expect(ancestorDirs('a/b/')).toEqual(['', 'a/', 'a/b/']);
  });
});

describe('fileCrumbs', () => {
  it('is the space, each folder with its tree prefix, then the file', () => {
    expect(fileCrumbs('improve-termag', 'artifacts/mcp-demo-video/README.md')).toEqual([
      { label: 'improve-termag', dir: '' },
      { label: 'artifacts', dir: 'artifacts/' },
      { label: 'mcp-demo-video', dir: 'artifacts/mcp-demo-video/' },
      { label: 'README.md', dir: null },
    ]);
  });

  it('is the space and the file for a file at the root', () => {
    expect(fileCrumbs('s', 'README.md')).toEqual([{ label: 's', dir: '' }, { label: 'README.md', dir: null }]);
  });

  it('skips empty segments but keeps them in the prefix, as the tree lists them', () => {
    expect(fileCrumbs('s', 'a//b.txt')).toEqual([{ label: 's', dir: '' }, { label: 'a', dir: 'a/' }, { label: 'b.txt', dir: null }]);
  });
});

describe('foldedCrumbs', () => {
  // space 100, folders 60 / 50 / 40, file 80: 330 in all; "…" is 20.
  const widths = [100, 60, 50, 40, 80];
  it('folds nothing when the path fits', () => {
    expect(foldedCrumbs(widths, 20, 330)).toBe(0);
  });
  it('folds the outer folders first, keeping the file\'s own folder longest', () => {
    expect(foldedCrumbs(widths, 20, 329)).toBe(1); // space / … / 50 / 40 / file = 290
    expect(foldedCrumbs(widths, 20, 290)).toBe(1);
    expect(foldedCrumbs(widths, 20, 289)).toBe(2); // space / … / 40 / file = 240
    expect(foldedCrumbs(widths, 20, 239)).toBe(3); // space / … / file = 200
    expect(foldedCrumbs(widths, 20, 200)).toBe(3);
  });
  it('folds the space too only when space / … / file overflows', () => {
    expect(foldedCrumbs(widths, 20, 199)).toBe(4); // … / file
    expect(foldedCrumbs(widths, 20, 50)).toBe(4);
  });
  it('folds only the space when the file is at the top of the space', () => {
    expect(foldedCrumbs([100, 80], 20, 180)).toBe(0);
    expect(foldedCrumbs([100, 80], 20, 179)).toBe(1);
  });
});

describe('headerNeedsMenu', () => {
  it('keeps the buttons while … / file fits beside them', () => {
    expect(headerNeedsMenu(456, 247, 132)).toBe(false); // 209 left
    expect(headerNeedsMenu(407, 247, 132)).toBe(false); // exactly 160
  });
  it('moves to ⋮ below the floor, even for a short name', () => {
    expect(headerNeedsMenu(406, 247, 60)).toBe(true);
    expect(headerNeedsMenu(284, 247, 132)).toBe(true); // 1024 with Tools open
  });
  it('moves to ⋮ sooner for a long name, before it would be cut', () => {
    expect(headerNeedsMenu(500, 247, 240)).toBe(false);
    expect(headerNeedsMenu(486, 247, 240)).toBe(true);
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
