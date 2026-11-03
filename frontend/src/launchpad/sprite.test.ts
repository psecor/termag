// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@launchpad-ui/icons/sprite.svg?url', () => ({ default: '/assets/sprite.svg' }));

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="lp-icon-add"/></svg>';

async function fresh() {
  vi.resetModules();
  return import('./sprite');
}

afterEach(() => {
  document.getElementById('lp-icons-sprite')?.remove();
  vi.unstubAllGlobals();
});

describe('ensureLaunchPadSprite', () => {
  it('puts the sprite in the document once, hidden, however often it is asked', async () => {
    const fetch = vi.fn(async () => new Response(SVG, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { ensureLaunchPadSprite } = await fresh();
    await Promise.all([ensureLaunchPadSprite(), ensureLaunchPadSprite()]);
    await ensureLaunchPadSprite();
    expect(fetch).toHaveBeenCalledTimes(1);
    const svg = document.getElementById('lp-icons-sprite');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect((svg as SVGElement | null)?.style.display).toBe('none');
    expect(svg?.querySelector('#lp-icon-add')).not.toBeNull();
  });

  it('tries again on the next call after a failed fetch', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response(SVG, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { ensureLaunchPadSprite } = await fresh();
    await ensureLaunchPadSprite();
    expect(document.getElementById('lp-icons-sprite')).toBeNull();
    await ensureLaunchPadSprite();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(document.getElementById('lp-icons-sprite')).not.toBeNull();
  });
});
