// The rules a day's theme is held to ("What a day may
// contain"). lint.test.ts runs these over every directory here, so CI fails a
// day that breaks one. They catch mistakes and the obvious escapes; they are a
// tripwire, not the boundary. A sprite's boundary is its sandboxed frame
// (spriteFrame.ts: an opaque origin with no network), which a sprite can't
// lint its way out of; the CSS's is the scope and fetch rules below, and a
// person reviewing each day's PR, with its screenshots.
//
// Test-only: nothing in the app imports this file, so postcss and typescript
// stay out of the bundle.

import postcss, { type AtRule, type ChildNode, type Declaration, type Node, type Rule } from 'postcss';
import ts from 'typescript';
import { DAILY_THEME_DATE } from './date';

export const MAX_CSS_BYTES = 16 * 1024;
export const MAX_SPRITE_BYTES = 16 * 1024;
export const DAY_FILES = ['meta.json', 'theme.css', 'sprite.js'] as const;
const REQUIRED_DAY_FILES = ['meta.json', 'theme.css'];

/** The selector every rule of `date`'s CSS starts with. */
export const dayScope = (date: string) => `html[data-daily-theme="${date}"]`;
/** The prefix every @keyframes name of `date` takes, so two days never collide. */
export const keyframesPrefix = (date: string) => `dt-${date.replace(/-/g, '')}-`;

export function lintDayFiles(date: string, files: string[]): string[] {
  const errors: string[] = [];
  if (!DAILY_THEME_DATE.test(date)) errors.push(`${date}: a day's directory is named YYYY-MM-DD`);
  for (const f of files) if (!(DAY_FILES as readonly string[]).includes(f)) errors.push(`${date}/${f}: a day holds only ${DAY_FILES.join(', ')}`);
  for (const f of REQUIRED_DAY_FILES) if (!files.includes(f)) errors.push(`${date}: ${f} is missing`);
  return errors;
}

/** meta.json's checks (meta.ts), the ones the registry applies before it uses a day's meta. */
export { metaErrors as lintMeta } from './meta';

