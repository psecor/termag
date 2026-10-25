import { describe, expect, it } from 'vitest';
import { isBlankUrl, isFinalClose, reconnectDelayMs, suggestionLabel, suggestionToOpen, RECONNECT_MAX_MS, browserSocketParams, safeAtPath, browserHandoff } from './browserPaneConnection';
import { BROWSER_PANE_CLOSE } from './browserPaneInput';

describe('browser pane connection policy', () => {
  it('treats refusals as final and everything else as worth a retry', () => {
    expect(isFinalClose(BROWSER_PANE_CLOSE.DISABLED)).toBe(true);
    expect(isFinalClose(BROWSER_PANE_CLOSE.UNSUPPORTED)).toBe(true);
    expect(isFinalClose(BROWSER_PANE_CLOSE.PARKED)).toBe(true);
    expect(isFinalClose(1008)).toBe(true);
    expect(isFinalClose(1013)).toBe(false); // agent not connected: it comes back, and the browser is parked
    expect(isFinalClose(1006)).toBe(false);
    expect(isFinalClose(1000)).toBe(false);
    expect(isFinalClose(1011)).toBe(false);
    expect(isFinalClose(1001)).toBe(false);
  });

  it('backs off exponentially to a cap', () => {
    expect([0, 1, 2, 3, 4, 9].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, RECONNECT_MAX_MS, RECONNECT_MAX_MS]);
    expect(reconnectDelayMs(-3)).toBe(1000);
  });

  it('knows a blank pane', () => {
    expect(isBlankUrl('')).toBe(true);
    expect(isBlankUrl('about:blank')).toBe(true);
    expect(isBlankUrl(undefined)).toBe(true);
    expect(isBlankUrl('http://127.0.0.2/')).toBe(false);
  });

  it('opens the first suggestion and labels chips', () => {
    const items = [{ url: 'http://127.0.0.2/', title: 'Sign in', status: 200 }, { url: 'http://127.0.0.1:3000/', title: '' }];
    expect(suggestionToOpen(items)).toBe(items[0]);
    expect(suggestionToOpen([])).toBeNull();
    expect(suggestionLabel(items[0])).toBe('Sign in · 127.0.0.2');
    expect(suggestionLabel(items[1])).toBe('127.0.0.1:3000');
  });
});

describe('preview shares', () => {
  it('builds the owner\'s and the guest\'s socket query', () => {
    expect(browserSocketParams({ mode: 'owner', projectId: 'p1', workstream: 'feat' }, 'http://127.0.0.2/', { width: 800, height: 600 }))
      .toBe('projectId=p1&workstream=feat&url=http%3A%2F%2F127.0.0.2%2F&dialogs=1&width=800&height=600');
    expect(browserSocketParams({ mode: 'guest', shareId: 's1', at: '/flags', asGuest: true }, 'about:blank', { width: 800, height: 600 }))
      .toBe('share=s1&at=%2Fflags&as=guest&url=about%3Ablank&dialogs=1&width=800&height=600');
    expect(browserSocketParams({ mode: 'guest', shareId: 's1' }, 'about:blank', { width: 1, height: 2 })).toBe('share=s1&url=about%3Ablank&dialogs=1&width=1&height=2');
  });

  it('treats a guest\'s refusals as final and a busy box as worth a redial', () => {
    for (const code of [4410, 4424, 4500, 1008]) expect(isFinalClose(code), String(code)).toBe(true);
    expect(isFinalClose(4429)).toBe(false);
  });

  it('safeAtPath takes a path and nothing else', () => {
    expect(safeAtPath('/default/production/features/x')).toBe('/default/production/features/x');
    for (const bad of ['//evil.example', '/\\\\evil', '\\\\evil', '/%2F%2Fevil', 'https://evil.example/', 'javascript:alert(1)', '', null, undefined, '/a\tb']) {
      expect(safeAtPath(bad as string), String(bad)).toBeNull();
    }
  });

  it('reads the share link\'s handoff to the owner\'s own pane', () => {
    expect(browserHandoff('?project=p1&ws=feat&browser=open&browserShare=cshare0000000001&browserAt=%2Fflags'))
      .toEqual({ open: true, share: { shareId: 'cshare0000000001', at: '/flags' } });
    expect(browserHandoff('?project=p1&browser=open&browserShare=cshare0000000001&browserAt=%2F%2Fevil'))
      .toEqual({ open: true, share: { shareId: 'cshare0000000001', at: null } });
    expect(browserHandoff('?project=p1&browser=open&browserShare=../x')).toEqual({ open: true, share: null });
    expect(browserHandoff('?project=p1')).toBeNull();
  });

  it('an owner\'s share link rides the first dial: the share and its path', () => {
    const q = new URLSearchParams(browserSocketParams({ mode: 'owner', projectId: 'p1', workstream: 'main', openShare: { shareId: 'cshare0000000001', at: '/flags' } }, 'about:blank', { width: 800, height: 600 }));
    expect([q.get('openShare'), q.get('at'), q.get('projectId')]).toEqual(['cshare0000000001', '/flags', 'p1']);
    expect(new URLSearchParams(browserSocketParams({ mode: 'owner', projectId: 'p1', workstream: 'main' }, 'about:blank', { width: 800, height: 600 })).has('openShare')).toBe(false);
  });
});
