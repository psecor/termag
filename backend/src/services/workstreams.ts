import { PrismaClient } from '@prisma/client';
import { exec } from 'child_process';
import { promisify } from 'util';
import { projectDir } from './tmux';

const prisma = new PrismaClient();
const execAsync = promisify(exec);

async function detectDefaultBranch(dir: string): Promise<string> {
  // `symbolic-ref --short HEAD` returns the initial branch name even on a
  // freshly-init'd repo with no commits (HEAD already points at refs/heads/<x>).
  try {
    const { stdout } = await execAsync(
      `git -C '${dir.replace(/'/g, "'\\''")}' symbolic-ref --short HEAD`,
    );
    return stdout.trim() || 'main';
  } catch {
    return 'main';
  }
}

export async function ensureMainWorkstream(
  projectId: string,
): Promise<{ id: string; name: string }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, user: { select: { unixUsername: true } } },
  });

  const branch = project
    ? await detectDefaultBranch(projectDir(project.user.unixUsername, project.name))
    : 'main';

  return prisma.workstream.upsert({
    where: { projectId_name: { projectId, name: 'main' } },
    create: { projectId, name: 'main', branch },
    update: {},
    select: { id: true, name: true },
  });
}
