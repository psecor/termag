// A session dragged into a composer (chat-session-references-enabled).
// The sidebar's row or tab puts the
// reference on the drag as SESSION_REF_TYPE, and a composer it is dropped on
// writes it into the message at the drop point. The reference names the
// session the way the sidebar does and says how an agent messages it: the
// `termag ask` target, and for an ask's chat the thread whose follow-up runs
// in that same session. Asks are owner-only, so a
// session that can't be asked carries the reason instead, and the composer
// shows it. A drag from anywhere can carry the type, so a composer takes only
// text of exactly the form this writes (REF_TEXT): a target and a thread id
// in termag's own characters, never anything a shell would read.
import type React from 'react';
import type { InboxRow } from '../mobile/inbox';
import { agentLabel } from './explorerAgents';
import { chatRowName } from './simpleChat';

export const SESSION_REF_TYPE = 'application/x-termag-session-ref';

export type SessionRef = { text: string } | { refusal: string };

export type RefRow = Pick<InboxRow,
  'projectName' | 'workstream' | 'sessionTitle' | 'askTitle' | 'askThreadId' | 'askTarget' | 'shared' | 'owner' | 'instanceId'>;

/**
 * A reference as sessionRef writes it, and nothing else: a name with no `"`,
 * then a box (boxNames.ts), project, workstream and repository in letters,
 * digits, `.`, `_` and `-`, and a thread id (a cuid).
 */
const REF_TEXT = /^@"[^"\n]{1,200}" \(termag ask [A-Za-z0-9_-]+\/[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?(?::[A-Za-z0-9][A-Za-z0-9_-]*)?(?: --thread [a-z0-9]{8,40})?\)$/;

/** `box/project[@workstream][:repo]`, as `termag ask` takes it (backend agentMessages.askTarget). */
function askTarget(box: string, project: string, workstream: string, repo: string | null): string {
  return `${box}/${project}${workstream === 'main' ? '' : `@${workstream}`}${repo ? `:${repo}` : ''}`;
}

/**
 * The reference to `row`, on `box` (its name, null when it isn't one of this
 * person's boxes): `@"<name>" (termag ask <target>[ --thread <id>])`, where the
 * name is what the sidebar calls the session. Else why it can't be messaged.
 */
export function sessionRef(row: RefRow, box: string | null, titlesShown: boolean): SessionRef {
  const name = (chatRowName(row, titlesShown).title ?? agentLabel(row)).replace(/"/g, "'");
  if (row.shared) return { refusal: `${name} is ${row.owner}'s session. Only your own sessions can be messaged.` };
  if (!row.instanceId || !box) return { refusal: `${name} isn't on a box of yours, so it can't be messaged.` };
  // A follow-up names the thread's own target; an older orchestrator doesn't say it, and most threads ask main.
  const text = row.askThreadId
    ? `@"${name}" (termag ask ${askTarget(box, row.projectName, row.askTarget?.workstream ?? 'main', row.askTarget?.repo ?? null)} --thread ${row.askThreadId})`
    : `@"${name}" (termag ask ${askTarget(box, row.projectName, row.workstream, null)})`;
  return REF_TEXT.test(text) ? { text } : { refusal: `${name} has a name a reference can't carry, so it can't be messaged from here.` };
}

/** Puts the reference to `row` on a drag that starts on its row or tab. */
export function putSessionRef(e: React.DragEvent, row: RefRow, box: string | null, titlesShown: boolean): void {
  e.dataTransfer.setData(SESSION_REF_TYPE, JSON.stringify(sessionRef(row, box, titlesShown)));
}

/** The reference a drop carries, or null for anything else, a text not of sessionRef's form included. */
export function readSessionRef(data: string): SessionRef | null {
  try {
    const v = JSON.parse(data) as unknown;
    if (v && typeof v === 'object') {
      const r = v as Record<string, unknown>;
      if (typeof r.text === 'string') return REF_TEXT.test(r.text) ? { text: r.text } : null;
      // Shown as text in the composer's notes, never put in the message.
      if (typeof r.refusal === 'string' && r.refusal) return { refusal: r.refusal.slice(0, 300) };
    }
  } catch { /* not ours */ }
  return null;
}

/** A drop point inside a word moves to that word's end, so a reference never splits one. */
export function wordEnd(value: string, at: number): number {
  let i = Math.max(0, Math.min(at, value.length));
  if (i === 0 || /\s/.test(value[i - 1])) return i;
  while (i < value.length && !/\s/.test(value[i])) i += 1;
  return i;
}

/**
 * `value` with `ref` in place of [start, end), set off by a space from the
 * words on either side, and where the caret goes: after the reference and its
 * space, so typing goes on from there.
 */
export function insertRef(value: string, start: number, end: number, ref: string): { value: string; caret: number } {
  const before = value.slice(0, Math.max(0, start));
  const after = value.slice(Math.max(start, end));
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = /^\s/.test(after) ? '' : ' ';
  return { value: `${before}${lead}${ref}${trail}${after}`, caret: before.length + lead.length + ref.length + trail.length };
}
