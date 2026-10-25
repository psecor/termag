import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrowserDock, sharePagePath } from './BrowserDock';

// A static render: the pane's socket, observer and canvas drawing live in
// effects that do not run here, so this holds the markup and the copy, not
// the stream (that is agent/browser-pane.live.js and routes/browserWs.test.ts).
describe('BrowserDock', () => {
  it('collapsed is a one-line bar that offers to open a browser on the box', () => {
    const html = renderToStaticMarkup(<BrowserDock projectId="p1" workstream="main" expanded={false} onToggle={() => {}} />);
    expect(html).toContain('class="browser-dock "');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('>Browser<');
    expect(html).toContain('>Open<');
    expect(html).not.toContain('browser-pane-canvas');
  });

  it('expanded mounts the pane: toolbar, canvas and the starting notice', () => {
    const html = renderToStaticMarkup(<BrowserDock projectId="p1" workstream="main" expanded={true} onToggle={() => {}} />);
    expect(html).toContain('class="browser-dock is-expanded"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('>Close<');
    expect(html).toContain('aria-label="Back"');
    expect(html).toContain('aria-label="Forward"');
    expect(html).toContain('aria-label="Reload"');
    expect(html).toContain('aria-label="URL"');
    expect(html).toContain('browser-pane-canvas');
    expect(html).toContain('Starting a browser on the box');
  });

  it('offers Share… to an owner when preview sharing is on, and only then', () => {
    expect(renderToStaticMarkup(<BrowserDock projectId="p1" workstream="main" expanded={false} onToggle={() => {}} onShare={() => {}} />)).toContain('>Share…<');
    expect(renderToStaticMarkup(<BrowserDock projectId="p1" workstream="main" expanded={false} onToggle={() => {}} />)).not.toContain('Share…');
  });

  it('a share link opens at the loopback page the pane shows, and only a safe one', () => {
    expect(sharePagePath('http://127.0.0.2/default/production/features?q=x#top')).toBe('/default/production/features?q=x#top');
    expect(sharePagePath('http://localhost:3000/a')).toBe('/a');
    // URL keeps an IPv6 host's brackets: http://[::1]:3000/ has hostname "[::1]".
    expect(sharePagePath('http://[::1]:3000/flags?x=1')).toBe('/flags?x=1');
    expect(sharePagePath('http://127.0.0.2/')).toBeNull();
    expect(sharePagePath('https://example.com/a')).toBeNull();
    expect(sharePagePath('about:blank')).toBeNull();
    expect(sharePagePath('http://127.0.0.2//evil.example/x')).toBeNull();
    expect(sharePagePath('')).toBeNull();
  });

  it('a pane with kept profiles offers Reset browser', () => {
    expect(renderToStaticMarkup(<BrowserDock projectId="p1" workstream="main" expanded={true} onToggle={() => {}} showReset />)).toContain('aria-label="Reset browser"');
    expect(renderToStaticMarkup(<BrowserDock projectId="p1" workstream="main" expanded={true} onToggle={() => {}} />)).not.toContain('Reset browser');
  });
});
