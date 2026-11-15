import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { expectedShape, missingFromDatabase, type DmmfLike } from './schemaCoverage';

const dmmf: DmmfLike = {
  models: [
    {
      name: 'User',
      dbName: 'users',
      fields: [
        { name: 'id', kind: 'scalar', type: 'String', isList: false },
        { name: 'fooBar', kind: 'scalar', type: 'Int', isList: false, dbName: 'foo_bar' },
        { name: 'kind', kind: 'enum', type: 'Kind', isList: false },
        { name: 'tags', kind: 'scalar', type: 'String', isList: true },
        { name: 'projects', kind: 'object', type: 'Project', isList: true },
      ],
    },
    { name: 'Project', dbName: null, fields: [{ name: 'id', kind: 'scalar', type: 'BigInt', isList: false }] },
  ],
  enums: [{ name: 'Kind', dbName: 'kind_t', values: [{ name: 'ONE' }, { name: 'TWO', dbName: 'two' }] }],
};

// `table.column` → information_schema.columns.udt_name
const covered = {
  columns: new Map([['users.id', 'text'], ['users.foo_bar', 'int4'], ['users.kind', 'kind_t'], ['users.tags', '_text'], ['Project.id', 'int8']]),
  enumValues: new Set(['kind_t.ONE', 'kind_t.two']),
};

describe('expectedShape', () => {
  it('names tables, columns and enum labels as Postgres does, without relation fields', () => {
    const shape = expectedShape(dmmf);
    expect([...shape.tables]).toEqual([
      ['users', [
        { name: 'id', types: ['text', 'varchar', 'bpchar'] },
        { name: 'foo_bar', types: ['int4', 'int2'] },
        { name: 'kind', types: ['kind_t'] },
        { name: 'tags', types: ['_text', '_varchar', '_bpchar'] },
      ]],
      ['Project', [{ name: 'id', types: ['int8'] }]],
    ]);
    expect([...shape.enums]).toEqual([['kind_t', ['ONE', 'two']]]);
  });

  it('reads the generated client: users carries the column the 2026-11-09 outage lacked', () => {
    const shape = expectedShape(Prisma.dmmf.datamodel as unknown as DmmfLike);
    expect(shape.tables.get('users')?.map(c => c.name)).toContain('chatNudgeDismissedAt');
    expect(shape.tables.size).toBeGreaterThan(50);
  });
});

describe('missingFromDatabase', () => {
  const shape = expectedShape(dmmf);

  it('is empty when the database has everything, extras included (a rolled-back image)', () => {
    const ahead = {
      columns: new Map([...covered.columns, ['users.newer_col', 'text'], ['newer_table.id', 'int4']]),
      enumValues: new Set([...covered.enumValues, 'kind_t.THREE']),
    };
    expect(missingFromDatabase(shape, covered)).toEqual([]);
    expect(missingFromDatabase(shape, ahead)).toEqual([]);
  });

  it('lists a missing column, table and enum value', () => {
    const behind = { columns: new Map([['users.id', 'text'], ['users.kind', 'kind_t'], ['users.tags', '_text']]), enumValues: new Set(['kind_t.ONE']) };
    expect(missingFromDatabase(shape, behind)).toEqual(['column users.foo_bar', 'table Project', 'enum value kind_t.two']);
  });

  it('lists a column whose type differs from the schema (a type change the additive push skipped)', () => {
    const skippedTypeChange = {
      columns: new Map([...covered.columns, ['users.foo_bar', 'text'], ['users.tags', 'text'], ['Project.id', 'int4']]),
      enumValues: covered.enumValues,
    };
    expect(missingFromDatabase(shape, skippedTypeChange)).toEqual([
      'column users.foo_bar is text, the schema wants int4',
      'column users.tags is text, the schema wants _text',
      'column Project.id is int4, the schema wants int8',
    ]);
  });

  it('accepts a column of a type the field reads and writes alike (varchar for String)', () => {
    const varchar = { columns: new Map([...covered.columns, ['users.id', 'varchar']]), enumValues: covered.enumValues };
    expect(missingFromDatabase(shape, varchar)).toEqual([]);
  });

  it('every column the generated client reads has a known Postgres type', () => {
    const shape = expectedShape(Prisma.dmmf.datamodel as unknown as DmmfLike);
    for (const [table, columns] of shape.tables) {
      for (const c of columns) expect(c.types, `${table}.${c.name}`).not.toHaveLength(0);
    }
  });
});
