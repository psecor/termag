import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildCloneCommand, parseRepoUrl, PROJECT_TEMPLATES, suggestProjectName, templateById, templateForRepoUrl } from './projectTemplates';

describe('parseRepoUrl', () => {
  it('accepts https and ssh GitHub forms, with or without .git', () => {
    expect(parseRepoUrl('https://github.com/example-org/webapp.git')).toMatchObject({ ok: true, owner: 'example-org', repo: 'webapp' });
    expect(parseRepoUrl('https://github.com/example-org/research')).toMatchObject({ ok: true, owner: 'example-org', repo: 'research' });
    expect(parseRepoUrl('git@github.com:psecor/dotfiles.git')).toMatchObject({ ok: true, owner: 'psecor', repo: 'dotfiles' });
    expect(parseRepoUrl('  https://github.com/o/r/  ')).toMatchObject({ ok: true, repo: 'r' });
  });

  it('rejects everything else, including shell-looking input', () => {
    expect(parseRepoUrl('https://gitlab.com/o/r')).toHaveProperty('ok', false);
    expect(parseRepoUrl("https://github.com/o/r'; rm -rf ~")).toHaveProperty('ok', false);
    expect(parseRepoUrl('github.com/o/r')).toHaveProperty('ok', false);
    expect(parseRepoUrl(42)).toHaveProperty('ok', false);
  });
});

describe('suggestProjectName', () => {
  it('uses the repo basename, sanitised for tmux and the filesystem', () => {
    expect(suggestProjectName('https://github.com/example-org/webapp.git')).toBe('webapp');
    expect(suggestProjectName('git@github.com:o/my.repo.git')).toBe('my-repo');
    expect(suggestProjectName('nonsense')).toBe('project');
  });
});

const MANAGED = { blankGlobalGitconfig: true } as const;

