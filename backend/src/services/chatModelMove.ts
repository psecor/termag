// A simple-UI chat's tier moves from its project (projects.claudeModel, #594)
// to its chat workstreams' agent rows, where the chat reads it now.
// Prod converges its schema with `prisma db push`, which
// runs no SQL migration, so the move runs at startup. Each project is moved
// once: its tier goes onto the chat rows that have no choice yet, and the
// project's column is cleared, so a chat switched to Auto afterwards is not
// filled again on the next start.
import { prisma } from '../db';
import { CHAT_PROVIDER_ID } from '../providers/registry';
import { parseClaudeChatModel } from './claudeChatModel';

export async function moveChatModelsToWorkflows(): Promise<number> {
  const projects = await prisma.project.findMany({ where: { claudeModel: { not: null } }, select: { id: true, claudeModel: true } });
  for (const p of projects) {
    const tier = parseClaudeChatModel(p.claudeModel);
    await prisma.$transaction([
      ...(tier.ok && tier.model ? [prisma.workflow.updateMany({
        where: { projectId: p.id, type: 'agent', provider: CHAT_PROVIDER_ID, backend: null, model: null },
        data: { model: tier.model },
      })] : []),
      prisma.project.update({ where: { id: p.id }, data: { claudeModel: null } }),
    ]);
  }
  return projects.length;
}
