// A file's patch as GitHub gives it (pulls/{n}/files `patch`: unified-diff
// hunks, no file header) read into rows with both sides' line numbers, so the
// Files changed tab can put each review thread, and each drafted comment, on
// the line it is about. Pure, for the tests.

export interface DiffRow {
  kind: 'hunk' | 'add' | 'del' | 'ctx';
  text: string;
  /** The base's line number (del, ctx). */
  old: number | null;
  /** The head's line number (add, ctx): what a comment on the RIGHT side names. */
  new: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string | null | undefined): DiffRow[] {
  if (!patch) return [];
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  const lines = patch.replace(/\r\n?/g, '\n').split('\n');
  // A patch ending in a newline splits into one empty string after it: that's no line. A blank context
  // line in a hunk is a space, and stays.
  if (lines.at(-1) === '') lines.pop();
  for (const raw of lines) {
    const h = HUNK.exec(raw);
    if (h) {
      oldLine = Number(h[1]);
      newLine = Number(h[2]);
      rows.push({ kind: 'hunk', text: raw, old: null, new: null });
      continue;
    }
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (raw.startsWith('+')) rows.push({ kind: 'add', text: raw.slice(1), old: null, new: newLine++ });
    else if (raw.startsWith('-')) rows.push({ kind: 'del', text: raw.slice(1), old: oldLine++, new: null });
    else if (rows.length) rows.push({ kind: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw, old: oldLine++, new: newLine++ });
  }
  return rows;
}

/** Whether the patch shows `line` on the head, i.e. a comment there can be anchored to it. */
export function patchHasLine(rows: readonly DiffRow[], line: number): boolean {
  return rows.some(r => r.new === line);
}
