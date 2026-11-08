import { describe, expect, it } from 'vitest';
import { SPRITE_MESSAGE, readSpriteMessage, spriteDocument } from './spriteFrame';

const source = `const A = 1;\nexport default { opacity: 0.5, create: () => ({ draw() {} }) };\n`;

describe('spriteDocument', () => {
  const doc = spriteDocument(source, { palette: 'dark', reducedMotion: false }, 'abc123');

  it('allows only its own nonce, and no network at all', () => {
    expect(doc).toContain(`content="default-src 'none'; script-src 'nonce-abc123'; style-src 'unsafe-inline'"`);
    expect(doc).not.toMatch(/connect-src|img-src|font-src|unsafe-eval/);
    expect(doc.match(/<script nonce="abc123">/g)).toHaveLength(3);
    expect(doc).not.toMatch(/<script(?! nonce="abc123")/);
  });

  it("turns the sprite's export default into window.__dailySprite, in a script between the guard and the runner", () => {
    const scripts = [...doc.matchAll(/<script nonce="abc123">([\s\S]*?)<\/script>/g)].map(m => m[1]);
    expect(scripts[0]).toMatch(/addEventListener\('error'/);
    expect(scripts[1]).toContain('window.__dailySprite = { opacity: 0.5');
    expect(scripts[1]).not.toContain('export default');
    expect(scripts[2]).toContain('window.__dailySprite');
    expect(scripts[2]).toContain('!document.hidden');
  });

  it("can't be closed early by a </script in the sprite", () => {
    const evil = spriteDocument(`export default { s: "</script><script>alert(1)</script>" };`, { palette: 'light', reducedMotion: true }, 'n');
    // Inside a script element only </script ends it; the sprite's is escaped, so three close.
    expect(evil.match(/<\/script>/g)).toHaveLength(3);
    expect(evil).toContain('color-scheme: light');
  });

  it('strips anything but word characters from the nonce', () => {
    expect(spriteDocument(source, { palette: 'dark', reducedMotion: false }, `a"><b`)).toContain(`nonce="ab"`);
  });
});

describe('readSpriteMessage', () => {
  it('reads ready and stopped, and nothing else', () => {
    expect(readSpriteMessage({ source: SPRITE_MESSAGE, type: 'ready', opacity: 0.4 })).toEqual({ type: 'ready', opacity: 0.4 });
    expect(readSpriteMessage({ source: SPRITE_MESSAGE, type: 'ready', opacity: 'x' })).toEqual({ type: 'ready', opacity: null });
    expect(readSpriteMessage({ source: SPRITE_MESSAGE, type: 'stopped', why: 'x'.repeat(500) })).toEqual({ type: 'stopped', why: 'x'.repeat(200) });
    expect(readSpriteMessage({ source: SPRITE_MESSAGE, type: 'navigate', url: '/x' })).toBeNull();
    expect(readSpriteMessage({ type: 'ready' })).toBeNull();
    expect(readSpriteMessage('ready')).toBeNull();
  });
});
