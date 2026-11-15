/**
 * The backfill script's arguments and its dry-run report
 * (scripts/userProjectsBackfill.ts).
 * Pure, so the report's shape is tested without a database.
 */
import type { PlanEntry } from './userProjects';

export type BackfillArgs = { ok: true; dryRun: boolean; user: string | null } | { ok: false; error: string };

const USAGE = 'usage: npm run user-projects:backfill -- [--dry-run] [--user <email>]';

export function parseBackfillArgs(argv: readonly string[]): BackfillArgs {
  let dryRun = false;
  let user: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--user') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) return { ok: false, error: `--user needs an email\n${USAGE}` };
      user = v.trim();
      if (!user) return { ok: false, error: `--user needs an email\n${USAGE}` };
    } else if (a.startsWith('--user=')) {
      // A blank value (an unset variable) must never widen a one-person run to everyone.
      user = a.slice('--user='.length).trim();
      if (!user) return { ok: false, error: `--user needs an email\n${USAGE}` };
    }
    else return { ok: false, error: `unknown argument ${a}\n${USAGE}` };
  }
  return { ok: true, dryRun, user };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One person's dry run: a header, then a line per group with what it would do
 * (`new` project, or `joins` one they have), its name, its repo set and how
 * many checkouts it takes.
 */
export function formatBackfillPlan(email: string, plan: readonly PlanEntry[], already: { attached: number; projects: number }): string {
  const pending = plan.reduce((n, e) => n + e.checkoutIds.length, 0);
  const head = `${email}: ${plural(plan.length, 'group')}, ${plural(pending, 'checkout')} to attach`
    + ` (already: ${plural(already.projects, 'project')}, ${plural(already.attached, 'checkout')} attached)`;
  if (plan.length === 0) return head;
  const setOf = (e: PlanEntry) => e.repoSetKey || '(no repository)';
  const nameWidth = Math.max(...plan.map(e => e.name.length));
  const setWidth = Math.max(...plan.map(e => setOf(e).length));
  const rows = plan.map(e => [
    '  ',
    (e.existing ? 'joins' : 'new').padEnd(6),
    e.name.padEnd(nameWidth + 2),
    setOf(e).padEnd(setWidth + 2),
    plural(e.checkoutIds.length, 'checkout'),
  ].join(''));
  return [head, ...rows].join('\n');
}
