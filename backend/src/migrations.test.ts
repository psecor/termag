import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// prisma migrate deploy applies every directory under prisma/migrations in name order.
// A branch that carried a migration under one timestamp and then merged main, where
// the same change landed under another, ends up with both; the second ALTER fails
// because the column exists, and deploy stops there.

const dir = resolve(__dirname, '../prisma/migrations');
const migrations = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

// `<table>.<column>` for each column a migration adds without IF NOT EXISTS.
function addedColumns(sql: string): string[] {
  const out: string[] = [];
  for (const stmt of sql.replace(/--.*$/gm, '').split(';')) {
    const table = stmt.match(/ALTER TABLE\s+"([^"]+)"/i)?.[1];
    if (!table) continue;
    for (const m of stmt.matchAll(/ADD COLUMN\s+(IF NOT EXISTS\s+)?"([^"]+)"/gi)) {
      if (!m[1]) out.push(`${table}.${m[2]}`);
    }
  }
  return out;
}

describe('prisma migrations', () => {
  it('found them', () => {
    expect(migrations.length).toBeGreaterThan(10);
  });

  it('add each column once', () => {
    const firstAddedBy = new Map<string, string>();
    const twice: string[] = [];
    for (const name of migrations) {
      for (const col of addedColumns(readFileSync(join(dir, name, 'migration.sql'), 'utf8'))) {
        const first = firstAddedBy.get(col);
        if (first) twice.push(`${col}: ${first} and ${name}`);
        else firstAddedBy.set(col, name);
      }
    }
    expect(twice).toEqual([]);
  });
});
