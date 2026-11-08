import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// What runs in production is `prisma db push` (docs/agents/data-and-schema.md); the migration is the
// record, and an overlapping deploy syncs with DB_PUSH_MODE=additive. So it must only add, and say
// exactly what the schema now declares.
const root = join(__dirname, '../../..');
const sql = readFileSync(join(root, 'prisma/migrations/20261102120000_tool_auto_update/migration.sql'), 'utf8');
const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
const statements = sql.split('\n').filter(l => !l.startsWith('--')).join('\n').split(';').map(s => s.trim()).filter(Boolean);
const model = (name: string) => schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf('\n}\n', schema.indexOf(`model ${name} {`)));

describe('the tool_auto_update migration', () => {
  it('only adds: nullable columns and a new table', () => {
    expect(statements).toHaveLength(3);
    for (const s of statements) expect(s).toMatch(/^(ALTER TABLE "\w+" ADD COLUMN "\w+" (TEXT|TIMESTAMP\(3\))|CREATE TABLE "tool_auto_update_states")/);
    const code = statements.join(';\n');
    expect(code).not.toMatch(/\b(DROP|RENAME|ALTER COLUMN)\b/);
    // An added column on a table with rows must not be NOT NULL (the old process mid-deploy cannot write it).
    for (const s of statements.filter(x => x.startsWith('ALTER TABLE'))) expect(s).not.toMatch(/NOT NULL/);
  });

  it('matches the schema', () => {
    expect(statements).toContain('ALTER TABLE "software_update_runs" ADD COLUMN "reason" TEXT');
    expect(model('SoftwareUpdateRun')).toMatch(/\n\s+reason\s+String\?/);
    expect(statements).toContain('ALTER TABLE "instances" ADD COLUMN "resumedFromHibernationAt" TIMESTAMP(3)');
    expect(model('Instance')).toMatch(/\n\s+resumedFromHibernationAt\s+DateTime\?/);
    const state = model('ToolAutoUpdateState');
    expect(state).toContain('@@map("tool_auto_update_states")');
    expect(state).toContain('@@id([hostKey, component])');
    for (const [col, type] of [['hostKey', 'TEXT NOT NULL'], ['component', 'TEXT NOT NULL'], ['firstSeenAt', 'TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP'], ['lastSeenAt', 'TIMESTAMP(3)'], ['breachFloor', 'TEXT'], ['breachSince', 'TIMESTAMP(3)'], ['breachSeenAt', 'TIMESTAMP(3)']]) {
      expect(sql).toContain(`"${col}" ${type},`);
      expect(state).toMatch(new RegExp(`\\n\\s+${col}\\s`));
    }
    expect(sql).toContain('PRIMARY KEY ("hostKey","component")');
  });
});
