/**
 * Image paths in terminal output, for the hover preview (Terminal.tsx).
 *
 * Agents print screenshot paths as plain text, and Claude Code hard-wraps a
 * long one onto the next row behind an indent:
 *
 *   - Menu after typing b: /tmp/claude-1001/-home-…/cf8049ab-daf
 *     2-4c30-a9fa-e61a36060f47/scratchpad/pw/2-palette-b.png
 *
 * tmux redraws every row itself, so xterm never marks such a row as wrapped.
 * A row is read as continuing onto the next when it ends at (or within a few
 * columns of) the right edge on a path character and the next row starts,
 * after its indent, with one.
 */

/** One terminal row as text, with the 0-based cell column of each UTF-16 unit. */
export interface RowText {
  text: string;
  cells: number[];
}

/** 0-based row and column; `end` is inclusive. */
export interface ImagePathLink {
  path: string;
  start: { row: number; col: number };
  end: { row: number; col: number };
}

// Absolute or ~/ only: the box resolves nothing relative. Not after `:` or
// `/`, so the tail of an https:// URL stays the web-links addon's.
const IMAGE_PATH_RE = /(?<![\w:/.~-])(~?\/[\w.@+%~,=-]+(?:\/[\w.@+%~,=-]+)*\.(?:png|jpe?g|gif|webp))(?![\w./-])/gi;
const PATH_CHAR_RE = /[\w.@+%~,=/-]/;
const ENDS_IN_IMAGE_RE = /\.(?:png|jpe?g|gif|webp)$/i;
/** How far short of the right edge a row may stop and still be read as wrapped. */
const WRAP_SLACK_COLS = 3;
/** Rows one path may span; a path longer than this is not worth chasing. */
const MAX_SPAN_ROWS = 4;

/** A row of plain ASCII, one cell per character. For tests and simple callers. */
export function asciiRow(text: string): RowText {
  return { text, cells: Array.from(text, (_, i) => i) };
}

function trimEndIndex(text: string): number {
  let i = text.length;
  while (i > 0 && text[i - 1] === ' ') i--;
  return i;
}

/** Does `a` run off the right edge mid-path and `b` pick the path up? */
function continuesOnto(a: RowText, b: RowText, cols: number): boolean {
  const end = trimEndIndex(a.text);
  if (end === 0 || a.cells[end - 1] < cols - 1 - WRAP_SLACK_COLS) return false;
  if (!PATH_CHAR_RE.test(a.text[end - 1])) return false;
  // A row that already ends a whole image path did not wrap one.
  const tail = a.text.slice(0, end).match(/[\w.@+%~,=/-]+$/)?.[0] ?? '';
  if (ENDS_IN_IMAGE_RE.test(tail)) return false;
  const lead = b.text.length - b.text.trimStart().length;
  if (lead === b.text.length || !PATH_CHAR_RE.test(b.text[lead])) return false;
  return true;
}

/**
 * Every image path that touches `row`, including one wrapped onto it from the
 * rows above or onto the rows below. `getRow` answers undefined past the buffer.
 */
export function findImagePathLinks(
  getRow: (row: number) => RowText | undefined,
  row: number,
  cols: number,
): ImagePathLink[] {
  const here = getRow(row);
  if (!here) return [];

  let first = row;
  for (let i = 0; i < MAX_SPAN_ROWS - 1; i++) {
    const above = getRow(first - 1);
    const cur = getRow(first);
    if (!above || !cur || !continuesOnto(above, cur, cols)) break;
    first--;
  }

  // The joined text of the run of rows, continuation indents dropped, with
  // where each character sits on screen.
  let text = '';
  const at: Array<{ row: number; col: number }> = [];
  let r = first;
  let rowText: RowText | undefined = getRow(r);
  while (rowText) {
    const from = r === first ? 0 : rowText.text.length - rowText.text.trimStart().length;
    const to = trimEndIndex(rowText.text);
    for (let i = from; i < to; i++) {
      text += rowText.text[i];
      at.push({ row: r, col: rowText.cells[i] });
    }
    const next = getRow(r + 1);
    if (r - first >= MAX_SPAN_ROWS - 1 || !next || !continuesOnto(rowText, next, cols)) break;
    r++;
    rowText = next;
  }

  const links: ImagePathLink[] = [];
  for (const m of text.matchAll(IMAGE_PATH_RE)) {
    const s = m.index ?? 0;
    const start = at[s];
    const end = at[s + m[0].length - 1];
    if (start.row > row || end.row < row) continue;
    links.push({ path: m[0], start, end });
  }
  return links;
}

/** Where the backend serves `path` from the project's box (routes/sessions.ts). */
export function imagePreviewUrl(projectId: string, workstream: string | undefined, path: string): string {
  const q = new URLSearchParams({ workstream: workstream ?? 'main', path });
  return `/termag/api/projects/${encodeURIComponent(projectId)}/image?${q}`;
}
