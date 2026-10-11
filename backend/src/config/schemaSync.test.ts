import { describe, it, expect } from 'vitest';
import { classifyPushResult, prismaPushArgs, schemaSyncMode } from './schemaSync';

// Prisma 5.22's output when it refuses a push over data-loss warnings.
const REFUSAL = `Prisma schema loaded from prisma/schema.prisma
Datasource "db": PostgreSQL database "termag", schema "public" at "127.0.0.1:5432"

⚠️  There might be data loss when applying the changes:

  • You are about to drop the column \`future_col\` on the \`users\` table, which still contains 1 non-null values.

  • You are about to drop the \`future_table\` table, which is not empty (1 rows).


Error: Use the --accept-data-loss flag to ignore the data loss warnings like prisma db push --accept-data-loss
`;

describe('schemaSyncMode', () => {
  it('defaults to accept-data-loss, the behaviour every existing caller has', () => {
    expect(schemaSyncMode({})).toBe('accept-data-loss');
    expect(schemaSyncMode({ DB_PUSH_MODE: '' })).toBe('accept-data-loss');
    expect(schemaSyncMode({ DB_PUSH_MODE: 'accept-data-loss' })).toBe('accept-data-loss');
  });

  it('accepts additive, case- and whitespace-insensitively', () => {
    expect(schemaSyncMode({ DB_PUSH_MODE: ' Additive ' })).toBe('additive');
  });

  it('rejects anything else instead of guessing', () => {
    expect(() => schemaSyncMode({ DB_PUSH_MODE: 'safe' })).toThrow(/DB_PUSH_MODE/);
  });
});

describe('prismaPushArgs', () => {
  it('passes --accept-data-loss only in the default mode', () => {
    expect(prismaPushArgs('accept-data-loss')).toEqual(['db', 'push', '--accept-data-loss', '--skip-generate']);
    expect(prismaPushArgs('additive')).toEqual(['db', 'push', '--skip-generate']);
  });
});

describe('classifyPushResult', () => {
  it('treats exit 0 as applied in either mode', () => {
    expect(classifyPushResult('additive', 0, '')).toEqual({ kind: 'applied' });
    expect(classifyPushResult('accept-data-loss', 0, '')).toEqual({ kind: 'applied' });
  });

  it('turns a data-loss refusal into a skip in additive mode, keeping the warnings', () => {
    expect(classifyPushResult('additive', 1, REFUSAL)).toEqual({
      kind: 'skipped-data-loss',
      warnings: [
        'You are about to drop the column `future_col` on the `users` table, which still contains 1 non-null values.',
        'You are about to drop the `future_table` table, which is not empty (1 rows).',
      ],
    });
  });

  it('never hides a refusal in the default mode (it cannot happen there, but if it did it is a failure)', () => {
    expect(classifyPushResult('accept-data-loss', 1, REFUSAL)).toEqual({ kind: 'failed', status: 1 });
  });

  it('keeps any other failure a failure, e.g. an unreachable database or an unexecutable change', () => {
    expect(classifyPushResult('additive', 1, "Error: P1001: Can't reach database server")).toEqual({ kind: 'failed', status: 1 });
    expect(classifyPushResult('additive', null, '')).toEqual({ kind: 'failed', status: 1 });
  });
});
