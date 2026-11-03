/**
 * Who asked, for an ask turn's telemetry resource (docs/agents/gotchas.md, the
 * agent telemetry resource): the thread, the message's hop, and the session
 * that started the thread (its box, project and workstream when the
 * orchestrator could check them, askService.askParent, and the Claude Code
 * session id the CLI sent). The box's chat runner hands these to
 * `termag-credentials telemetry-launch` as TERMAG_ASK_*, which writes
 * `termag.ask.*` and drops any value it does not accept; an older box ignores
 * them. A telemetry reader can roll a thread's spend up under `termag.ask.parent.session`.
 */
import { prisma } from '../db';

export interface AskTelemetry {
  thread: string;
  /** The message's hop on the thread; none for a person's turn in the thread's chat. */
  hop?: number;
  parent?: { box?: string; project?: string; workstream?: string; session?: string };
}

export interface AskTelemetryThread {
  id: string;
  parentProjectId?: string | null;
  parentWorkstream?: string | null;
  parentClaudeSession?: string | null;
}

/** The parent project's name and box, as askParentFacts reads them; null when the thread has none or it is gone. */
export interface AskParentFacts { project: string; box: string | null }

/** What an ask turn's resource names: pure, so the agent and the script only ever see what is set. */
export function askTelemetry(thread: AskTelemetryThread, facts: AskParentFacts | null, hop: number | null = null): AskTelemetry {
  const parent: NonNullable<AskTelemetry['parent']> = {};
  if (facts && thread.parentWorkstream) {
    parent.project = facts.project;
    parent.workstream = thread.parentWorkstream;
    if (facts.box) parent.box = facts.box;
  }
  if (thread.parentClaudeSession) parent.session = thread.parentClaudeSession;
  return {
    thread: thread.id,
    ...(hop != null && Number.isSafeInteger(hop) && hop > 0 ? { hop } : {}),
    ...(Object.keys(parent).length ? { parent } : {}),
  };
}

/** The thread's parent project's current name and box name. Never throws: telemetry never fails a turn. */
export async function askParentFacts(thread: AskTelemetryThread): Promise<AskParentFacts | null> {
  if (!thread.parentProjectId) return null;
  const p = await prisma.project.findUnique({
    where: { id: thread.parentProjectId },
    select: { name: true, instance: { select: { name: true } } },
  }).catch(() => null);
  return p ? { project: p.name, box: p.instance?.name ?? null } : null;
}

/** askTelemetry with the facts read; what `ask-run` and an ask chat's `chat-send` carry as `telemetry`. */
export async function askTelemetryFor(thread: AskTelemetryThread, hop: number | null = null): Promise<AskTelemetry> {
  return askTelemetry(thread, await askParentFacts(thread), hop);
}
