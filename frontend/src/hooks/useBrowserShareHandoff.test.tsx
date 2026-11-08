// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserShareHandoff } from './useBrowserShareHandoff';

let root: Root;
let el: HTMLDivElement;
let got: ReturnType<typeof useBrowserShareHandoff> | null = null;
const expandDock = vi.fn();
const showCtrl = vi.fn();

function Probe({ browserKey, isNarrow }: { browserKey: string; isNarrow: boolean }) {
  got = useBrowserShareHandoff({ browserKey, isNarrow, expandDock, showCtrl });
  return null;
}
const render = (browserKey: string, isNarrow = false) => act(() => root.render(<Probe browserKey={browserKey} isNarrow={isNarrow} />));

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  expandDock.mockReset();
  showCtrl.mockReset();
  got = null;
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); window.history.replaceState(null, '', '/'); });

describe('useBrowserShareHandoff', () => {
  it('opens the dock once the project is known, drops the link\'s parameters, and keeps the share for one dial', () => {
    window.history.replaceState(null, '', '/termag/?project=p1&ws=main&browser=open&browserShare=cshare0000000001&browserAt=%2Fflags');
    render('');
    expect(expandDock).not.toHaveBeenCalled();
    render('p1/main');
    expect(expandDock).toHaveBeenCalledWith('p1/main');
    expect(showCtrl).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?project=p1&ws=main');
    expect(got!.openShare).toEqual({ shareId: 'cshare0000000001', at: '/flags' });
    // The pane's dial carried it: spent, so a later reopen of the dock lands where the owner left off.
    act(() => got!.consumeOpenShare());
    expect(got!.openShare).toBeNull();
    render('p1/main');
    render('p2/main');
    expect(expandDock).toHaveBeenCalledTimes(1);
  });

  it('brings the ctrl tab forward on a narrow viewport, where the dock lives', () => {
    window.history.replaceState(null, '', '/termag/?project=p1&browser=open&browserShare=cshare0000000001');
    render('p1/main', true);
    expect(showCtrl).toHaveBeenCalledTimes(1);
    expect(got!.openShare).toEqual({ shareId: 'cshare0000000001', at: null });
  });

  it('does nothing for a URL that asks for nothing', () => {
    window.history.replaceState(null, '', '/termag/?project=p1');
    render('p1/main', true);
    expect(expandDock).not.toHaveBeenCalled();
    expect(showCtrl).not.toHaveBeenCalled();
    expect(got!.openShare).toBeNull();
    expect(window.location.search).toBe('?project=p1');
  });
});

describe('useBrowserShareHandoff: an environment port link (browserUrl)', () => {
  it('sets the page the pane opens for the project in the link, before any pane mounts, then drops the parameter', () => {
    localStorage.removeItem('termag.browserPane.url.p1/main');
    window.history.replaceState(null, '', '/termag/?project=p1&ws=main&browser=open&browserUrl=http%3A%2F%2Flocalhost%3A5174%2Ftermag%2F');
    render('');
    expect(localStorage.getItem('termag.browserPane.url.p1/main')).toBe('http://localhost:5174/termag/');
    render('p1/main');
    expect(expandDock).toHaveBeenCalledWith('p1/main');
    expect(got!.openShare).toBeNull();
    expect(window.location.search).toBe('?project=p1&ws=main');
  });

  it("reads the simple UI's /chat/p/<id>?ws=, and ignores a URL off the box's loopback", () => {
    localStorage.removeItem('termag.browserPane.url.p2/fix');
    window.history.replaceState(null, '', '/termag/chat/p/p2?ws=fix&browser=open&browserUrl=http%3A%2F%2Flocalhost%3A3040%2F');
    render('p2/fix');
    expect(localStorage.getItem('termag.browserPane.url.p2/fix')).toBe('http://localhost:3040/');
    localStorage.removeItem('termag.browserPane.url.p2/fix');
    window.history.replaceState(null, '', '/termag/chat/p/p2?ws=fix&browser=open&browserUrl=https%3A%2F%2Fevil.example%2F');
    act(() => root.unmount()); root = createRoot(el);
    render('p2/fix');
    expect(localStorage.getItem('termag.browserPane.url.p2/fix')).toBeNull();
  });
});
