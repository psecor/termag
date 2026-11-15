/**
 * Does the database have every table, column and enum value schema.prisma
 * declares, each column of a type its field reads and writes? Checks the
 * outcome rather than db:push's exit code, which is 0 for a skipped additive
 * push (./schemaSync.ts), and a skip can leave a column with its old name and
 * its old type. Extras in the database are fine: a rolled-back image reads a
 * subset.
 */

export interface DmmfLike {
  models: ReadonlyArray<{
    name: string;
    dbName: string | null;
    fields: ReadonlyArray<{ name: string; kind: string; type: string; isList: boolean; dbName?: string | null }>;
  }>;
  enums: ReadonlyArray<{
    name: string;
    dbName?: string | null;
    values: ReadonlyArray<{ name: string; dbName?: string | null }>;
  }>;
}

/** What the database has, from information_schema and pg_enum. */
export interface DatabaseShape {
  /** `table.column` → its information_schema `udt_name` (`int4`, `text`, `_text` for text[], an enum's type name) */
  columns: ReadonlyMap<string, string>;
  /** `type.label` */
  enumValues: ReadonlySet<string>;
}

export interface ExpectedColumn {
  name: string;
  /** The udt_names the field reads and writes; the first is what db:push creates. */
  types: readonly string[];
}

export interface ExpectedShape {
  /** table → its columns */
  tables: ReadonlyMap<string, readonly ExpectedColumn[]>;
  /** enum type → its labels */
  enums: ReadonlyMap<string, readonly string[]>;
}

// Prisma scalar → the udt_names a column of it can have. The client's DMMF
// drops `@db.*` native types, so each list holds every native type Prisma maps
// the scalar to on Postgres that schema.prisma uses (e.g. `@db.VarChar`,
// `@db.Json`, `@db.Timestamp(6)` on Session); the first is Prisma's default.
const SCALAR_UDT: Readonly<Record<string, readonly string[]>> = {
  String: ['text', 'varchar', 'bpchar'],
  Int: ['int4', 'int2'],
  BigInt: ['int8'],
  Float: ['float8', 'float4'],
  Decimal: ['numeric'],
  Boolean: ['bool'],
  DateTime: ['timestamp', 'timestamptz', 'date'],
  Json: ['jsonb', 'json'],
  Bytes: ['bytea'],
};

/** Tables, columns and enum labels as Postgres names them (`@@map` / `@map` applied), with each column's types. */
export function expectedShape(dmmf: DmmfLike): ExpectedShape {
  const enumDbName = new Map(dmmf.enums.map(e => [e.name, e.dbName ?? e.name]));
  const tables = new Map<string, ExpectedColumn[]>();
  for (const model of dmmf.models) {
    // Relation fields (kind "object") have no column of their own.
    const columns = model.fields.filter(f => f.kind === 'scalar' || f.kind === 'enum').map(f => {
      const base = f.kind === 'enum' ? [enumDbName.get(f.type) ?? f.type] : SCALAR_UDT[f.type] ?? [];
      // Postgres names an array type by its element's, prefixed with `_`.
      return { name: f.dbName ?? f.name, types: f.isList ? base.map(t => `_${t}`) : base };
    });
    tables.set(model.dbName ?? model.name, columns);
  }
  const enums = new Map<string, string[]>();
  for (const e of dmmf.enums) enums.set(e.dbName ?? e.name, e.values.map(v => v.dbName ?? v.name));
  return { tables, enums };
}

/**
 * Each thing the schema declares that the database lacks or has with another
 * type, one line each; empty when covered. A column with no known types (a
 * scalar missing from SCALAR_UDT) is checked by name only.
 */
export function missingFromDatabase(expected: ExpectedShape, db: DatabaseShape): string[] {
  const tablesInDb = new Set([...db.columns.keys()].map(c => c.slice(0, c.indexOf('.'))));
  const missing: string[] = [];
  for (const [table, columns] of expected.tables) {
    if (!tablesInDb.has(table)) {
      missing.push(`table ${table}`);
      continue;
    }
    for (const column of columns) {
      const actual = db.columns.get(`${table}.${column.name}`);
      if (actual === undefined) missing.push(`column ${table}.${column.name}`);
      else if (column.types.length > 0 && !column.types.includes(actual)) {
        missing.push(`column ${table}.${column.name} is ${actual}, the schema wants ${column.types[0]}`);
      }
    }
  }
  for (const [type, labels] of expected.enums) {
    for (const label of labels) {
      if (!db.enumValues.has(`${type}.${label}`)) missing.push(`enum value ${type}.${label}`);
    }
  }
  return missing;
}

type QueryRaw = <T>(query: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/** Reads the database's columns (with their types) and enum labels in the connection's current schema. */
export async function readDatabaseShape(queryRaw: QueryRaw): Promise<DatabaseShape> {
  const columns = await queryRaw<{ t: string; c: string; u: string }[]>`
    SELECT table_name::text AS t, column_name::text AS c, udt_name::text AS u
    FROM information_schema.columns WHERE table_schema = current_schema()`;
  const labels = await queryRaw<{ t: string; v: string }[]>`
    SELECT t.typname::text AS t, e.enumlabel::text AS v
    FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = current_schema()`;
  return {
    columns: new Map(columns.map(r => [`${r.t}.${r.c}`, r.u])),
    enumValues: new Set(labels.map(r => `${r.t}.${r.v}`)),
  };
}
