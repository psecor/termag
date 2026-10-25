// The markdown Claude writes, as data for the chat's bubbles: CommonMark's
// blocks (headings, paragraphs, nested lists, quotes, rules, fenced code) and
// GFM's tables, task lists, strikethrough and autolinks, with inline code,
// bold, italics and links. Rendered as React elements (chat/Markdown.tsx),
// never as HTML, so nothing in a reply can inject markup: raw HTML stays text
// except `<br>`, which becomes a line break. Links are http(s) or mailto only;
// any other destination keeps its label as plain text. Images are never
// loaded (a reply could carry a tracking or exfiltration URL), only linked.
//
// Mid-stream (`streaming`), the unfinished tail is read the way it will
// most likely end: a fence still open is code up to the end, a trailing
// `|` row is a table's header, and an unclosed `**` or backtick in the last
// paragraph runs to the end, so the bubble doesn't flash raw markup.
//
// Deliberate departures from CommonMark: a paragraph's line breaks are kept
// (the bubble is pre-wrap), there are no indented code blocks or lazy
// continuation lines, a nested list needs two more spaces than its parent's
// marker, and table rows must contain a `|`.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 's'; c: Inline[] }
  | { t: 'a'; href: string; c: Inline[] }
  | { t: 'img'; href: string; alt: string }
  | { t: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export interface MdItem {
  /** A task list item's box: true ticked, false empty, null not a task. */
  task: boolean | null;
  blocks: MdBlock[];
}

export type MdBlock =
  | { type: 'p'; inline: Inline[] }
  | { type: 'h'; level: 1 | 2 | 3 | 4; inline: Inline[] }
  | { type: 'code'; lang: string | null; text: string; open: boolean }
  | { type: 'ul'; tight: boolean; items: MdItem[] }
  | { type: 'ol'; start: number; tight: boolean; items: MdItem[] }
  | { type: 'quote'; blocks: MdBlock[] }
  | { type: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { type: 'hr' };

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:( +)(.*))?$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const RULE = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const SETEXT = /^ {0,3}(={3,}|-{3,})[ \t]*$/;
const DELIM_CELL = /^:?-+:?$/;
const TASK = /^\[([ xX])\](?:\s+|$)/;
const PUNCT = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const BR = /^<br\s*\/?>/i;
const ENTITY = /^&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|amp|lt|gt|quot|apos|nbsp);/;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function safeHref(url: string): string | null {
  return /^(https?:\/\/[^\s]+|mailto:[^\s@]+@[^\s]+)$/i.test(url) ? url : null;
}

const blank = (line: string) => !line.trim();
const indentOf = (line: string) => line.length - line.trimStart().length;

