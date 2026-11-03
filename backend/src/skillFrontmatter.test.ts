import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { parseDocument } from 'yaml';

// Every SKILL.md that termag-reconcile installs (deploy/claude-skills,
// deploy/pi-skills, and any skill dir added under deploy/ later) has to have
// frontmatter that a strict YAML parser accepts. Claude Code reads it leniently,
// but pi parses it with the `yaml` package and refuses the whole skill on an
// error: an unquoted description containing ": " is read as a nested mapping
// ("Nested mappings are not allowed in compact mappings"), and pi starts with a
// [Skill conflicts] warning instead of the skill. This parses each file the way
// pi does (the same package, frontmatter cut out the same way), so a skill that
// pi would drop fails here first. Quote such a description (single quotes, with
// '' for an apostrophe) or use a folded block scalar.

const repo = resolve(__dirname, '../..');
const deploy = join(repo, 'deploy');

function skillFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : skillFiles(p);
    return e.name === 'SKILL.md' ? [p] : [];
  });
}

// pi's extractFrontmatter (pi-coding-agent dist/utils/frontmatter.js): the text
// between the opening `---` and the next line starting with `---`.
function frontmatter(content: string): string | null {
  const text = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  return end < 0 ? null : text.slice(4, end);
}

function frontmatterProblems(content: string): string[] {
  const yaml = frontmatter(content);
  if (yaml === null) return ['no --- frontmatter block'];
  const doc = parseDocument(yaml, { prettyErrors: true, strict: true, uniqueKeys: true });
  const problems = [...doc.errors, ...doc.warnings].map((e) => e.message);
  if (problems.length) return problems;
  const data = doc.toJS() as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return ['frontmatter is not a mapping'];
  for (const key of ['name', 'description']) {
    if (typeof data[key] !== 'string' || !(data[key] as string).trim()) problems.push(`${key} is not a non-empty string`);
  }
  return problems;
}

const files = skillFiles(deploy);

describe('SKILL.md frontmatter under deploy/ is strict YAML', () => {
  it('finds the shipped skills', () => {
    const rel = files.map((f) => relative(repo, f));
    expect(rel).toContain('deploy/claude-skills/termag-bug-report/SKILL.md');
    expect(rel).toContain('deploy/pi-skills/termag-bug-report/SKILL.md');
  });

  it('rejects an unquoted description containing ": "', () => {
    const bad = '---\nname: x\ndescription: Report a bug, including one you worked around: file it.\n---\nbody\n';
    expect(frontmatterProblems(bad).join('\n')).toMatch(/Nested mappings are not allowed in compact mappings/);
    const quoted = "---\nname: x\ndescription: 'Report a bug, including one you''ve worked around: file it.'\n---\nbody\n";
    expect(frontmatterProblems(quoted)).toEqual([]);
  });

  for (const file of files) {
    it(relative(repo, file), () => {
      const content = readFileSync(file, 'utf8');
      expect(frontmatterProblems(content)).toEqual([]);
      const name = parseDocument(frontmatter(content)!).get('name');
      expect(name).toBe(basename(dirname(file)));
    });
  }
});
