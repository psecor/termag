/**
 * Where a chat's checkout stood at its last turn end,
 * kept on the session's stored transcript row (`chat_transcripts.gitState`).
 * When the box is terminated and the chat continues on a new one, the first
 * turn there is told this, so Claude knows what went with the old disk.
 *
 * Read over `git-branch-state` (agent/git-branch-state.js, local refs only, no
 * fetch) right after the turn end's transcript pull, behind
 * chat-resume-new-box-enabled. Small on purpose: the branch, HEAD, its
 * upstream, whether HEAD is pushed, counts of unpushed commits and of
 * uncommitted and untracked files, and the workstream's open PR. Never a file
 * name, a diff or the origin URL (which may carry a token).
 */

import { prisma } from '../db';
import { isChatRunnerProvider } from '../providers/registry';
import { sendToInstanceAgent } from './agentRegistry';
import { boolVariation } from './featureFlags';
import { projectDirFor } from './tmux';

export const CHAT_RESUME_FLAG = 'chat-resume-new-box-enabled';
/** The JSON of one record never exceeds this. */
export const GIT_STATE_MAX_BYTES = 1024;
const RPC_TIMEOUT_MS = 10_000;
const REF = /^[^\s\x00-\x1f\x7f~^:?*[\\]{1,200}$/;
const SHA = /^[0-9a-f]{40,64}$/;

export interface ChatGitState {
  /** null: a detached HEAD, or not a checkout. */
  branch: string | null;
  head: string | null;
  /** The branch's upstream (`origin/feat`), null when it was never pushed. */
  upstream: string | null;
  /** HEAD is on its upstream. null: it can't be told (no upstream, or its ref is gone). */
  pushed: boolean | null;
  /** Commits on HEAD its upstream lacks; with no upstream, those its base branch lacks. */
  unpushed: number | null;
  /** The base `unpushed` counted against, when there is no upstream (`origin/main`). */
  unpushedAgainst?: string;
  uncommitted: number | null;
  untracked: number | null;
  pr: { number: number; url: string } | null;
  at: string;
}

const count = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null);
const ref = (v: unknown): string | null => (typeof v === 'string' && REF.test(v) ? v : null);

/** The record from a `git-branch-state` answer, every field re-validated. */
export function gitStateFrom(raw: Record<string, unknown>, pr: ChatGitState['pr'], at: Date): ChatGitState {
  const upstream = ref(raw.upstream);
  const abKnown = raw.abKnown === true;
  const ahead = count(raw.ahead);
  const baseBranch = ref(raw.baseBranch);
  const aheadOfBase = count(raw.aheadOfBase);
  const state: ChatGitState = {
    branch: ref(raw.branch),
    head: typeof raw.head === 'string' && SHA.test(raw.head) ? raw.head : null,
    upstream,
    pushed: upstream && abKnown && ahead != null ? ahead === 0 : null,
    unpushed: upstream ? (abKnown ? ahead : null) : aheadOfBase,
    ...(!upstream && aheadOfBase != null && baseBranch ? { unpushedAgainst: `origin/${baseBranch}` } : {}),
    // An older agent reports dirtiness only, not counts.
    uncommitted: count(raw.changed),
    untracked: count(raw.untracked),
    pr: pr && Number.isSafeInteger(pr.number) && pr.number > 0 && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(pr.url) ? pr : null,
    at: at.toISOString(),
  };
  return Buffer.byteLength(JSON.stringify(state)) <= GIT_STATE_MAX_BYTES ? state : { ...state, branch: null, upstream: null };
}

/** A stored record, or null when the column holds something else. */
export function parseGitState(v: unknown): ChatGitState | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== 'string') return null;
  return o as unknown as ChatGitState;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * One line for the agent: "Last state on the old box: HEAD at abc1234 on a
 * branch, 1 commit not pushed to its upstream (lost), 2 uncommitted files
 * lost." Fixed wording, a short SHA and counts only: no branch, upstream or
 * repository name, since the notice is hidden from the person (only the model
 * reads it) and a ref name is free text whoever made the branch chose. The
 * agent can run git on the new box for the names.
 */
