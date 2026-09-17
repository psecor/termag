import { describe, it, expect } from 'vitest';
import { seedMetaTermFiles, SeedFs } from './metaterm';

// In-memory SeedFs: exercises the seeding rules without touching disk and
// stands in for both the local and the agent-backed adapters (same interface).
function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const dirs: string[] = [];
  const fs: SeedFs = {
    mkdir: async (d) => { dirs.push(d); },
    readFile: async (p) => files.get(p) ?? null,
    writeFile: async (p, c) => { files.set(p, c); },
  };
  return { fs, files, dirs };
}

describe('seedMetaTermFiles', () => {
  it('creates .claude/, .mcp.json, settings.json and CLAUDE.md on a fresh dir', async () => {
    const { fs, files, dirs } = memFs();
    await seedMetaTermFiles('/home/u/termag/projects/MetaTerm', fs);
    expect(dirs).toEqual(['/home/u/termag/projects/MetaTerm/.claude']);
    const mcp = JSON.parse(files.get('/home/u/termag/projects/MetaTerm/.mcp.json')!);
    expect(mcp.mcpServers.metaterm.command).toBe('node');
    expect(mcp.mcpServers.metaterm.args[0]).toMatch(/metaterm\/mcp-server\.mjs$/);
    const settings = JSON.parse(files.get('/home/u/termag/projects/MetaTerm/.claude/settings.json')!);
    expect(settings.permissions.allow).toContain('mcp__metaterm__list_sessions');
    expect(settings.permissions.allow).not.toContain('mcp__metaterm__send_keys');
    expect(files.get('/home/u/termag/projects/MetaTerm/CLAUDE.md')).toMatch(/^# MetaTerm/);
  });

  it('replaces the generic wiki CLAUDE.md pointer but keeps user edits', async () => {
    const dir = '/home/u/termag/projects/MetaTerm';
    const generic = memFs({ [`${dir}/CLAUDE.md`]: '@AGENTS.md\n' });
    await seedMetaTermFiles(dir, generic.fs);
    expect(generic.files.get(`${dir}/CLAUDE.md`)).toMatch(/^# MetaTerm/);

    const edited = memFs({ [`${dir}/CLAUDE.md`]: '# My own rules\n' });
    await seedMetaTermFiles(dir, edited.fs);
    expect(edited.files.get(`${dir}/CLAUDE.md`)).toBe('# My own rules\n');
  });

  it('always rewrites the config it owns (.mcp.json, settings.json)', async () => {
    const dir = '/home/u/termag/projects/MetaTerm';
    const m = memFs({ [`${dir}/.mcp.json`]: '{"stale":true}', [`${dir}/.claude/settings.json`]: '{"stale":true}' });
    await seedMetaTermFiles(dir, m.fs);
    expect(m.files.get(`${dir}/.mcp.json`)).not.toContain('stale');
    expect(m.files.get(`${dir}/.claude/settings.json`)).not.toContain('stale');
  });
});
