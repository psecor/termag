import { describe, expect, it } from 'vitest';
import { parseDotfilesRepoUrl } from './dotfilesUrl';

describe('parseDotfilesRepoUrl', () => {
  it('accepts and canonicalises GitHub HTTPS repository URLs', () => {
    expect(parseDotfilesRepoUrl('https://github.com/ada/dotfiles')).toEqual({
      ok: true,
      value: 'https://github.com/ada/dotfiles',
    });
    expect(parseDotfilesRepoUrl(' https://github.com/ada/dotfiles.git/ ')).toEqual({
      ok: true,
      value: 'https://github.com/ada/dotfiles',
    });
  });

  it('uses null and blank input to clear the preference', () => {
    expect(parseDotfilesRepoUrl(null)).toEqual({ ok: true, value: null });
    expect(parseDotfilesRepoUrl('  ')).toEqual({ ok: true, value: null });
  });

  it('rejects SSH and non-GitHub hosts', () => {
    expect(parseDotfilesRepoUrl('git@github.com:ada/dotfiles.git').ok).toBe(false);
    expect(parseDotfilesRepoUrl('https://gitlab.com/ada/dotfiles').ok).toBe(false);
  });

  it('rejects paths that do not name exactly one repository', () => {
    expect(parseDotfilesRepoUrl('https://github.com/ada').ok).toBe(false);
    expect(parseDotfilesRepoUrl('https://github.com/ada/dotfiles/tree/main').ok).toBe(false);
    expect(parseDotfilesRepoUrl('https://github.com/ada/dotfiles?tab=readme').ok).toBe(false);
  });
});
