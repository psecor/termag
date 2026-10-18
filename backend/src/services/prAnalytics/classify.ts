/**
 * Who a pull request counts for: pure,
 * so it is tested without GitHub.
 *
 *   human       a person's account
 *   agent       an AI coding agent's bot account (Devin, Claude, Cursor, Copilot)
 *   automation  any other bot, or a User-typed account on the bot list
 *
 * An agent PR is credited to the person it was done for, in order of how
 * reliable the signal is:
 *   1. commit-author  a human GitHub user among the commit authors (GitHub
 *                     links commit emails to logins, so this is the cleanest);
 *   2. co-author      a Co-authored-by trailer in GitHub's noreply format
 *                     (<id>+<login>@users.noreply.github.com);
 *   3. body           "Requested by @login" in the PR body (Devin's format).
 * A human PR whose commits an agent wrote or co-authored stays human and is
 * marked agentAssisted.
 */

export type AuthorClass = 'human' | 'agent' | 'automation';
export type CreditSource = 'author' | 'commit-author' | 'co-author' | 'body' | 'none';

/** Agent bot accounts that author PRs. Settings can add more. */
export const DEFAULT_AGENT_LOGINS = [
  'devin-ai-integration[bot]', 'claude[bot]', 'cursor[bot]', 'copilot-swe-agent[bot]', 'copilot', 'openai-codex[bot]',
];
/** Accounts agents commit as (commit authors, not PR authors). */
export const AGENT_COMMIT_LOGINS = ['devin-ai-integration[bot]', 'claude', 'cursoragent', 'copilot', 'copilot-swe-agent[bot]'];
/** Bots GitHub types as User. Settings can add more. */
export const DEFAULT_BOT_LOGINS: string[] = [];

/** Co-author trailers that name an agent rather than a person. */
const AGENT_TRAILER = /(devin-ai-integration|\bclaude\b|cursor ?agent|cursoragent|copilot|codex)/i;
const NOREPLY = /<\s*(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))@users\.noreply\.github\.com\s*>/i;
const TRAILER = /^co-authored-by:\s*(.+)$/gim;
const REQUESTED_BY = /requested by:?\**\s*(?:[^@\n]{0,80}?)@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\b/i;

export interface PrFacts {
  authorLogin: string;
  authorType: string;
  /** The body's head and tail (the ingester keeps the first 1 KB and last 2 KB). */
  body: string;
  commits: Array<{ messageBody: string; authorLogins: string[] }>;
}

export interface ClassifyLists {
  agentLogins: readonly string[];
  botLogins: readonly string[];
}

export interface Classified {
  authorClass: AuthorClass;
  creditedLogin: string | null;
  creditSource: CreditSource;
  agentAssisted: boolean;
}

const lower = (s: string) => s.trim().toLowerCase();
/**
 * GitHub names an app account `name[bot]` in REST and commit authors but
 * plain `name` (typed Bot) in a PR's GraphQL `author`, so logins compare
 * without the suffix.
 */
const base = (s: string) => lower(s).replace(/\[bot\]$/, '');
const isBotLogin = (login: string, type: string) => type === 'Bot' || lower(login).endsWith('[bot]');

/**
 * An agent-list entry written `name[bot]` matches only a bot account named
 * `name`, never a person who happens to be called that; an entry without the
 * suffix matches the login exactly.
 */
function onAgentList(login: string, type: string, agentLogins: readonly string[]): boolean {
  const bot = isBotLogin(login, type);
  return agentLogins.some(a => (lower(a).endsWith('[bot]') ? bot && base(a) === base(login) : lower(a) === lower(login)));
}

export function classifyAuthor(login: string, type: string, lists: ClassifyLists): AuthorClass {
  if (!lower(login)) return 'automation';
  if (onAgentList(login, type, lists.agentLogins)) return 'agent';
  if (isBotLogin(login, type) || lists.botLogins.some(b => base(b) === base(login))) return 'automation';
  return 'human';
}

const agentCommitter = (login: string) => AGENT_COMMIT_LOGINS.some(a => base(a) === base(login));

function isPersonLogin(login: string, lists: ClassifyLists): boolean {
  return !!lower(login) && !agentCommitter(login) && classifyAuthor(login, isBotLogin(login, '') ? 'Bot' : 'User', lists) === 'human';
}

function trailers(commits: PrFacts['commits']): string[] {
  const out: string[] = [];
  for (const c of commits) for (const m of (c.messageBody ?? '').matchAll(TRAILER)) out.push(m[1]);
  return out;
}

/** The most frequent person among the commit authors, ties to the first seen. */
function topCommitAuthor(commits: PrFacts['commits'], lists: ClassifyLists): string | null {
  const counts = new Map<string, number>();
  for (const c of commits) for (const a of c.authorLogins) {
    if (isPersonLogin(a, lists)) counts.set(lower(a), (counts.get(lower(a)) ?? 0) + 1);
  }
  let best: string | null = null; let n = 0;
  for (const [login, k] of counts) if (k > n) { best = login; n = k; }
  return best;
}

export function classifyPr(pr: PrFacts, lists: ClassifyLists): Classified {
  const authorClass = classifyAuthor(pr.authorLogin, pr.authorType, lists);
  const ts = trailers(pr.commits);
  const agentAssisted = authorClass === 'agent'
    || pr.commits.some(c => c.authorLogins.some(agentCommitter))
    || ts.some(t => AGENT_TRAILER.test(t));

  if (authorClass === 'human') return { authorClass, creditedLogin: lower(pr.authorLogin), creditSource: 'author', agentAssisted };
  if (authorClass === 'automation') return { authorClass, creditedLogin: null, creditSource: 'none', agentAssisted };

  const byCommit = topCommitAuthor(pr.commits, lists);
  if (byCommit) return { authorClass, creditedLogin: byCommit, creditSource: 'commit-author', agentAssisted };
  for (const t of ts) {
    if (AGENT_TRAILER.test(t)) continue;
    const m = NOREPLY.exec(t);
    if (m && isPersonLogin(m[1], lists)) return { authorClass, creditedLogin: lower(m[1]), creditSource: 'co-author', agentAssisted };
  }
  const req = REQUESTED_BY.exec(pr.body ?? '');
  if (req && isPersonLogin(req[1], lists)) return { authorClass, creditedLogin: lower(req[1]), creditSource: 'body', agentAssisted };
  return { authorClass, creditedLogin: null, creditSource: 'none', agentAssisted };
}

/** The part of a body the ingester keeps for credit parsing: the first 1 KB and the last 2 KB. */
export function bodyWindow(body: string | null | undefined, head = 1024, tail = 2048): string {
  const b = body ?? '';
  return b.length <= head + tail ? b : `${b.slice(0, head)}\n…\n${b.slice(-tail)}`;
}
