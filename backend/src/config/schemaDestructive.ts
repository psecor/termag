/**
 * Which statements in a `prisma migrate diff --script` (base schema → PR schema)
 * would make boot-time additive db:push refuse the whole sync on a database
 * whose tables hold data (./schemaSync.ts). schema CI (.github/workflows/schema-ci.yml)
 * fails a PR that has any, unless it carries the `schema-destructive-ok` label.
 */

/** One line per statement that drops or narrows something existing; empty when the change is additive. */
export function destructiveStatements(sql: string): string[] {
  const statements = sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const created = new Set(statements.map(s => s.match(/^CREATE TABLE "([^"]+)"/i)?.[1]).filter((t): t is string => !!t));

  const found: string[] = [];
  for (const s of statements) {
    const table = s.match(/^ALTER TABLE "([^"]+)"/i)?.[1];
    if (/^DROP TABLE/i.test(s)) found.push(s);
    else if (/^DROP TYPE/i.test(s)) found.push(s);
    else if (/^CREATE UNIQUE INDEX .* ON "([^"]+)"/i.test(s)) {
      const on = s.match(/ ON "([^"]+)"/i)![1];
      if (!created.has(on)) found.push(s);
    } else if (table) {
      // One ALTER TABLE can carry several comma-separated actions.
      for (const action of s.replace(/^ALTER TABLE "[^"]+"\s*/i, '').split(/,\s*(?=(?:ADD|DROP|ALTER|RENAME)\b)/i)) {
        const a = action.trim();
        if (/^DROP COLUMN/i.test(a)) found.push(`ALTER TABLE "${table}" ${a}`);
        else if (/^ALTER COLUMN .* (SET DATA )?TYPE /i.test(a)) found.push(`ALTER TABLE "${table}" ${a}`);
        else if (/^ALTER COLUMN .* SET NOT NULL/i.test(a)) found.push(`ALTER TABLE "${table}" ${a}`);
        else if (/^ADD COLUMN /i.test(a) && /\bNOT NULL\b/i.test(a) && !/\bDEFAULT\b/i.test(a)) found.push(`ALTER TABLE "${table}" ${a}`);
      }
    }
  }
  return found;
}
