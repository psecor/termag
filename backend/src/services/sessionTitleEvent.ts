/**
 * A chat's session title as the `session.titled` product event
 * (docs/agents/observability.md): what a session is about, in a few words,
 * which the rest of the telemetry never says (prompts and tool content stay
 * on the box). The one product event that carries text a person or Claude
 * wrote, so it is the owner's to turn off: Settings > Telemetry
 * (`User.telemetryTitles`), on until they do. Sent only when a title changes
 * (saveSessionTitle's write, a person's rename), with the project and
 * workstream it names, the box the chat runs on and who renamed it.
 */
import { prisma } from '../db';
import { recordProductEvent } from './productEvents';

export interface SessionTitleChange {
  projectId: string;
  workstream: string;
  title: string;
  /** `claude`: Claude's own or the box's generated title; `person`: a rename. */
  source: 'claude' | 'person';
}

/** The event's detail. Pure. */
export function sessionTitleDetail(c: SessionTitleChange, projectName: string): Record<string, string> {
  return { title: c.title, source: c.source, project: projectName, workstream: c.workstream };
}

/** Record the change unless the project's owner turned titles off. Never throws. */
export async function recordSessionTitle(c: SessionTitleChange, record = recordProductEvent): Promise<void> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: c.projectId },
      select: { name: true, instanceId: true, user: { select: { id: true, telemetryTitles: true } } },
    });
    if (!project?.user || project.user.telemetryTitles === false) return;
    record('session.titled', { user: project.user.id, box: project.instanceId }, sessionTitleDetail(c, project.name));
  } catch (err) {
    console.warn('[CHAT] session title event not recorded:', err instanceof Error ? err.message : String(err));
  }
}
