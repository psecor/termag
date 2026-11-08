/**
 * Which part of a checkout an agent works in (docs/agents/observability.md,
 * `agent.file.edited`): the PostToolUse hook (deploy/termag-status post-tool)
 * sends, for each Write, Edit, MultiEdit or NotebookEdit, the top two
 * directories of the file's path in its git checkout, never the file's name,
 * the rest of its path or anything it wrote. This checks that body again,
 * since a box could send anything. Pure.
 */

export const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;
export type EditTool = typeof EDIT_TOOLS[number];

const SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;
const CLAUDE_SESSION = /^[A-Za-z0-9-]{8,64}$/;

export interface FileEdit {
  /** The termag tmux session the hook ran in. */
  session: string;
  /** `.` for the checkout's top, else one or two directory names, `/`-joined. */
  dir: string;
  tool: EditTool;
  /** Claude Code's session.id, which its spans carry, when the hook had one. */
  claudeSession: string | null;
}

/** `.`, or one or two path segments, none of them `.` or `..`. */
export function editDirOf(value: unknown): string | null {
  if (value === '.') return '.';
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  if (parts.length < 1 || parts.length > 2) return null;
  return parts.every(p => SEGMENT.test(p) && p !== '.' && p !== '..') ? value : null;
}

export function parseEditBody(body: unknown): FileEdit | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'body must be an object' };
  const { session, dir, tool, claudeSession } = body as Record<string, unknown>;
  if (typeof session !== 'string' || !session) return { error: 'session required' };
  const d = editDirOf(dir);
  if (!d) return { error: 'dir must be . or at most two directory names' };
  if (typeof tool !== 'string' || !(EDIT_TOOLS as readonly string[]).includes(tool)) return { error: `tool must be one of ${EDIT_TOOLS.join(', ')}` };
  const cs = typeof claudeSession === 'string' && CLAUDE_SESSION.test(claudeSession) ? claudeSession : null;
  return { session, dir: d, tool: tool as EditTool, claudeSession: cs };
}
