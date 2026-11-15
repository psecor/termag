/**
 * Who filed something from the CLI, and from where: shared by bug reports
 * (services/bugReports.ts) and feedback
 * (services/feedback.ts). Pure; the Prisma resolver is
 * services/cliReporterPrisma.ts.
 *
 * The CLI sends its version, the coding agent and this session's
 * TERMAG_PROJECT_ID / TERMAG_WORKSTREAM. Nothing it claims about where it
 * runs is taken on trust: the resolver keeps the project only when it is the
 * reporter's (and, for a box token, on that box).
 */
import { redactSecrets } from './secretPatterns';

/** Where a report came from, as the orchestrator itself resolved it. */
export interface Reporter {
  reporterUserId: string;
  credential: 'box' | 'device';
  boxId: string | null;
  projectId: string | null;
  workstream: string | null;
  threadId: string | null;
  boxAgentCommit: string | null;
  boxAgentCapabilities: string[];
}

export type ReporterBase = Pick<Reporter, 'reporterUserId' | 'credential' | 'boxId'>;
export interface ClaimedPlace { projectId: string | null; workstream: string | null }

/** Resolves the caller's claimed project and workstream against what the orchestrator knows. */
export type ResolveReporter = (base: ReporterBase, claimed: ClaimedPlace) => Promise<Reporter>;

/** What the CLI says about itself and its agent, as it sent it (redacted, trimmed). */
export interface ClientContext {
  cliVersion: string | null;
  agentProvider: string | null;
  agentModel: string | null;
  agentVersion: string | null;
}

export const SHORT_FIELD = 200;

/** The ask thread a workstream belongs to: an ask runs in `ask-<thread id>`. */
export function threadIdOf(workstream: string | null): string | null {
  const m = workstream?.match(/^ask-([A-Za-z0-9]{8,40})$/);
  return m ? m[1] : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** A short single-line field: trimmed, at most SHORT_FIELD, null when empty or absent. */
export function shortField(v: unknown): string | null {
  const s = str(v)?.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, SHORT_FIELD) : null;
}

/** True when the text holds anything `redactSecrets` would replace. */
function secretShaped(text: string): boolean {
  return redactSecrets(text).redacted.length > 0;
}

/**
 * The project and workstream the caller claims, when they are well-formed ids.
 * An id that is secret-shaped (a token pasted as a workstream name) is dropped
 * rather than redacted: it is a name, and a redacted name says nothing.
 */
export function parseClaimedPlace(b: Record<string, unknown>): ClaimedPlace {
  const projectId = str(b.projectId)?.trim() || null;
  const workstream = str(b.workstream)?.trim() || null;
  return {
    projectId: projectId && /^[A-Za-z0-9_-]{1,80}$/.test(projectId) && !secretShaped(projectId) ? projectId : null,
    workstream: workstream && /^[A-Za-z0-9_.-]{1,100}$/.test(workstream) && !secretShaped(workstream) ? workstream : null,
  };
}

/**
 * A redactor that collects the kinds of secret-shaped strings it replaced,
 * across every field it is given (`[redacted: GitHub token]`).
 */
export function redactor(): { clean: (s: string | null) => string | null; redacted: Set<string> } {
  const redacted = new Set<string>();
  return {
    redacted,
    clean: s => {
      if (s === null) return null;
      const r = redactSecrets(s);
      for (const k of r.redacted) redacted.add(k);
      return r.text;
    },
  };
}

/** The CLI's version and agent fields, each a short field, redacted. */
export function parseClientContext(b: Record<string, unknown>, clean: (s: string | null) => string | null): ClientContext {
  return {
    cliVersion: clean(shortField(b.cliVersion)),
    agentProvider: clean(shortField(b.agentProvider)),
    agentModel: clean(shortField(b.agentModel)),
    agentVersion: clean(shortField(b.agentVersion)),
  };
}

/** The request's `base` reporter from the CLI route's bearer check. */
export function reporterBase(user: { id: string }, credential: { kind: 'box'; boxId: string | null } | { kind: 'device' }): ReporterBase {
  return { reporterUserId: user.id, credential: credential.kind, boxId: credential.kind === 'box' ? credential.boxId : null };
}