const ALLOWED_AT_RULES = new Set(['media', 'supports', 'keyframes', 'container']);
// Fetches, bindings and script: none of them belong in a reskin.
const BANNED_VALUE = /@import|expression\s*\(|javascript:|-moz-binding|image-set\s*\(|src\s*\(/i;
const BANNED_PROPS = new Set(['behavior', '-moz-binding']);
const MOTION_PROPS = /^(animation|animation-name|animation-duration|transition|transition-duration|transition-property)$/i;
// The engine's own layer and style element: a day may not restyle them, or it
// could lift the opacity cap or let the sprite's frame take clicks.
const ENGINE_SELECTORS = /daily-theme-decor|data-daily-theme-style/i;

function insideReducedMotionGuard(node: ChildNode): boolean {
  for (let p = node.parent as Node | undefined; p && p.type !== 'root' && p.type !== 'document'; p = p.parent as Node | undefined) {
    if (p.type === 'atrule' && (p as AtRule).name === 'media' && /prefers-reduced-motion\s*:\s*no-preference/i.test((p as AtRule).params)) return true;
  }
  return false;
}

function insideKeyframes(node: ChildNode): boolean {
  for (let p = node.parent as Node | undefined; p && p.type !== 'root' && p.type !== 'document'; p = p.parent as Node | undefined) {
    if (p.type === 'atrule' && /keyframes$/i.test((p as AtRule).name)) return true;
  }
  return false;
}

export function lintThemeCss(css: string, date: string): string[] {
  const where = `${date}/theme.css`;
  const errors: string[] = [];
  if (new TextEncoder().encode(css).length > MAX_CSS_BYTES) errors.push(`${where}: over ${MAX_CSS_BYTES} bytes`);
  let root;
  try {
    root = postcss.parse(css);
  } catch (e) {
    return [...errors, `${where}: does not parse: ${(e as Error).message}`];
  }
  const scope = dayScope(date);
  const prefix = keyframesPrefix(date);
  root.walk(node => {
    const at = node.source?.start ? `${where}:${node.source.start.line}` : where;
    if (node.type === 'atrule') {
      const a = node as AtRule;
      const name = a.name.toLowerCase().replace(/^-\w+-/, '');
      if (!ALLOWED_AT_RULES.has(name)) errors.push(`${at}: @${a.name} is not allowed (only @media, @supports, @container, @keyframes)`);
      if (name === 'keyframes' && !a.params.trim().startsWith(prefix)) errors.push(`${at}: @keyframes names start with ${prefix}`);
    } else if (node.type === 'rule') {
      if (insideKeyframes(node)) return;
      for (const sel of (node as Rule).selectors) {
        const s = sel.trim();
        if (!(s === scope || (s.startsWith(scope) && /^[\s[.:>+~#]/.test(s.slice(scope.length))))) {
          errors.push(`${at}: selector "${s}" does not start with ${scope}`);
        }
        if (ENGINE_SELECTORS.test(s)) errors.push(`${at}: selector "${s}" targets the engine's own layer`);
      }
    } else if (node.type === 'decl') {
      const d = node as Declaration;
      if (d.important) errors.push(`${at}: !important is not allowed`);
      if (BANNED_PROPS.has(d.prop.toLowerCase())) errors.push(`${at}: ${d.prop} is not allowed`);
      if (BANNED_VALUE.test(d.value)) errors.push(`${at}: ${d.prop}'s value is not allowed`);
      for (const m of d.value.matchAll(/url\(\s*(['"]?)([^'")]*)/gi)) {
        if (!/^data:image\/(svg\+xml|png|webp)[;,]/i.test(m[2])) errors.push(`${at}: url() may only hold a data:image/ URI, never a fetch`);
      }
      if (MOTION_PROPS.test(d.prop) && !/^(none|0s?)$/i.test(d.value.trim()) && !insideReducedMotionGuard(node)) {
        errors.push(`${at}: ${d.prop} goes inside @media (prefers-reduced-motion: no-preference)`);
      }
    }
  });
  return errors;
}

// Anything that reaches the page, the network, storage, timers or code
// generation. A sprite gets a 2D context and its frame, and needs none of them;
// the frame would refuse most anyway, so a hit here is a sprite that is
// confused or up to something, worth a reviewer's look either way.
const BANNED_IDENTIFIERS = new Set([
  'window', 'document', 'globalThis', 'self', 'top', 'parent', 'frames', 'opener', 'canvas', 'ownerDocument',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'navigator', 'location', 'history',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookie', 'postMessage', 'BroadcastChannel',
  'setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask', 'Worker', 'SharedWorker',
  'eval', 'Function', 'require', 'Reflect', 'Proxy', 'constructor', 'prototype', '__proto__',
  'Image', 'FontFace', 'Blob', 'URL', 'createElement', 'innerHTML', 'outerHTML', 'insertAdjacentHTML',
]);

export function lintSprite(source: string, date: string): string[] {
  const where = `${date}/sprite.js`;
  const errors: string[] = [];
  if (new TextEncoder().encode(source).length > MAX_SPRITE_BYTES) errors.push(`${where}: over ${MAX_SPRITE_BYTES} bytes`);
  const file = ts.createSourceFile('sprite.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const parseErrors = (file as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseErrors.length) errors.push(`${where}: does not parse: ${ts.flattenDiagnosticMessageText(parseErrors[0].messageText, ' ')}`);
  const line = (n: ts.Node) => `${where}:${file.getLineAndCharacterOfPosition(n.getStart(file)).line + 1}`;
  let hasDefault = false;
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n)) {
      errors.push(`${line(n)}: a sprite imports nothing (it runs alone in its frame; types go in JSDoc)`);
      return;
    }
    if (ts.isExportAssignment(n)) {
      hasDefault = true;
      // spriteFrame.ts turns this one line start into window.__dailySprite.
      if (n.parent !== file || file.getLineAndCharacterOfPosition(n.getStart(file)).character !== 0) {
        errors.push(`${line(n)}: \`export default\` starts a line at the top level`);
      }
    }
    const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : [];
    const isDefault = mods.some(m => m.kind === ts.SyntaxKind.DefaultKeyword);
    if (isDefault) hasDefault = true;
    const exported = !isDefault && mods.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isExportDeclaration(n) || exported) errors.push(`${line(n)}: a sprite has one export, its default`);
    // The frame runs the source as it is, so TypeScript syntax would not parse there.
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) || ts.isEnumDeclaration(n)
      || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n)) {
      errors.push(`${line(n)}: plain JavaScript only (types go in JSDoc comments)`);
      return;
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) errors.push(`${line(n)}: no dynamic import()`);
    if (ts.isIdentifier(n) && BANNED_IDENTIFIERS.has(n.text)) errors.push(`${line(n)}: \`${n.text}\` is not available to a sprite`);
    if (ts.isElementAccessExpression(n)) {
      const k = n.argumentExpression;
      if (!ts.isNumericLiteral(k) && !ts.isIdentifier(k) && !ts.isBinaryExpression(k) && !ts.isPrefixUnaryExpression(k)) {
        errors.push(`${line(n)}: index with a number, not a string`);
      }
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && BANNED_IDENTIFIERS.has(n.text)) {
      errors.push(`${line(n)}: the string "${n.text}" is not allowed`);
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  if (!hasDefault) errors.push(`${where}: export default a DailySprite`);
  else if ((source.match(/^export default\s/gm) ?? []).length !== 1) errors.push(`${where}: exactly one line starts with \`export default\``);
  return errors;
}
