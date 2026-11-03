import { describe, expect, it } from 'vitest';
import { resolveSpaceImage } from './spaceImages';

const from = { space: 'improve-termag', path: 'artifacts/md-images/demo.md', origin: 'https://h.dev', base: '/termag/' };
const at = (dest: string) => resolveSpaceImage(dest, from);
const file = (path: string, space = 'improve-termag') => ({ kind: 'file', space, path });
const none = { kind: 'none' };

describe('resolveSpaceImage', () => {
  it('resolves a relative path against the Markdown file\'s folder', () => {
    expect(at('strip.png')).toEqual(file('artifacts/md-images/strip.png'));
    expect(at('./shots/a.png')).toEqual(file('artifacts/md-images/shots/a.png'));
    expect(at('../empty-box/1-simple-new-session-strip.png')).toEqual(file('artifacts/empty-box/1-simple-new-session-strip.png'));
    expect(at('../../top.png')).toEqual(file('top.png'));
    expect(at('a/../b//c.png')).toEqual(file('artifacts/md-images/b/c.png'));
  });

  it('decodes percent-encoding and drops a query or fragment', () => {
    expect(at('my%20shot.png')).toEqual(file('artifacts/md-images/my shot.png'));
    expect(at('a.png?v=2#top')).toEqual(file('artifacts/md-images/a.png'));
  });

  it('keeps a percent that encodes nothing as part of the name', () => {
    expect(at('100%.png')).toEqual(file('artifacts/md-images/100%.png'));
    expect(at('50%25%20off.png')).toEqual(file('artifacts/md-images/50% off.png'));
    expect(at('%E0%A4%A.png')).toEqual(file('artifacts/md-images/%E0%A4%A.png'));
    expect(at('improve-termag:shots/90%.png')).toEqual(file('shots/90%.png'));
  });

  it('reads a leading / from the space\'s root', () => {
    expect(at('/artifacts/e2e/x.png')).toEqual(file('artifacts/e2e/x.png'));
  });

  it('never climbs out of the space', () => {
    expect(at('../../../x.png')).toEqual(none);
    expect(at('../../../../other-space/x.png')).toEqual(none);
    expect(at('/../x.png')).toEqual(none);
    expect(at('..%2F..%2F..%2Fx.png')).toEqual(none);
    expect(at('a/../../../../x.png')).toEqual(none);
    expect(at('..\\..\\x.png')).toEqual(none);
    expect(at('..')).toEqual(none);
    expect(at('')).toEqual(none);
    // A Markdown file at the root has nowhere to climb.
    expect(resolveSpaceImage('../x.png', { ...from, path: 'demo.md' })).toEqual(none);
  });

  it('takes this space\'s space:path and file links', () => {
    expect(at('improve-termag:artifacts/e2e/x.png')).toEqual(file('artifacts/e2e/x.png'));
    expect(at('improve-termag:../x.png')).toEqual(none);
    expect(at('https://h.dev/termag/files/improve-termag/artifacts/a%20b.png')).toEqual(file('artifacts/a b.png'));
  });

  it('links another space\'s file without fetching it', () => {
    expect(at('notes:shots/a.png')).toEqual({ kind: 'link', href: 'https://h.dev/termag/files/notes/shots/a.png' });
    expect(at('https://h.dev/termag/files/notes/a.png')).toEqual({ kind: 'link', href: 'https://h.dev/termag/files/notes/a.png' });
  });

  it('links an external image without fetching it', () => {
    expect(at('https://x.dev/p.png')).toEqual({ kind: 'link', href: 'https://x.dev/p.png' });
    // Another termag's file link is external here.
    expect(at('https://other.dev/termag/files/improve-termag/a.png')).toEqual({ kind: 'link', href: 'https://other.dev/termag/files/improve-termag/a.png' });
  });

  it('keeps data: URLs, other schemes and scheme-relative URLs as alt text', () => {
    expect(at('data:image/png;base64,AAAA')).toEqual(none);
    expect(at('javascript:alert(1)')).toEqual(none);
    expect(at('blob:https://h.dev/x')).toEqual(none);
    expect(at('file:///etc/passwd')).toEqual(none);
    expect(at('//x.dev/p.png')).toEqual(none);
    expect(resolveSpaceImage('data:image/png;base64,AAAA', { ...from, space: 'data' })).toEqual(none);
  });
});
