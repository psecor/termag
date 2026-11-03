import { describe, expect, it } from 'vitest';
import { desktopPrHref, desktopSessionHref } from './desktopLinks';

describe('desktopPrHref', () => {
  it('is a termag desktop new-thread link naming the PR by its GitHub URL, as the desktop parses it', () => {
    const url = new URL(desktopPrHref('example-org/termag.desktop-x', 1047));
    expect(url.protocol).toBe('t3code:');
    expect(url.host).toBe('new');
    expect([...url.searchParams.keys()]).toEqual(['pr']);
    // The desktop's own match (packages/shared/src/promptLinks.ts, parsePromptLinkPullRequest).
    const match = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(url.searchParams.get('pr') ?? '');
    expect(match?.slice(1)).toEqual(['example-org', 'termag.desktop-x', '1047']);
  });
});

describe('desktopSessionHref', () => {
  it("is the desktop's link to the project of one of the person's own main sessions", () => {
    const href = desktopSessionHref({ projectId: 'cmvuu0pfi000cjr541gxau1b3', workstream: 'main', shared: false });
    // The desktop's own match (packages/termag/src/links.ts in termag desktop).
    expect(/^t3code:\/\/termag\/projects\/([A-Za-z0-9_-]{1,64})$/.exec(href ?? '')?.[1]).toBe('cmvuu0pfi000cjr541gxau1b3');
  });

  it('is null where the desktop would open something else, or nothing', () => {
    expect(desktopSessionHref({ projectId: 'p1', workstream: 'docs', shared: false })).toBeNull();
    expect(desktopSessionHref({ projectId: 'p1', workstream: 'main', shared: true })).toBeNull();
  });
});
