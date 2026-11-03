/**
 * Links the PRs a chat's agent opens to the chat's workstream, as `created`
 * (services/workstreamPrs.ts). A tmux session reports them itself: its Claude
 * hook posts the pr_created milestone (deploy/termag-status). A chat-runner
 * chat runs no hook, so its PRs went unlinked whenever they were opened from
 * a worktree its checkout is not on. This reads the chat's events instead,
 * with the hook's rule: a Bash call that runs `gh pr create` (or
 * termag-pr-create), and that call's result, when it succeeded and printed
 * the new PR's URL on stdout.
 *
 * The URL is the box's word, as the milestone's is, and the link only ever
 * goes to the chat's own workstream, as its project's owner. The relay has
 * already checked the event came from the project's box (chatRunner.ts).
 */

import { prisma } from '../db';
import { onChatEvent, type ChatEventSeen } from './chatRunner';
import { parsePrUrl, recordCreatedLinkAt, type PrCreatedEvent } from './workstreamPrs';

// deploy/termag-status classify_tool, which reads a command a line at a time
// (grep -E): `gh pr create` or termag-pr-create, bare or by path, at a command
// boundary, so "cd x && gh pr create" counts and "echo gh pr create" does not.
const PR_CREATE = /(^|[;&|(])[^\S\n]*(gh[^\S\n]+pr[^\S\n]+create|([^\s;&|()]*\/)?termag-pr-create)(\s|$)/m;
const HEREDOC = /<<-?[^\S\n]*["']?([A-Za-z_][A-Za-z0-9_]*)["']?/;
const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+/;

/**
 * A command without its heredoc bodies (termag-status strip_heredocs), so a
 * body that only mentions "gh pr create" on a line of its own is not a
 * create. The line carrying the `<<` is kept: `gh pr create --body-file - <<'EOF'` counts.
 */
export function stripHeredocs(cmd: string): string {
  const kept: string[] = [];
  let term = '';
  for (const line of cmd.split('\n')) {
    if (term) {
      if (line.trimStart() === term) term = '';
      continue;
    }
    const m = HEREDOC.exec(line);
    if (m) term = m[1];
    kept.push(line);
  }
  return kept.join('\n');
}

/** Whether a Bash command opens a PR. */
export function isPrCreateCommand(cmd: string): boolean {
  return PR_CREATE.test(stripHeredocs(cmd));
}

type Block = { type?: unknown; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };
type ChatEvent = { type?: unknown; message?: { content?: unknown }; tool_use_result?: unknown };

function blocksOf(ev: ChatEvent): Block[] {
  const content = ev.message?.content;
  return Array.isArray(content) ? content.filter((b): b is Block => !!b && typeof b === 'object') : [];
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).join('\n');
}

/**
 * What a Bash result printed on stdout: `tool_use_result.stdout` when Claude
 * Code sends it apart, as the hook reads it, since a create that fails because
 * the branch already has a PR prints that PR's URL on stderr. (Claude Code 2.1
 * folds stderr into it; that create exits non-zero, so is_error still drops
 * it.) Otherwise the result's text, read whole.
 */
function stdoutOf(ev: ChatEvent, block: Block, results: number): string {
  const r = ev.tool_use_result;
  if (results === 1 && r && typeof r === 'object' && typeof (r as { stdout?: unknown }).stdout === 'string') return (r as { stdout: string }).stdout;
  return textOf(block.content);
}

/** How many tool calls a tracker holds, oldest dropped first: a create's result comes back within its turn. */
const HELD = 200;

/**
 * Follows chat events and returns the stdout of each Bash call whose command
 * `matches`, once its tool_result comes back and only if it succeeded: the
 * tool_use is held by its id until then, and a failed one (is_error, which a
 * non-zero exit is) returns nothing. A call is answered once, so its result
 * seen twice is not reported twice.
 */
export function bashResultTracker(matches: (cmd: string) => boolean): (seen: ChatEventSeen) => string[] {
  const pending = new Set<string>();
  return seen => {
    const ev = (seen.event ?? {}) as ChatEvent;
    if (ev.type === 'assistant') {
      for (const b of blocksOf(ev)) {
        if (b.type !== 'tool_use' || b.name !== 'Bash' || typeof b.id !== 'string') continue;
        const cmd = (b.input as { command?: unknown } | null)?.command;
        if (typeof cmd !== 'string' || !matches(cmd)) continue;
        pending.add(`${seen.projectId}\0${b.id}`);
        while (pending.size > HELD) pending.delete(pending.values().next().value!);
      }
      return [];
    }
    if (ev.type !== 'user' || pending.size === 0) return [];
    const results = blocksOf(ev).filter(b => b.type === 'tool_result' && typeof b.tool_use_id === 'string');
    const out: string[] = [];
    for (const b of results) {
      const key = `${seen.projectId}\0${b.tool_use_id as string}`;
      if (!pending.delete(key)) continue;
      if (b.is_error === true) continue;
      out.push(stdoutOf(ev, b, results.length));
    }
    return out;
  };
}

/**
 * Follows chat events and returns the URLs of the PRs each one says were
 * opened: a create that succeeded and printed the new PR's URL.
 */
export function prCreateTracker(): (seen: ChatEventSeen) => string[] {
  const track = bashResultTracker(isPrCreateCommand);
  return seen => track(seen).flatMap(stdout => PR_URL.exec(stdout)?.[0] ?? []);
}

/** The project's owner, while the project still lives on the box a chat event came from. */
export async function chatProjectOwner(projectId: string, instanceId: string): Promise<string | null> {
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true, instanceId: true } });
  return p && p.instanceId === instanceId ? p.userId : null;
}

export interface ChatPrLinkDeps {
  /** The project's owner, when it still lives on this box. */
  ownerOf: (projectId: string, instanceId: string) => Promise<string | null>;
  record: (ev: PrCreatedEvent) => Promise<boolean>;
}

const defaultDeps: ChatPrLinkDeps = {
  ownerOf: chatProjectOwner,
  record: ev => recordCreatedLinkAt(ev),
};

/** The chat-event listener: each PR a chat opens, recorded against its workstream. Exported for tests. */
export function chatPrLinkListener(deps: ChatPrLinkDeps = defaultDeps): (seen: ChatEventSeen) => void {
  const track = prCreateTracker();
  return seen => {
    for (const url of track(seen)) {
      const pr = parsePrUrl(url);
      if (pr) link(seen, pr);
    }
  };

  function link(seen: ChatEventSeen, pr: PrCreatedEvent['pr']): void {
    const at = `${pr.repo}#${pr.number}`;
    void (async () => {
      const userId = await deps.ownerOf(seen.projectId, seen.instanceId);
      if (!userId) return;
      if (await deps.record({ userId, projectId: seen.projectId, workstream: seen.workstream, pr })) {
        console.log(`[CHAT] ${seen.projectId}/${seen.workstream} opened ${at}; linked to its workstream`);
      }
    })().catch(err => {
      console.warn(`[CHAT] could not store the link to ${at}:`, err instanceof Error ? err.message : String(err));
    });
  }
}

/** Link every PR a chat opens. Returns the unsubscribe. */
export function startChatPrLinks(): () => void {
  return onChatEvent(chatPrLinkListener());
}
