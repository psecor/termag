import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

// The docs lists that many PRs add to. Each is kept sorted, so two PRs' new lines land in different
// places instead of both at the end, and these checks hold it there. The
// flag registries' order is checked in flags.test.ts.

const repo = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

// The first entry listed after one it sorts before, or null when the list is in order.
function outOfOrder(list: string[]): string | null {
  const at = list.findIndex((k, i) => i > 0 && k < list[i - 1]);
  return at < 0 ? null : `${list[at]} is listed after ${list[at - 1]}`;
}

// docs/agents/gotchas.md: each section is `<a id="<slug>"></a>` on the line above its `## ` heading.
const gotchasText = read('docs/agents/gotchas.md');
const headings = [...gotchasText.matchAll(/^(.*)\n## (.+)$/gm)].map((m) => ({ anchor: m[1], title: m[2] }));
const gotchas = headings.map((h) => ({ slug: h.anchor.match(/^<a id="([^"]+)"><\/a>$/)?.[1] ?? null, title: h.title }));

// AGENTS.md's index: `- [<slug>](docs/agents/gotchas.md#<slug>): <heading>` lines in its Gotchas section.
const agentsGotchas = read('AGENTS.md').match(/^## Gotchas\n([\s\S]*?)^## /m)?.[1] ?? '';
const index = [...agentsGotchas.matchAll(/^- \[([^\]]+)\]\(docs\/agents\/gotchas\.md#([^)]+)\): (.+)$/gm)]
  .map((m) => ({ text: m[1], slug: m[2], title: m[3] }));

describe('gotchas', () => {
  it('found them', () => {
    expect(gotchas.length).toBeGreaterThan(50);
  });

  it('gives every section a slug, an anchor of lowercase words joined by hyphens', () => {
    for (const g of gotchas) {
      expect(g.slug, `docs/agents/gotchas.md: "## ${g.title}" needs <a id="<area>-<subject>"></a> on the line above it`)
        .toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/);
    }
    const slugs = gotchas.map((g) => g.slug);
    expect(slugs.filter((s, i) => slugs.indexOf(s) !== i), 'docs/agents/gotchas.md: slugs used twice').toEqual([]);
  });

  it('keeps the sections in alphabetical order by slug', () => {
    const bad = outOfOrder(gotchas.map((g) => g.slug ?? ''));
    expect(bad, `docs/agents/gotchas.md: ${bad}; insert the gotcha where its slug sorts, not at the end`).toBeNull();
  });

  it('is indexed in AGENTS.md one line per gotcha, in the same order, with the heading as its lede', () => {
    for (const line of index) {
      expect(line.text, `AGENTS.md: the link to #${line.slug} reads ${line.text}`).toBe(line.slug);
    }
    const listed = index.map((l) => `${l.slug}: ${l.title}`);
    const expected = gotchas.map((g) => `${g.slug}: ${g.title}`);
    expect(listed, "AGENTS.md's Gotchas index must list docs/agents/gotchas.md's slugs and headings, in its order").toEqual(expected);
  });
});

describe('migration list in docs/agents/data-and-schema.md', () => {
  const block = read('docs/agents/data-and-schema.md').match(/^Migrations \(a selection\)[^\n]*\n((?:- .*\n)+)/m)?.[1] ?? '';
  const names = [...block.matchAll(/^- `\d+_([^`]+)`/gm)].map((m) => m[1].toLowerCase());

  it('found it', () => {
    expect(names.length).toBeGreaterThan(10);
  });

  it('is in alphabetical order by name, the timestamp left off', () => {
    const bad = outOfOrder(names);
    expect(bad, `docs/agents/data-and-schema.md: ${bad}; insert the migration where its name sorts`).toBeNull();
  });
});
