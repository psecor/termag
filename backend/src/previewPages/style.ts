/**
 * termag's look for its server-rendered preview pages: the landing and error
 * pages (previewPages/index.ts) and the confirm page
 * (routes/previewLinkConfirm.ts). One inline <style>, because their CSP allows
 * inline style and nothing else: no script, no font, no image, no stylesheet
 * (SR22). So nothing here may fetch: no url(), no @import, no @font-face.
 *
 * The colours are the frontend's palette (frontend/src/App.css, dark `:root`
 * and `html[data-palette="light"]`), chosen by the browser's
 * prefers-color-scheme, since these pages have no signed-in theme. Text is in
 * termag's UI font stack; monospace only for names, hosts, URLs and emails
 * (`code`). previewPages/style.test.ts holds both rules.
 */

export const DARK = {
  bg: '#0d1117', surface: '#161b22', elevated: '#21262d', text: '#c9d1d9', muted: '#8b949e',
  border: '#30363d', accent: '#58a6ff', warning: '#d29922', danger: '#f85149', onFill: '#ffffff', fill: '#1f6feb',
};
export const LIGHT = {
  bg: '#ffffff', surface: '#f6f8fa', elevated: '#eaeef2', text: '#1f2328', muted: '#59636e',
  border: '#d0d7de', accent: '#0860ca', warning: '#8a5c00', danger: '#cf222e', onFill: '#ffffff', fill: '#0969da',
};

/** The App.css variable each colour is a copy of. */
export const PALETTE_TOKENS: Readonly<Record<keyof typeof DARK, string>> = {
  bg: 'bg-base', surface: 'bg-surface', elevated: 'bg-elevated', text: 'text-primary', muted: 'text-secondary', border: 'border',
  accent: 'accent', warning: 'warning', danger: 'danger', onFill: 'text-on-fill', fill: 'accent-dim',
};

/** frontend/src/App.css's --font-ui and --font-mono, without the bundled font (the CSP loads none). */
export const UI_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
export const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";

function vars(p: typeof DARK): string {
  return Object.entries(p).map(([k, v]) => `--${k}:${v}`).join(';');
}

export const PAGE_STYLE = [
  `:root{${vars(DARK)};color-scheme:dark}`,
  `@media(prefers-color-scheme:light){:root{${vars(LIGHT)};color-scheme:light}}`,
  `*{box-sizing:border-box}`,
  `body{margin:0;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:12vh 1rem 2rem;background:var(--bg);color:var(--text);font:15px/1.55 ${UI_FONT}}`,
  `main{width:100%;max-width:34rem;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1.75rem 1.75rem 1.5rem}`,
  `.brand{margin:0 0 1.25rem;font-size:.8rem;font-weight:600;letter-spacing:.04em;color:var(--muted);text-transform:lowercase}`,
  `h1{margin:0 0 .6rem;font-size:1.3rem;font-weight:600;line-height:1.3;color:var(--text)}`,
  `p{margin:.6rem 0;color:var(--muted)}`,
  `a{color:var(--accent)}`,
  `code{font-family:${MONO_FONT};font-size:.88em;overflow-wrap:anywhere;color:var(--text)}`,
  `.continue{display:inline-block;margin-top:.8rem;padding:.45rem 1rem;border-radius:6px;background:var(--fill);color:var(--onFill);text-decoration:none;font-weight:600}`,
  `.warn{margin:1rem 0;padding:.65rem .85rem;border-radius:8px;border:1px solid var(--warning);color:var(--text);background:var(--elevated)}`,
  `dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.35rem 1rem;margin:1rem 0;padding:.9rem 1rem;border-radius:8px;background:var(--elevated)}`,
  `dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}`,
  `.actions{display:flex;gap:.6rem;margin-top:1.25rem}form{display:inline}`,
  `button{font:inherit;font-weight:600;padding:.45rem 1.1rem;border-radius:6px;border:1px solid var(--border);background:var(--elevated);color:var(--text);cursor:pointer}`,
  `button.primary{background:var(--fill);border-color:var(--fill);color:var(--onFill)}`,
  `.fine{font-size:.85rem}`,
].join('');

/**
 * A whole page: the brand line, then `inner`, in one card. `head` goes in
 * <head> (the hand-off's meta refresh).
 */
export function pageDocument(title: string, inner: string, escape: (s: string) => string, head = ''): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">'
    + `${head}<title>${escape(title)}</title><style>${PAGE_STYLE}</style></head>`
    + `<body><main><p class="brand">termag</p>${inner}</main></body></html>`;
}
