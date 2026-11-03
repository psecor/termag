import { describe, expect, it } from 'vitest';
import { parsePatch, patchHasLine } from './diff';

const PATCH = [
  '@@ -230,7 +230,9 @@ function dialBack(id, ws, target) {',
  '   function tick() {',
  '-    const now = Date.now();',
  '+    const now = performance.now();',
  '+    // Paused, and nothing taken for a minute: wedged.',
  '+    if (paused && now - lastProgress > STALL_MS) {',
  '   }',
  '\\ No newline at end of file',
].join('\n');

describe('parsePatch', () => {
  it('numbers both sides of each row from the hunk header', () => {
    const rows = parsePatch(PATCH);
    expect(rows.map(r => [r.kind, r.old, r.new])).toEqual([
      ['hunk', null, null], ['ctx', 230, 230], ['del', 231, null], ['add', null, 231], ['add', null, 232], ['add', null, 233], ['ctx', 232, 234],
    ]);
    expect(rows[5].text).toBe('    if (paused && now - lastProgress > STALL_MS) {');
  });

  it('keeps a hunk that ends on a blank line, and drops only the newline after the patch', () => {
    const rows = parsePatch('@@ -1,2 +1,3 @@\n a\n+b\n \n');
    expect(rows.map(r => [r.kind, r.text, r.new])).toEqual([['hunk', '@@ -1,2 +1,3 @@', null], ['ctx', 'a', 1], ['add', 'b', 2], ['ctx', '', 3]]);
    expect(patchHasLine(rows, 3)).toBe(true);
  });

  it('knows which head lines a comment can sit on', () => {
    const rows = parsePatch(PATCH);
    expect(patchHasLine(rows, 233)).toBe(true);
    expect(patchHasLine(rows, 231 - 1)).toBe(true);
    expect(patchHasLine(rows, 300)).toBe(false);
    expect(parsePatch(null)).toEqual([]);
  });
});
