/**
 * `tsx src/scripts/schemaDestructiveCheck.ts <base schema.prisma> <head schema.prisma>`
 *
 * Exit 1 when the change from base to head drops or narrows something that may
 * hold data (../config/schemaDestructive.ts), unless SCHEMA_DESTRUCTIVE_OK=true
 * (the PR's `schema-destructive-ok` label), which only prints them. Until such
 * a change is applied to the database by hand, every boot's additive db:push
 * skips, so the label means someone will apply it right after this deploys.
 */
import { spawnSync } from 'child_process';
import { join } from 'path';
import { destructiveStatements } from '../config/schemaDestructive';

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('usage: schemaDestructiveCheck.ts <base schema.prisma> <head schema.prisma>');
  process.exit(2);
}

const prisma = join(__dirname, '..', '..', 'node_modules', '.bin', 'prisma');
const diff = spawnSync(prisma, ['migrate', 'diff', '--from-schema-datamodel', base, '--to-schema-datamodel', head, '--script'], {
  encoding: 'utf8',
  env: { ...process.env, CHECKPOINT_DISABLE: '1' },
});
if (diff.status !== 0) {
  console.error(diff.stdout, diff.stderr);
  process.exit(diff.status ?? 1);
}

const found = destructiveStatements(diff.stdout);
if (found.length === 0) {
  console.log('schema change is additive');
  process.exit(0);
}
const allowed = process.env.SCHEMA_DESTRUCTIVE_OK === 'true';
const say = allowed ? console.log : console.error;
say(`schema change drops or narrows ${found.length} thing(s) that may hold data:`);
for (const s of found) say(`  - ${s}`);
if (allowed) {
  console.log('allowed by the schema-destructive-ok label: apply each one to the production database by hand right after this deploys.');
  process.exit(0);
}
console.error('Boot-time db:push (additive) refuses the whole sync while any of these would lose data, so later schema');
console.error('changes never reach the database (and db:push then fails the boot of any image that needs them).');
console.error('Either keep the field in schema.prisma, unused, or add the schema-destructive-ok label and apply these');
console.error('to the production database by hand right after this deploys.');
process.exit(1);
