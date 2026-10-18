import { prisma } from '../db';
import { exec } from 'child_process';
import { promisify } from 'util';
import { projectDir } from './tmux';

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

export function mainWorkstreamBranch(input: {
  requested?: string | null;
  instanceId: string | null;
  detected: string;
}): string {
  const requested = input.requested?.trim();
  if (requested) return requested;
  if (input.instanceId) return 'main';
  return input.detected.trim() || 'main';
}

export async function ensureMainWorkstream(
  projectId: string,
  opts?: { branch?: string },
): Promise<{ id: string; name: string }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, instanceId: true, user: { select: { unixUsername: true } } },
  });

  const requested = opts?.branch;
  let detected = 'main';
  if (project && !requested?.trim() && !project.instanceId) {
    detected = await detectDefaultBranch(projectDir(project.user.unixUsername, project.name));
  }
  const branch = mainWorkstreamBranch({
    requested,
    instanceId: project?.instanceId ?? null,
    detected,
  });

  return prisma.workstream.upsert({
    where: { projectId_name: { projectId, name: 'main' } },
    create: { projectId, name: 'main', branch },
    update: {},
    select: { id: true, name: true },
  });
}