/** `[label](dest "title")` at `src[i]`: the label, destination and length. */
function readLink(src: string, i: number): { label: string; dest: string; len: number } | null {
  let depth = 0;
  let j = i;
  // Bounded, so a reply full of unmatched `[` stays linear.
  const stop = Math.min(src.length, i + 1000);
  for (; j < stop; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  if (j >= stop || src[j + 1] !== '(') return null;
  const label = src.slice(i + 1, j);
  let k = j + 2;
  while (src[k] === ' ') k++;
  let dest = '';
  if (src[k] === '<') {
    const close = src.indexOf('>', k);
    if (close < 0) return null;
    dest = src.slice(k + 1, close);
    k = close + 1;
  } else {
    let parens = 0;
    const from = k;
    for (; k < src.length; k++) {
      const c = src[k];
      if (/\s/.test(c)) break;
      if (c === '(') parens++;
      else if (c === ')') { if (parens === 0) break; parens--; }
    }
    dest = src.slice(from, k);
  }
  const title = /^\s+("[^"]*"|'[^']*')/.exec(src.slice(k));
  if (title) k += title[0].length;
  while (src[k] === ' ') k++;
  if (src[k] !== ')') return null;
  return { label, dest, len: k + 1 - i };
}

/** A bare URL's length at `src[i]`, without trailing punctuation. */
function bareUrlLength(src: string, i: number): number {
  const m = /^https?:\/\/[^\s<]+/i.exec(src.slice(i));
  if (!m) return 0;
  let url = m[0];
  for (;;) {
    const last = url[url.length - 1];
    if (/[?!.,:;*_~'"]/.test(last)) url = url.slice(0, -1);
    else if (last === ')' && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
    else break;
  }
  return /^https?:\/\/./i.test(url) ? url.length : 0;
}

/**
 * Inline markup in one line or paragraph. `open` (the last paragraph of a
 * reply still streaming) lets an unclosed `**` or code span run to the end.
 */
export function parseInline(src: string, open = false): Inline[] {
  return inline(src, open, false);
}

/**
 * `inLink` is a link's label: nothing in it may become another anchor (the
 * browser would drop the outer one), so URLs stay text, a nested link keeps
 * only its label and an image only its alt text.
 */
function inline(src: string, open: boolean, inLink: boolean): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = ''; } };
  const push = (node: Inline) => { flush(); out.push(node); };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    if (ch === '\\' && i + 1 < src.length && (PUNCT.test(src[i + 1]) || src[i + 1] === '\n')) {
      text += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(rest)![0];
      const close = new RegExp(`(?<!\`)${run}(?!\`)`, 'g');
      close.lastIndex = i + run.length;
      const m = close.exec(src);
      if (m || open) {
        let v = src.slice(i + run.length, m ? m.index : src.length).replace(/\n/g, ' ');
        if (v.length > 2 && v.startsWith(' ') && v.endsWith(' ') && v.trim()) v = v.slice(1, -1);
        push({ t: 'code', v });
        i = m ? m.index + run.length : src.length;
        continue;
      }
      text += run;
      i += run.length;
      continue;
    }
    if (ch === '~' && src[i + 1] === '~') {
      const end = src.indexOf('~~', i + 2);
      if (end > i + 2) { push({ t: 's', c: inline(src.slice(i + 2, end), false, inLink) }); i = end + 2; continue; }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      let end = src.indexOf(ch + ch, i + 2);
      while (end > 0 && src[end + 2] === ch) end++;
      if (end > i + 2) { push({ t: 'b', c: inline(src.slice(i + 2, end), false, inLink) }); i = end + 2; continue; }
      if (end < 0 && open && ch === '*' && i + 2 < src.length) { push({ t: 'b', c: inline(src.slice(i + 2), true, inLink) }); i = src.length; continue; }
    }
    if (ch === '*' || ch === '_') {
      // `_` only at a word edge, so snake_case stays text.
      const edge = ch === '*' || i === 0 || /[\s(]/.test(src[i - 1]);
      const end = src.indexOf(ch, i + 1);
      if (edge && end > i + 1 && src[i + 1] !== ' ' && (ch === '*' || end + 1 >= src.length || /[\s.,;:!?)]/.test(src[end + 1]))) {
        push({ t: 'i', c: inline(src.slice(i + 1, end), false, inLink) }); i = end + 1; continue;
      }
    }
    if (ch === '!' && src[i + 1] === '[') {
      const link = readLink(src, i + 1);
      if (link) {
        const href = safeHref(link.dest);
        if (href && !inLink) push({ t: 'img', href, alt: link.label });
        else text += link.label;
        i += 1 + link.len;
        continue;
      }
    }
    if (ch === '[') {
      const link = readLink(src, i);
      if (link) {
        const href = safeHref(link.dest);
        if (href && !inLink) push({ t: 'a', href, c: inline(link.label, false, true) });
        else for (const node of inline(link.label, false, inLink)) { if (node.t === 'text') text += node.v; else push(node); }
        i += link.len;
        continue;
      }
    }
    if (ch === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(rest);
      const href = auto ? safeHref(auto[1]) : null;
      if (auto && href && inLink) { text += auto[1]; i += auto[0].length; continue; }
      if (auto && href) { push({ t: 'a', href, c: [{ t: 'text', v: auto[1].replace(/^mailto:/i, '') }] }); i += auto[0].length; continue; }
      const br = BR.exec(rest);
      if (br) { push({ t: 'br' }); i += br[0].length; continue; }
    }
    if (!inLink && (ch === 'h' || ch === 'H') && (i === 0 || /[\s(*_~]/.test(src[i - 1]))) {
      const len = bareUrlLength(src, i);
      if (len) { const url = src.slice(i, i + len); push({ t: 'a', href: url, c: [{ t: 'text', v: url }] }); i += len; continue; }
    }
    if (ch === '&') {
      const ent = ENTITY.exec(rest);
      if (ent) {
        const name = ent[1];
        const code = name[0] !== '#' ? null : /^#[xX]/.test(name) ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
        const decoded = code == null ? NAMED[name] : code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd';
        text += decoded;
        i += ent[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** A table row's cells; `|` inside a code span or escaped as `\|` is text. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cell += '|'; i++; continue; }
    if (c === '\\' && i + 1 < s.length) { cell += c + s[i + 1]; i++; continue; }
    if (c === '`') {
      const run = /^`+/.exec(s.slice(i))![0];
      const end = s.indexOf(run, i + run.length);
      if (end > 0) { cell += s.slice(i, end + run.length).replace(/\\\|/g, '|'); i = end + run.length - 1; continue; }
    }
    if (c === '|') { cells.push(cell.trim()); cell = ''; continue; }
    cell += c;
  }
  if (cell.trim() || !line.trim().endsWith('|')) cells.push(cell.trim());
  return cells;
}

function delimiterRow(line: string): Align[] | null {
  if (!line.includes('|') && !line.includes(':')) return null;
  const cells = splitRow(line);
  if (!cells.length || !cells.every(c => DELIM_CELL.test(c))) return null;
  return cells.map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
}

/** The start of a delimiter row still streaming in, like `| --- | :-`. */
const partialDelimiter = (line: string) => /^\s*\|?[\s:|-]*$/.test(line) && /[-|:]/.test(line);

interface ListMarker { indent: number; ordered: boolean; char: string; num: number; content: number; rest: string }

function listMarker(line: string): ListMarker | null {
  const m = LIST_ITEM.exec(line);
  if (!m || m[1].length > 3) return null;
  const spaces = m[3]?.length ?? 0;
  const rest = m[4] ?? '';
  if (spaces === 0 && rest) return null;
  const ordered = /\d/.test(m[2]);
  const indent = m[1].length;
  return {
    indent, ordered, char: m[2].slice(-1), num: ordered ? parseInt(m[2], 10) : 1,
    content: indent + m[2].length + (spaces >= 1 && spaces <= 4 ? spaces : 1),
    rest: spaces > 4 ? ' '.repeat(spaces - 1) + rest : rest,
  };
}

/** A reply as blocks. */
export function parseMarkdown(src: string, opts: { streaming?: boolean } = {}): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/^\t+/, t => '    '.repeat(t.length)));
  // Mid-stream, one trailing newline only means the next line hasn't arrived;
  // treating it as a blank line would close a pending table header or open bold.
  if (opts.streaming && lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return parseBlocks(lines, !!opts.streaming);
}

function parseBlocks(lines: string[], atEnd: boolean): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const endPara = (open = false) => {
    if (para.length) { blocks.push({ type: 'p', inline: parseInline(para.join('\n'), open) }); para = []; }
  };
  const n = lines.length;
  let last = n - 1;
  while (last >= 0 && blank(lines[last])) last--;
  const isLast = (i: number) => atEnd && i >= last;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (blank(line)) { endPara(); i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      endPara();
      const [, indent, marker, lang] = fence;
      const closer = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      while (i < n && !closer.test(lines[i])) {
        const l = lines[i++];
        body.push(l.slice(Math.min(indent.length, indentOf(l))));
      }
      const open = i >= n;
      blocks.push({ type: 'code', lang: lang || null, text: body.join('\n'), open });
      i++;
      continue;
    }
    // A fence's first backticks, before the third has streamed in.
    if (/^ {0,3}`{1,2}$/.test(line) && isLast(i)) { endPara(true); i++; continue; }

    if (para.length && SETEXT.test(line)) {
      const level = line.trim()[0] === '=' ? 1 : 2;
      blocks.push({ type: 'h', level, inline: parseInline(para.join('\n').trim()) });
      para = [];
      i++;
      continue;
    }
    if (RULE.test(line)) { endPara(); blocks.push({ type: 'hr' }); i++; continue; }

    const h = HEADING.exec(line);
    if (h) {
      endPara();
      blocks.push({ type: 'h', level: Math.min(4, h[1].length) as 1 | 2 | 3 | 4, inline: parseInline((h[2] ?? '').trim()) });
      i++;
      continue;
    }

    if (line.includes('|')) {
      const head = splitRow(line);
      const next = i + 1 < n ? lines[i + 1] : null;
      const align = next != null ? delimiterRow(next) : null;
      const pendingHead = line.trimStart().startsWith('|') && (next == null ? isLast(i) : isLast(i + 1) && partialDelimiter(next));
      if ((align && align.length === head.length) || pendingHead) {
        endPara();
        const cols = head.length;
        const fit = (cells: string[]) => Array.from({ length: cols }, (_, c) => parseInline(cells[c] ?? ''));
        const rows: Inline[][][] = [];
        i += next == null ? 1 : 2;
        while (i < n && lines[i].includes('|') && !blank(lines[i]) && !QUOTE.test(lines[i]) && !FENCE.test(lines[i])) rows.push(fit(splitRow(lines[i++])));
        blocks.push({ type: 'table', align: align && align.length === cols ? align : head.map(() => null), head: fit(head), rows });
        continue;
      }
    }

    const marker = listMarker(line);
    // An ordered list interrupts a paragraph only from 1, so "2024. was" in prose stays text.
    if (marker && !(para.length && ((marker.ordered && marker.num !== 1) || !marker.rest.trim()))) {
      endPara();
      i = parseList(lines, i, marker, atEnd, blocks);
      continue;
    }

    if (QUOTE.test(line)) {
      endPara();
      const quoted: string[] = [];
      while (i < n && QUOTE.test(lines[i])) quoted.push(QUOTE.exec(lines[i++])![1]);
      blocks.push({ type: 'quote', blocks: parseBlocks(quoted, atEnd && i >= n) });
      continue;
    }

    para.push(line);
    i++;
  }
  endPara(atEnd);
  return blocks;
}

function parseList(lines: string[], i: number, first: ListMarker, atEnd: boolean, blocks: MdBlock[]): number {
  const n = lines.length;
  const items: MdItem[] = [];
  let tight = true;
  const child = first.indent + 2;
  for (;;) {
    const m = listMarker(lines[i])!;
    const body = [m.rest];
    i++;
    while (i < n) {
      const l = lines[i];
      if (blank(l)) {
        let j = i;
        while (j < n && blank(lines[j])) j++;
        if (j < n && indentOf(lines[j]) >= child) {
          for (; i < j; i++) body.push('');
          continue;
        }
        break;
      }
      if (indentOf(l) < child) break;
      body.push(l.slice(Math.min(indentOf(l), m.content)));
      i++;
    }
    let task: boolean | null = null;
    const t = TASK.exec(body[0]);
    if (t) { task = t[1] !== ' '; body[0] = body[0].slice(t[0].length); }
    const itemBlocks = parseBlocks(body, atEnd && lines.slice(i).every(blank));
    if (body.some((l, k) => blank(l) && k > 0 && k < body.length - 1)) tight = false;
    items.push({ task, blocks: itemBlocks });

    let j = i;
    while (j < n && blank(lines[j])) j++;
    const next = j < n ? listMarker(lines[j]) : null;
    if (!next || next.indent >= child || next.ordered !== first.ordered || next.char !== first.char) break;
    if (j > i) tight = false;
    i = j;
  }
  blocks.push(first.ordered ? { type: 'ol', start: first.num, tight, items } : { type: 'ul', tight, items });
  return i;
}