describe('buildCloneCommand', () => {
  it('fetches into the initialised repo and checks out the default branch', () => {
    const cmd = buildCloneCommand('https://github.com/example-org/research.git', undefined, MANAGED);
    expect(cmd).toBe(
      `{ GIT_CONFIG_GLOBAL=/dev/null git remote add origin 'https://github.com/example-org/research.git' 2>/dev/null || GIT_CONFIG_GLOBAL=/dev/null git remote set-url origin 'https://github.com/example-org/research.git'; } && GIT_CONFIG_GLOBAL=/dev/null git fetch --progress origin && GIT_CONFIG_GLOBAL=/dev/null git remote set-head origin -a && GIT_CONFIG_GLOBAL=/dev/null git checkout --track "$(GIT_CONFIG_GLOBAL=/dev/null git symbolic-ref --short refs/remotes/origin/HEAD)" && mkdir -p .git/info && { grep -qxF '/.worktrees/' .git/info/exclude 2>/dev/null || echo '/.worktrees/' >> .git/info/exclude; }`,
    );
    expect(cmd).not.toContain('alternates');
    expect(cmd).not.toContain('export GIT_CONFIG_GLOBAL');
  });

  it('borrows objects from a baked clone when given a reference dir, letting the pane expand $HOME', () => {
    const cmd = buildCloneCommand('https://github.com/example-org/webapp.git', '$HOME/src/webapp', MANAGED);
    // Double-quoted, so the box's shell expands $HOME; single quotes would make
    // the test look for a literal directory named $HOME and never fire.
    expect(cmd.startsWith('{ [ -d "$HOME/src/webapp/.git/objects" ]')).toBe(true);
    expect(cmd).toContain('echo "$HOME/src/webapp/.git/objects" >> .git/objects/info/alternates');
    expect(cmd).not.toContain("'$HOME");
    // The reference step never fails the chain when the clone is absent.
    expect(cmd).toContain('; true; } && { GIT_CONFIG_GLOBAL=/dev/null git remote add origin');
  });

  it('single-quotes the url so it is one shell word, and re-points an existing remote on retry', () => {
    const cmd = buildCloneCommand('https://github.com/o/r.git', undefined, MANAGED);
    expect(cmd).toContain("{ GIT_CONFIG_GLOBAL=/dev/null git remote add origin 'https://github.com/o/r.git' 2>/dev/null || GIT_CONFIG_GLOBAL=/dev/null git remote set-url origin 'https://github.com/o/r.git'; } && GIT_CONFIG_GLOBAL=/dev/null git fetch");
    expect(cmd.startsWith('(')).toBe(false);
  });

  it('leaves the global gitconfig alone for a host or external box', () => {
    const cmd = buildCloneCommand('https://github.com/o/r.git');
    expect(cmd).not.toContain('GIT_CONFIG_GLOBAL');
    expect(cmd).not.toContain('export ');
    expect(cmd.startsWith('(')).toBe(false);
    expect(cmd).toContain("{ git remote add origin 'https://github.com/o/r.git' 2>/dev/null || git remote set-url origin 'https://github.com/o/r.git'; } && git fetch --progress origin");
    expect(buildCloneCommand('https://github.com/o/r.git', undefined, { blankGlobalGitconfig: false })).toBe(cmd);
  });

  it('sets GIT_CONFIG_GLOBAL only for git, so the command after && does not see it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pane-checkout-'));
    try {
      const bin = join(dir, 'bin');
      const log = join(dir, 'git.log');
      mkdirSync(bin);
      writeFileSync(join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "\${GIT_CONFIG_GLOBAL-unset}" >> ${JSON.stringify(log)}
case " \$* " in
  *" symbolic-ref "*) printf '%s\\n' main ;;
esac
exit 0
`);
      chmodSync(join(bin, 'git'), 0o755);
      const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` };
      delete env.GIT_CONFIG_GLOBAL;
      const cmd = buildCloneCommand('https://github.com/o/r.git', undefined, MANAGED);
      const out = execFileSync('bash', ['-c', `${cmd} && printf 'agent:%s' "\${GIT_CONFIG_GLOBAL-unset}"`], {
        cwd: dir,
        env,
        encoding: 'utf8',
      });
      expect(out).toBe('agent:unset');
      const seen = readFileSync(log, 'utf8').trim().split('\n');
      expect(seen).toEqual(['/dev/null', '/dev/null', '/dev/null', '/dev/null', '/dev/null']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not hide a host or external credential helper behind /dev/null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pane-checkout-'));
    try {
      const bin = join(dir, 'bin');
      const log = join(dir, 'git.log');
      const gitconfig = join(dir, 'user.gitconfig');
      mkdirSync(bin);
      writeFileSync(gitconfig, '[credential]\n\thelper = store\n[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n');
      writeFileSync(join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "\${GIT_CONFIG_GLOBAL-unset}" >> ${JSON.stringify(log)}
case " \$* " in
  *" symbolic-ref "*) printf '%s\\n' main ;;
esac
exit 0
`);
      chmodSync(join(bin, 'git'), 0o755);
      const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, GIT_CONFIG_GLOBAL: gitconfig };
      const cmd = buildCloneCommand('https://github.com/o/r.git');
      execFileSync('bash', ['-c', cmd], { cwd: dir, env, encoding: 'utf8' });
      const seen = readFileSync(log, 'utf8').trim().split('\n');
      expect(seen).toEqual([gitconfig, gitconfig, gitconfig, gitconfig, gitconfig]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('templates', () => {
  it('has termag (with a baked reference), with a valid url', () => {
    expect(PROJECT_TEMPLATES.map(t => t.id)).toEqual(['termag']);
    for (const t of PROJECT_TEMPLATES) expect(parseRepoUrl(t.repoUrl)).toHaveProperty('ok', true);
    expect(templateById('termag')?.referenceDir).toBe('$HOME/src/termag');
    expect(templateById('nope')).toBeNull();
    expect(templateById(1)).toBeNull();
  });

  it('recognises a template from either spelling of its url', () => {
    expect(templateForRepoUrl('https://github.com/psecor/termag')?.id).toBe('termag');
    expect(templateForRepoUrl('git@github.com:PSecor/Termag.git')?.id).toBe('termag');
    expect(templateForRepoUrl('https://github.com/example-org/other.git')).toBeNull();
  });
});
