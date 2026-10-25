import { describe, expect, it } from 'vitest';
import { launchPath } from './launch';

const here = (pathname: string, search = '') => ({ origin: 'https://t.example', pathname, search });

describe('launchPath', () => {
  it('routes a shortcut into the open app', () => {
    expect(launchPath('https://t.example/termag/m/prs', here('/termag/m'))).toBe('/m/prs');
    expect(launchPath('https://t.example/termag/m?f=attention', here('/termag/m/p/abc'))).toBe('/m?f=attention');
  });

  it('routes a share with its query', () => {
    expect(launchPath('https://t.example/termag/m/share?title=&text=hi&url=', here('/termag/'))).toBe('/m/share?title=&text=hi&url=');
  });

  it('stays put when the page already shows it', () => {
    expect(launchPath('https://t.example/termag/m', here('/termag/m'))).toBeNull();
    expect(launchPath('https://t.example/termag/m?f=attention', here('/termag/m', '?f=attention'))).toBeNull();
  });

  it('ignores another origin, a path outside the app, and no URL', () => {
    expect(launchPath('https://evil.example/termag/m', here('/termag/m/prs'))).toBeNull();
    expect(launchPath('https://t.example/other', here('/termag/m'))).toBeNull();
    expect(launchPath(undefined, here('/termag/m'))).toBeNull();
    expect(launchPath('not a url', here('/termag/m'))).toBeNull();
  });
});
