// Claude Code draws a markdown table in the pane as a box-drawing grid sized
// to the pane width:
//
//   ┌──────────┬──────────────────┐
//   │ Behavior │ What changes     │
//   ├──────────┼──────────────────┤
//   │ Only the │ The catalog      │      a cell wraps onto several │ rows
//   │ catalog  │ quantities       │      inside one table row
//   ├──────────┼──────────────────┤
//   │ …        │ …                │
//   └──────────┴──────────────────┘
//
// In proportional, wrapping prose its columns misalign and every row wraps,
// so the chat finds these grids in agent text and shows them as a real table
// (the markdown renderer's), or, when the grid does not parse, as monospace.

/** A run of prose, a parsed grid, or a grid that did not parse (shown monospace). */
export type BoxPart =
  | { kind: 'text'; text: string }
  | { kind: 'table'; head: string[] | null; rows: string[][] }
  | { kind: 'grid'; text: string };

const BOX_LINE_RE = /^\s*[┌│├└╭╰┏┃┣┗╔║╠╚╒╞╘]/;
// A rule row: corner or tee, then only horizontals and junctions, then the
// closing corner or tee (tmux cuts the last glyph at the pane edge: � or none).
const RULE_RE = /^([┌├└╭╰┏┣┗╔╠╚╒╞╘])[─━═┬┼┴╤╪╧╥╫╨╦╬╩┳╋┻]*[┐┤┘╮╯┓┫┛╗╣╝╕╡╛�]?$/;
const JUNCTION_RE = /[┬┼┴╤╪╧╥╫╨╦╬╩┳╋┻]/g;
const TOP_CORNERS = '┌╭┏╔╒';
const BOTTOM_CORNERS = '└╰┗╚╘';
const BAR_RE = /[│┃║]/;

/**
 * Split prose into text and the box-drawn tables in it. A table is a run of
 * consecutive rows starting with a box glyph; one that is not a consistent
 * grid comes back as `grid` so it can be shown monospace, never as prose.
 */
export function splitBoxTables(text: string): BoxPart[] {
  const lines = text.split('\n');
  if (!lines.some(l => BOX_LINE_RE.test(l))) return [{ kind: 'text', text }];
  const out: BoxPart[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    const t = prose.join('\n').trim();
    if (t) out.push({ kind: 'text', text: t });
    prose = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (!BOX_LINE_RE.test(lines[i])) { prose.push(lines[i]); continue; }
    let j = i;
    while (j < lines.length && BOX_LINE_RE.test(lines[j])) j++;
    flushProse();
    const rows = lines.slice(i, j);
    out.push(parseBoxTable(rows) ?? { kind: 'grid', text: dedent(rows) });
    i = j - 1;
  }
  flushProse();
  return out;
}

/**
 * Parse one run of box rows. Rule rows separate table rows; content rows
 * between two rules are one table row whose cells wrapped, and each cell's
 * pieces are joined with spaces. The first row is the header only when the
 * top border is in view: a capture that starts mid-table has none. A missing
 * bottom border (the table is still printing, or runs off the capture) is
 * fine. Null when the rows are not a grid with one column count throughout,
 * and when no rule row or second column says it is a table: a run of bare
 * │ rows (a scrolled file tree's rail) or a one-column frame (a boxed note)
 * is box drawing, not a table.
 */
export function parseBoxTable(lines: string[]): Extract<BoxPart, { kind: 'table' }> | null {
  let cols = 0;
  const fit = (n: number) => (cols === 0 ? ((cols = n), true) : cols === n);
  const groups: string[][][] = [];
  let group: string[][] = [];
  let top = false;
  let rules = 0;
  const close = () => { if (group.length) groups.push(group); group = []; };
  for (let k = 0; k < lines.length; k++) {
    const row = lines[k].trim();
    const rule = RULE_RE.exec(row);
    if (rule) {
      if (!fit((row.match(JUNCTION_RE)?.length ?? 0) + 1)) return null;
      rules++;
      if (TOP_CORNERS.includes(rule[1])) {
        if (k !== 0) return null;
        top = true;
      }
      close();
      if (BOTTOM_CORNERS.includes(rule[1]) && k !== lines.length - 1) return null;
      continue;
    }
    if (!BAR_RE.test(row[0])) return null;
    // Drop the outer borders; the right one may be cut to � or gone.
    const inner = row.slice(1).replace(/\s*[│┃║�]$/, '');
    const cells = inner.split(BAR_RE).map(c => c.trim());
    if (!fit(cells.length)) return null;
    group.push(cells);
  }
  close();
  if (groups.length === 0 || rules === 0 || cols < 2) return null;
  const rows = groups.map(g => Array.from({ length: cols }, (_, c) => g.map(r => r[c]).filter(Boolean).join(' ')));
  return top ? { kind: 'table', head: rows[0], rows: rows.slice(1) } : { kind: 'table', head: null, rows };
}

function dedent(lines: string[]): string {
  const indent = Math.min(...lines.map(l => l.length - l.trimStart().length));
  return lines.map(l => l.slice(indent).trimEnd()).join('\n');
}
