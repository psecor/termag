// Run before every test file (vitest.config.ts). React Aria's overlays (LaunchPad's
// popovers, menus and modals, the sidebar's item menu among them) read a CSP nonce
// through CSS.escape, which jsdom lacks.
const css = globalThis as { CSS?: { escape?: (s: string) => string } };
css.CSS ??= {};
css.CSS.escape ??= (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