export function describeGitState(s: ChatGitState | null): string {
  if (!s) return 'No git state was recorded on the old box.';
  const parts: string[] = [];
  const sha = s.head && /^[0-9a-f]{7,64}$/.test(s.head) ? s.head.slice(0, 7) : null;
  parts.push(sha ? `HEAD at ${sha} ${s.branch ? 'on a branch' : '(detached)'}` : 'no commit');
  const n = (v: number | null | undefined) => (Number.isSafeInteger(v) && (v as number) > 0 ? v as number : 0);
  if (s.upstream) {
    if (s.pushed === true) parts.push('pushed to its upstream');
    else if (n(s.unpushed)) parts.push(`${plural(n(s.unpushed), 'commit')} not pushed to its upstream (lost)`);
    else parts.push('whether it was pushed is unknown');
  } else if (sha) {
    parts.push(n(s.unpushed) ? `never pushed, ${plural(n(s.unpushed), 'commit')} not on the default branch (lost)` : 'never pushed');
  }
  const lost: string[] = [];
  if (n(s.uncommitted)) lost.push(plural(n(s.uncommitted), 'uncommitted file'));
  if (n(s.untracked)) lost.push(plural(n(s.untracked), 'untracked file'));
  if (lost.length) parts.push(`${lost.join(' and ')} lost`);
  else if (s.uncommitted === 0 && s.untracked === 0) parts.push('nothing uncommitted');
  if (s.pr && Number.isSafeInteger(s.pr.number) && s.pr.number > 0) parts.push(`an open PR #${s.pr.number}`);
  const at = typeof s.at === 'string' && !Number.isNaN(Date.parse(s.at)) ? new Date(s.at).toISOString() : 'unknown';
  return `Last state on the old box: ${parts.join(', ')}. Recorded at its last turn end, ${at}.`;
}

/** The workstream's PR, unless GitHub says it is closed or merged. */
async function openPrOf(workstreamId: string): Promise<ChatGitState['pr']> {
  const link = await prisma.workstreamPr.findFirst({ where: { workstreamId }, orderBy: { updatedAt: 'desc' }, select: { repo: true, number: true } });
  if (!link) return null;
  const known = await prisma.githubPr.findFirst({ where: { repo: link.repo, number: link.number }, select: { state: true } });
  if (known && known.state !== 'OPEN') return null;
  return { number: link.number, url: `https://github.com/${link.repo}/pull/${link.number}` };
}

/**
 * Record the chat's git state on its live stored session, after a turn end.
 * Only for the box the project lives on, a chat-runner chat that is not an
 * ask's, a session the store already has, and the flag on for the owner. A
 * failure is logged; it never touches the turn.
 */
export async function recordChatGitState(chat: { instanceId: string; projectId: string; workstreamId: string }, now = new Date()): Promise<void> {
  try {
    const ws = await prisma.workstream.findUnique({
      where: { id: chat.workstreamId },
      select: {
        name: true, projectId: true,
        askThread: { select: { id: true } },
        workflows: { where: { type: 'agent' }, select: { provider: true } },
        project: {
          select: {
            name: true, instanceId: true, instance: { select: { hostHome: true } },
            user: { select: { id: true, googleEmail: true, displayName: true, unixUsername: true, defaultAgentProvider: true } },
          },
        },
      },
    });
    if (!ws || ws.projectId !== chat.projectId || ws.project.instanceId !== chat.instanceId) return;
    if (ws.askThread || !ws.workflows.some(w => isChatRunnerProvider(w.provider))) return;
    if (!await boolVariation(CHAT_RESUME_FLAG, ws.project.user, false)) return;
    const current = await prisma.chatTranscript.findFirst({ where: { projectId: chat.projectId, workstreamId: chat.workstreamId, current: true }, select: { sessionId: true } });
    if (!current) return;
    const cwd = projectDirFor({ name: ws.project.name, user: ws.project.user, instance: { hostHome: ws.project.instance?.hostHome ?? null } }, ws.name);
    const raw = await sendToInstanceAgent(chat.instanceId, 'git-branch-state', { cwd }, RPC_TIMEOUT_MS) as Record<string, unknown>;
    const state = gitStateFrom(raw ?? {}, await openPrOf(chat.workstreamId), now);
    await prisma.chatTranscript.updateMany({
      where: { projectId: chat.projectId, workstreamId: chat.workstreamId, sessionId: current.sessionId },
      data: { gitState: state as unknown as object, gitStateAt: now },
    });
  } catch (err) {
    console.error('[TRANSCRIPT] %s--%s: git state not recorded: %s', chat.projectId, chat.workstreamId, err instanceof Error ? err.message : String(err));
  }
}
