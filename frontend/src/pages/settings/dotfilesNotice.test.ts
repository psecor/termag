import { describe, expect, it } from 'vitest';
import { dotfilesNotice } from './dotfilesNotice';

describe('dotfilesNotice', () => {
  it('names the saved repository and says only new claims use it', () => {
    const text = dotfilesNotice('https://github.com/ada/dotfiles');
    expect(text).toContain('https://github.com/ada/dotfiles');
    expect(text).toMatch(/claim from now on/);
    expect(text).toMatch(/already have are not changed/);
  });

  it('says a cleared setting stops dotfiles on new claims', () => {
    expect(dotfilesNotice(null)).toMatch(/^Cleared\..*no dotfiles/);
  });
});
