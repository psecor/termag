import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { APP_START_PATH, appStartTarget, launchPath } from './launch';

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

  it('stays put for the app icon (start_url) wherever the window is', () => {
    expect(launchPath('https://t.example/termag/app', here('/termag/chat'))).toBeNull();
    expect(launchPath('https://t.example/termag/app', here('/termag/m/prs'))).toBeNull();
  });

  it('ignores another origin, a path outside the app, and no URL', () => {
    expect(launchPath('https://evil.example/termag/m', here('/termag/m/prs'))).toBeNull();
    expect(launchPath('https://t.example/other', here('/termag/m'))).toBeNull();
    expect(launchPath(undefined, here('/termag/m'))).toBeNull();
    expect(launchPath('not a url', here('/termag/m'))).toBeNull();
  });
});

describe('appStartTarget', () => {
  const app = { standalone: true };

  it('opens the phone client on a touch device, flag or not', () => {
    expect(appStartTarget({ ...app, touch: true, simpleUi: true })).toBe('/m');
    expect(appStartTarget({ ...app, touch: true, simpleUi: false })).toBe('/m');
  });

  it('opens the simple UI on a desktop, or the workspace without simple-ui-enabled', () => {
    expect(appStartTarget({ ...app, touch: false, simpleUi: true })).toBe('/chat');
    expect(appStartTarget({ ...app, touch: false, simpleUi: false })).toBe('/');
  });

  it('is the workspace URL in a browser tab, so its own redirect and opt-out apply', () => {
    expect(appStartTarget({ standalone: false, touch: true, simpleUi: true })).toBe('/');
    expect(appStartTarget({ standalone: false, touch: false, simpleUi: true })).toBe('/');
  });
});

describe('manifest', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../public/manifest.webmanifest', import.meta.url), 'utf8'));

  it('launches at the AppStart route', () => {
    expect(manifest.start_url).toBe(`/termag${APP_START_PATH}`);
  });

  it('keeps the id existing installs were made with', () => {
    expect(manifest.id).toBe('/termag/m');
  });
});
