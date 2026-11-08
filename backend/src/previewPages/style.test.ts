// The server-rendered preview pages in termag's look, inside their CSP: one
// inline <style>, nothing fetched, no script (SR22), the frontend's palette.
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import express from 'express';
import type { AddressInfo } from 'net';
import { describe, expect, it } from 'vitest';
import { DARK, LIGHT, PAGE_STYLE, PALETTE_TOKENS, UI_FONT } from './style';
import { PAGE_CSP, PREVIEW_PAGES, renderHandoff, renderLandingRefusal, renderPage, type PreviewPageKind } from './index';
import { confirmPageBody, previewLinkConfirmRouter, WIDER_WARNING } from '../routes/previewLinkConfirm';
import type { ConfirmPageView } from '../services/previewLinkConfirmations';

const ROOT = resolve(__dirname, '../../..');
const appCss = readFileSync(join(ROOT, 'frontend/src/App.css'), 'utf8');

function tokenValue(css: string, token: string): string | undefined {
  return new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{3,8})`).exec(css)?.[1]?.toLowerCase();
}

function pages(): string[] {
  return [
    ...(Object.keys(PREVIEW_PAGES) as PreviewPageKind[]).map(k => renderPage(k).html),
    renderHandoff('Ana <b>', 'https://shop--k3x9q.preview.test/__termag/auth?code=abc'),
    renderLandingRefusal('not_found').html, renderLandingRefusal('asleep').html, renderLandingRefusal('off').html,
  ];
}

describe("the preview pages' style", () => {
  it('fetches nothing: no url(), @import or @font-face, so the CSP (style-src inline only) holds', () => {
    expect(PAGE_STYLE).not.toMatch(/url\(|@import|@font-face|https?:/i);
    expect(PAGE_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  });

  it('is in every page once, with no script, no external resource and no inline handler', () => {
    for (const html of pages()) {
      expect(html.match(/<style>/g)).toHaveLength(1);
      expect(html).toContain(PAGE_STYLE);
      expect(html).not.toMatch(/<script|<link|<img|<iframe|\son[a-z]+=|javascript:/i);
      expect(html).toContain('<p class="brand">termag</p>');
    }
  });

  it("uses the frontend's palette, dark and light, and its UI font for text", () => {
    const light = appCss.slice(appCss.indexOf('html[data-palette="light"] {'));
    for (const [key, token] of Object.entries(PALETTE_TOKENS) as Array<[keyof typeof DARK, string]>) {
      expect([key, DARK[key]]).toEqual([key, tokenValue(appCss, token)]);
      expect([key, LIGHT[key]]).toEqual([key, tokenValue(light, token)]);
    }
    expect(appCss).toContain(`--font-ui: ${UI_FONT};`);
    expect(PAGE_STYLE).toContain(`body{`);
    expect(PAGE_STYLE).toMatch(new RegExp(`body\\{[^}]*${UI_FONT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('keeps the hand-off: the escaped owner, the meta refresh and a Continue link', () => {
    const html = renderHandoff('Ana <b>', 'https://shop--k3x9q.preview.test/__termag/auth?code=a&b');
    expect(html).toContain("You're opening an app running on Ana &lt;b&gt;'s box");
    expect(html).toContain('<meta http-equiv="refresh" content="1;url=https://shop--k3x9q.preview.test/__termag/auth?code=a&amp;b">');
    expect(html).toContain('<a class="continue" href="https://shop--k3x9q.preview.test/__termag/auth?code=a&amp;b">Continue</a>');
  });
});

describe('the confirm page', () => {
  const view = (over: Partial<ConfirmPageView> = {}): ConfirmPageView => ({
    state: 'pending', kind: 'publish', audience: 'link', emails: [], projectName: 'shop', workstream: 'feature-x', boxName: 'box-1', port: 5173,
    name: 'shop-feature-x', ttlHours: 24, fromBoxName: 'box-1', csrf: 'tok', expiresAt: new Date('2026-11-06T20:00:00Z'), failure: null, shareUrl: null, ...over,
  });
  const warning = WIDER_WARNING.replace("'", '&#39;');

  it("keeps its headers and gets the style, through the route's own page (here the sign-in one)", async () => {
    const app = express();
    app.use('/termag/previews/confirm', previewLinkConfirmRouter('/termag', { confirm: {} as never, userOf: () => null }));
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/termag/previews/confirm/abc`);
      expect(res.status).toBe(401);
      expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('cache-control')).toBe('no-store');
      const html = await res.text();
      expect(html).toContain(PAGE_STYLE);
      expect(html).not.toMatch(/<script/i);
    } finally {
      server.close();
    }
  });

  it("carries the Share dialog's warning for a wider audience only, and Publish as the primary button", () => {
    const wide = confirmPageBody(view(), '/termag/previews/confirm/abc');
    expect(wide).toContain(`<p class="warn">${warning}</p>`);
    expect(wide).toContain('<button type="submit" class="primary">Publish</button>');
    expect(wide).toContain('name="csrf" value="tok"');
    expect(confirmPageBody(view({ audience: 'people', emails: ['gus@x.test'] }), '/x')).toContain(warning);
    expect(confirmPageBody(view({ audience: 'owner' }), '/x')).not.toContain(warning);
    expect(confirmPageBody(view({ state: 'declined' }), '/x')).not.toContain('<form');
  });

  it("matches the Share dialog's words for the warning", () => {
    expect(readFileSync(join(ROOT, 'frontend/src/previewLinks/PublishPreviewLink.tsx'), 'utf8')).toContain(`"${WIDER_WARNING}"`);
  });
});
