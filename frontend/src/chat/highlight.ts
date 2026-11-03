// highlight.js for the file view, loaded on first use: its core, then each
// language's grammar the first time a file needs it, so none of it is in the
// main bundle. Read-only highlighting; nothing here edits.
import type { HLJSApi, LanguageFn } from 'highlight.js';

type Grammar = () => Promise<{ default: LanguageFn }>;

const GRAMMARS: Record<string, Grammar> = {
  typescript: () => import('highlight.js/lib/languages/typescript'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  python: () => import('highlight.js/lib/languages/python'),
  go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'),
  java: () => import('highlight.js/lib/languages/java'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  php: () => import('highlight.js/lib/languages/php'),
  c: () => import('highlight.js/lib/languages/c'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  swift: () => import('highlight.js/lib/languages/swift'),
  sql: () => import('highlight.js/lib/languages/sql'),
  css: () => import('highlight.js/lib/languages/css'),
  scss: () => import('highlight.js/lib/languages/scss'),
  bash: () => import('highlight.js/lib/languages/bash'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  ini: () => import('highlight.js/lib/languages/ini'),
  xml: () => import('highlight.js/lib/languages/xml'),
  diff: () => import('highlight.js/lib/languages/diff'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
};

let core: Promise<HLJSApi> | null = null;
const registered = new Map<string, Promise<void>>();

function loadCore(): Promise<HLJSApi> {
  core ??= import('highlight.js/lib/core').then(m => m.default);
  return core;
}

/** Highlighted HTML for `text` in `language`, or null for a language with no grammar here. */
export async function highlight(text: string, language: string): Promise<string | null> {
  const grammar = GRAMMARS[language];
  if (!grammar) return null;
  const hljs = await loadCore();
  let ready = registered.get(language);
  if (!ready) {
    ready = grammar().then(m => { hljs.registerLanguage(language, m.default); });
    registered.set(language, ready);
    ready.catch(() => registered.delete(language));
  }
  await ready;
  return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}
