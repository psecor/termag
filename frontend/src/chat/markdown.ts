// The markdown Claude writes, as data for the chat's bubbles: headings,
// paragraphs, lists, quotes, rules and fenced code, with inline code, bold,
// italics and http(s) links. Rendered as React elements (chat/Markdown.tsx),
// never as HTML, so nothing in a reply can inject markup. A fence still open
// at the end (a reply mid-stream) is code up to the end.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'b'; c: Inline[] }
  | { t: 'i'; c: Inline[] }
  | { t: 'a'; href: string; c: Inline[] };

export type MdBlock =
  | { type: 'p'; inline: Inline[] }
  | { type: 'h'; level: 1 | 2 | 3 | 4; inline: Inline[] }
  | { type: 'code'; lang: string | null; text: string; open: boolean }
  | { type: 'ul' | 'ol'; items: Inline[][] }
  | { type: 'quote'; inline: Inline[] }
  | { type: 'hr' };

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d+[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

function safeHref(url: string): string | null {
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : null;
}

/** Inline markup in one line or paragraph. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = ''; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) { flush(); out.push({ t: 'code', v: src.slice(i + 1, end) }); i = end + 1; continue; }
    }
    if ((ch === '*' || ch === '_') && src[i + 1] === ch) {
      const end = src.indexOf(ch + ch, i + 2);
      if (end > i + 2) { flush(); out.push({ t: 'b', c: parseInline(src.slice(i + 2, end)) }); i = end + 2; continue; }
    }
    if (ch === '*' || ch === '_') {
      // `_` only at a word edge, so snake_case stays text.
      const edge = ch === '*' || i === 0 || /[\s(]/.test(src[i - 1]);
      const end = src.indexOf(ch, i + 1);
      if (edge && end > i + 1 && src[i + 1] !== ' ' && (ch === '*' || end + 1 >= src.length || /[\s.,;:!?)]/.test(src[end + 1]))) {
        flush(); out.push({ t: 'i', c: parseInline(src.slice(i + 1, end)) }); i = end + 1; continue;
      }
    }
    if (ch === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(src.slice(i));
      const href = m ? safeHref(m[2]) : null;
      if (m && href) { flush(); out.push({ t: 'a', href, c: parseInline(m[1]) }); i += m[0].length; continue; }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** A reply as blocks. */
export function parseMarkdown(src: string): MdBlock[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) { blocks.push({ type: 'p', inline: parseInline(para.join('\n')) }); para = []; }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      endPara();
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      const open = i >= lines.length;
      blocks.push({ type: 'code', lang: fence[2] || null, text: body.join('\n'), open });
      i++;
      continue;
    }
    if (!line.trim()) { endPara(); i++; continue; }
    if (RULE.test(line)) { endPara(); blocks.push({ type: 'hr' }); i++; continue; }
    const h = HEADING.exec(line);
    if (h) {
      endPara();
      blocks.push({ type: 'h', level: Math.min(4, h[1].length) as 1 | 2 | 3 | 4, inline: parseInline(h[2].trim()) });
      i++;
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      endPara();
      const ordered = !BULLET.test(line);
      const re = ordered ? NUMBERED : BULLET;
      const items: Inline[][] = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = re.exec(lines[i])![1];
        i++;
        // Indented continuation lines belong to the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBERED.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(parseInline(item));
      }
      blocks.push({ type: ordered ? 'ol' : 'ul', items });
      continue;
    }
    if (QUOTE.test(line)) {
      endPara();
      const quoted: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) quoted.push(QUOTE.exec(lines[i++])![1]);
      blocks.push({ type: 'quote', inline: parseInline(quoted.join('\n')) });
      continue;
    }
    para.push(line);
    i++;
  }
  endPara();
  return blocks;
}
