/**
 * The one line a pane shows before a tool update resumes or relaunches its
 * session, so its owner knows why it restarted.
 * The box types its own (deploy/termag-tool-update-lib,
 * tu_notice) into the panes it resumes; this is the same text for the agent
 * panes the orchestrator relaunches (runs.ts relaunchReportedPanes).
 *
 * It is typed into a shell, so it is built only from fixed words, the tool's
 * name, an allow-listed trigger and a version of a fixed shape, and the whole
 * line is checked against NOTICE_SAFE before it is returned: anything a box
 * reported that does not fit leaves the version or the line out, never types
 * it.
 */

/** Characters a notice may hold: none a shell or tmux would read as more than text. */
export const NOTICE_SAFE = /^[A-Za-z0-9 .,;:()\[\]_+-]{1,200}$/;
// A version as a box reports it (x.y.z, Node's x.y.z, Cursor's 2026.10.22-27dcf5f).
const VERSION = /^[0-9][A-Za-z0-9.+-]{0,39}$/;

/** Why the run happened, in the owner's words; a trigger with no restart (boot, guard) has none. */
const WHY: Record<string, string> = {
  manual: 'update requested by an admin',
  nightly: 'automatic nightly run',
  floor: 'automatic run: below the minimum version',
  resume: 'automatic run after the box resumed',
};

export interface NoticeInput {
  /** The tool's name as people know it (ToolDescriptor.displayName). */
  tool: string;
  /** The version the box is on now; left out when it is not a version. */
  version: string | null | undefined;
  /** The run's trigger, from its row. */
  trigger: string | null | undefined;
  /** The run's restart: none restarts nothing, so there is nothing to explain. */
  restart: string | null | undefined;
  /** Whether the pane continues its conversation (else it starts fresh). */
  resume: boolean;
}

/** The notice, or null when the run restarts nothing or its trigger is not one that restarts. */
export function restartNotice({ tool, version, trigger, restart, resume }: NoticeInput): string | null {
  if (restart !== 'idle' && restart !== 'force') return null;
  // Own keys only: a trigger named after an Object.prototype member is not one.
  const why = trigger && Object.prototype.hasOwnProperty.call(WHY, trigger) ? WHY[trigger] : undefined;
  if (!why) return null;
  const to = version && VERSION.test(version) ? ` to ${version}` : '';
  const line = `[termag] ${tool} was updated${to} (${why}); ${resume ? 'resuming your session' : 'starting a new session'}.`;
  return NOTICE_SAFE.test(line) ? line : null;
}

/**
 * A notice as a chat shows it (services/chatNotices.ts): a line a pane
 * printed, this module's or the box's tu_notice as the box reported it, kept
 * only when it is a restart notice (its `[termag] ` prefix) and NOTICE_SAFE
 * passes it. Anything else is null: dropped, never stored or shown.
 */
export function chatNoticeText(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('[termag] ') && NOTICE_SAFE.test(v) ? v : null;
}

/** The panes a chat notice may name: the agent pane, or another pane of the workstream (sessionAccess SESSION_ROLES). */
export const CHAT_NOTICE_PANES = ['agent', 'ctrl', 'review', 'data', 'data-ctrl'] as const;
export type ChatNoticePane = typeof CHAT_NOTICE_PANES[number];

/** One notice for one workstream's chat. */
export interface ChatNoticeEntry {
  projectId: string;
  workstream: string;
  pane: ChatNoticePane;
  text: string;
}
