/**
 * `npm run user-projects:backfill -- [--dry-run] [--user <email>]`: give each
 * person's checkouts that have no project one
 * . With --dry-run nothing is written: it prints, per
 * person, each group it would make or join, with its name, repo set and number
 * of checkouts. Without it, it runs ensureUserProjects for each, flag or not
 * (the reads run it anyway for anyone with user-projects-enabled on). --user
 * takes one person by their Google email; without it, everyone with a checkout
 * that has no project. Safe to run again. Exit 0, or 1 on an error.
 */
import 'dotenv/config';
import '../config/bootstrap';
import { prisma } from '../db';
import { USER_PROJECT_KINDS, ensureUserProjects, planUserProjects } from '../services/userProjects';
import { formatBackfillPlan, parseBackfillArgs } from '../services/userProjectsBackfill';

async function main(): Promise<number> {
  const args = parseBackfillArgs(process.argv.slice(2));
  if (!args.ok) {
    console.error(args.error);
    return 1;
  }
  const kinds = { in: [...USER_PROJECT_KINDS] };
  const users = args.user
    ? await prisma.user.findMany({ where: { googleEmail: { equals: args.user, mode: 'insensitive' } }, select: { id: true, googleEmail: true } })
    : await prisma.user.findMany({
      where: { projects: { some: { userProjectId: null, kind: kinds } } },
      select: { id: true, googleEmail: true },
      orderBy: { googleEmail: 'asc' },
    });
  if (args.user && users.length === 0) {
    console.error(`No user with the email ${args.user}`);
    return 1;
  }
  let groups = 0;
  let checkouts = 0;
  for (const user of users) {
    if (args.dryRun) {
      const [pending, attached, projects] = await Promise.all([
        prisma.project.findMany({
          where: { userId: user.id, userProjectId: null, kind: kinds },
          select: {
            id: true, kind: true, layout: true, repoUrl: true, repoDefaultBranch: true, lastActiveAt: true, createdAt: true,
            repos: { select: { url: true, defaultBranch: true, position: true } },
          },
        }),
        prisma.project.count({ where: { userId: user.id, userProjectId: { not: null } } }),
        prisma.userProject.findMany({
          where: { userId: user.id },
          select: { id: true, name: true, nameKey: true, repoSetKey: true, formerRepoSetKeys: true, archivedAt: true, createdAt: true },
        }),
      ]);
      const plan = planUserProjects(pending, projects);
      groups += plan.length;
      checkouts += pending.length;
      console.log(formatBackfillPlan(user.googleEmail, plan, { attached, projects: projects.length }));
    } else {
      const done = await ensureUserProjects(user.id);
      checkouts += done.attached;
      groups += done.created;
      console.log(`${user.googleEmail}: ${done.created} project(s) made, ${done.attached} checkout(s) attached`);
    }
  }
  console.error(args.dryRun
    ? `${users.length} person(s), ${groups} group(s), ${checkouts} checkout(s) (dry run; nothing written)`
    : `${users.length} person(s): ${groups} project(s) made, ${checkouts} checkout(s) attached`);
  return 0;
}

main().then(code => prisma.$disconnect().then(() => process.exit(code)), err => {
  console.error(err);
  process.exit(1);
});
