// Pure pieces of the file view's text and code display (pages/chat/CodeView.tsx):
// which highlight.js language a file gets, when it is too big to highlight,
// whether it wraps, and splitting highlighted HTML into lines.

/**
 * highlight.js language by extension: the text types the server signs for
 * viewing (backend services/spaces/spacePaths.ts TEXT_EXTENSIONS) that have a
 * grammar. Prose, logs, CSV and Terraform/HCL (no highlight.js grammar) are
 * plain text. Markdown is rendered, not shown here.
 */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonl: 'json',
  py: 'python', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  sql: 'sql', css: 'css', scss: 'scss',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini',
  xml: 'xml', diff: 'diff', patch: 'diff', proto: 'protobuf', graphql: 'graphql',
};

export const CODE_LANGUAGES: readonly string[] = [...new Set(Object.values(LANGUAGE_BY_EXT))].sort();

/** Fetched for the code view; past this the view shows the start and says so. */
export const CODE_VIEW_MAX_BYTES = 1024 * 1024;
/** Past either, the text is shown plain: highlighting it would stall the page. */
export const HIGHLIGHT_MAX_BYTES = 256 * 1024;
export const HIGHLIGHT_MAX_LINES = 8000;

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** The file's highlight.js language, or null for plain text. */
export function languageFor(path: string): string | null {
  return LANGUAGE_BY_EXT[extensionOf(path)] ?? null;
}

/** Whether the text is small enough to highlight. */
export function highlightable(text: string): boolean {
  if (text.length > HIGHLIGHT_MAX_BYTES) return false;
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (++lines > HIGHLIGHT_MAX_LINES) return false;
  }
  return true;
}

/** Code doesn't wrap by default; prose (no language, not a log or table) does. */
export function wrapsByDefault(path: string): boolean {
  if (languageFor(path)) return false;
  return !['log', 'csv', 'tsv'].includes(extensionOf(path));
}

/** The text's lines, without a final empty one after a trailing newline. */
export function textLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const TAG = /<span[^>]*>|<\/span>/g;

/**
 * highlight.js's HTML split into one string per line. A span open across a
 * newline (a block comment, a template string) is closed at the end of the
 * line and reopened on the next, so every line is well-formed on its own.
 * highlight.js escapes the text and emits only spans, which is all this
 * tracks.
 */
export function splitHighlightedLines(html: string): string[] {
  const out: string[] = [];
  const open: string[] = [];
  let line = '';
  const flush = () => {
    out.push(line + '</span>'.repeat(open.length));
    line = open.join('');
  };
  let last = 0;
  const emitText = (s: string) => {
    const parts = s.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) flush();
      line += p.replace(/\r$/, '');
    });
  };
  for (const m of html.matchAll(TAG)) {
    emitText(html.slice(last, m.index));
    if (m[0] === '</span>') open.pop();
    else open.push(m[0]);
    line += m[0];
    last = m.index + m[0].length;
  }
  emitText(html.slice(last));
  out.push(line + '</span>'.repeat(open.length));
  // As textLines: no empty line after a trailing newline.
  if (out.length > 1 && out[out.length - 1].replace(/<[^>]*>/g, '') === '') out.pop();
  return out;
}
