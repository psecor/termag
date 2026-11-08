/**
 * What an ask run pushed, recorded on its thread.
 * On a box with ask-push-v1 the run pushes and opens its
 * draft PRs itself, as any session on the box does; at the end of the turn
 * the runner reports the branches its clone pushed (deploy/termag-subagent-run
 * pushed_branches). Each one is confirmed here on GitHub with the asker's
 * token, never taken from the box: the branch's tip, and the newest PR with
 * that head. Those PRs become the thread's (agent_thread_prs), which the
 * reply's `prs`, the CLI and the A2A artifacts read.
 *
 * Nothing here checks the commits. The run is the box owner and can push
 * anyway, so publish's checks were never a boundary; hygiene lives in the
 * clone's hooks and the repository's own CI.
 */
import { ASK_PR_KEY, MAX_ASK_PRS, type ReportedPush, type UnpushedBranch } from './agentMessages';

export interface GithubConfig {
  apiBaseUrl: string;
  fetch: typeof fetch;
}

export function githubConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GithubConfig {
  return { apiBaseUrl: (env.ASK_GITHUB_API_URL?.trim() || 'https://api.github.com').replace(/\/+$/, ''), fetch };
}

/** What became of one reported branch. */
export type PushOutcome =
  | { kind: 'recorded'; branch: string; key: string; headSha: string; prNumber: number; prUrl: string; state: string }
  | { kind: 'no-pr'; branch: string; headSha: string }
  /**
   * GitHub no longer has the branch and it never had a PR: deleted after the
   * push. A clone reports every branch it ever pushed, so this is routine and
   * says nothing about the turn.
   */
  | { kind: 'gone'; branch: string }
  | { kind: 'failed'; branch: string; reason: string };

export interface ConfirmInput {
  repo: string;
  token: string;
  pushes: ReportedPush[];
  /** The thread's own branch: `termag-<asker>/<thread>`, or the head branch of the PR it updates. */
  ownBranch: string;
  /** Where its extra PRs go: `<ownBranch>-<name>` for the thread's own naming. */
  prefix: string;
  /** The thread's rows so far, so a branch keeps its key from turn to turn. */
  rows: { key: string; branch: string }[];
}

const encodeBranch = (b: string) => b.split('/').map(encodeURIComponent).join('/');

/** A GitHub REST GET with the asker's token: its status and JSON body (null when there is none). */
async function githubGet(cfg: GithubConfig, token: string, path: string): Promise<{ status: number; data: unknown }> {
  const res = await cfg.fetch(`${cfg.apiBaseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'termag-ask',
    },
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/**
 * The key a pushed branch is recorded under: '' for the thread's own branch,
 * `<name>` for `<prefix>-<name>`. Any other branch (another PR the run pushed
 * to) keeps the key it had, else gets its last path segment, made a valid key
 * and unique on the thread. A thread with no own PR lists the others first.
 */
export function pushKey(branch: string, input: Pick<ConfirmInput, 'ownBranch' | 'prefix'>, taken: Map<string, string>): string {
  const had = [...taken].find(([, b]) => b === branch);
  if (had) return had[0];
  if (branch === input.ownBranch) return '';
  const suffix = branch.startsWith(`${input.prefix}-`) ? branch.slice(input.prefix.length + 1) : null;
  if (suffix && ASK_PR_KEY.test(suffix) && !taken.has(suffix)) return suffix;
  const base = (branch.split('/').pop() ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'pr';
  const stem = ASK_PR_KEY.test(base) ? base : 'pr';
  let key = stem;
  for (let n = 2; taken.has(key); n++) key = `${stem}-${n}`;
  return key;
}

/** Each reported branch as GitHub has it: its tip, and the newest PR with that head (an open one first). */
export async function confirmPushes(cfg: GithubConfig, input: ConfirmInput): Promise<PushOutcome[]> {
  const owner = input.repo.split('/')[0];
  const taken = new Map(input.rows.map(r => [r.key, r.branch]));
  const out: PushOutcome[] = [];
  for (const p of input.pushes) {
    try {
      const ref = await githubGet(cfg, input.token, `/repos/${input.repo}/git/ref/heads/${encodeBranch(p.branch)}`);
      if (ref.status !== 200 && ref.status !== 404) { out.push({ kind: 'failed', branch: p.branch, reason: `GitHub answered ${ref.status} for ${p.branch}` }); continue; }
      // Only the exact ref counts: a missing ref can come back as the array of refs it
      // prefixes (a sibling <branch>-<name>), whose tip is another branch's.
      const one = ref.data as { ref?: unknown; object?: { sha?: unknown } } | null;
      const tip = ref.status === 200 && one && !Array.isArray(one) && one.ref === `refs/heads/${p.branch}` && typeof one.object?.sha === 'string'
        ? one.object.sha : null;
      const q = new URLSearchParams({ head: `${owner}:${p.branch}`, state: 'all', per_page: '10' });
      const pulls = await githubGet(cfg, input.token, `/repos/${input.repo}/pulls?${q}`);
      if (pulls.status !== 200 || !Array.isArray(pulls.data)) { out.push({ kind: 'failed', branch: p.branch, reason: `GitHub answered ${pulls.status} listing ${p.branch}'s pull requests` }); continue; }
      const list = pulls.data as { number?: unknown; html_url?: unknown; state?: unknown; head?: { sha?: unknown } }[];
      const pr = list.find(x => x.state === 'open') ?? list[0];
      const hasPr = !!pr && typeof pr.number === 'number' && typeof pr.html_url === 'string';
      // A branch deleted on GitHub (merged and cleaned up, say) keeps its PR, at the PR's last head.
      if (!tip && !hasPr) { out.push({ kind: 'gone', branch: p.branch }); continue; }
      const headSha = tip ?? (typeof pr?.head?.sha === 'string' ? pr.head.sha : p.sha);
      if (!hasPr) { out.push({ kind: 'no-pr', branch: p.branch, headSha }); continue; }
      const key = pushKey(p.branch, input, taken);
      taken.set(key, p.branch);
      out.push({ kind: 'recorded', branch: p.branch, key, headSha, prNumber: pr!.number as number, prUrl: pr!.html_url as string, state: String(pr!.state ?? 'open') });
    } catch (e) {
      out.push({ kind: 'failed', branch: p.branch, reason: `GitHub could not be reached for ${p.branch}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return out;
}

/**
 * What the clone committed and never pushed, one part of a publish detail
 * each, with the push that publishes it. The push goes to the branch the box
 * named (`to`), which is the one the reply names: the box knows which branches
 * origin has, so a branch `gh pr checkout` made goes to its own PR's branch.
 * When a box sends no `to`, the push goes to the branch's own name for the
 * thread's branch and its `<own>-<name>` siblings, else to the thread's branch.
 */
export function unpushedParts(unpushed: UnpushedBranch[], ownBranch: string): string[] {
  return unpushed.map(u => {
    if (u.branch === 'HEAD') return `a detached HEAD has ${u.commits} commit(s) on no branch, not pushed (git push origin HEAD:${u.to ?? ownBranch})`;
    const pushed = `${u.branch}: ${u.commits} commit(s) committed but not pushed`;
    const to = u.to ?? (u.branch === ownBranch || u.branch.startsWith(`${ownBranch}-`) ? u.branch : ownBranch);
    if (to === u.branch) return `${pushed} (git push origin ${u.branch})`;
    return `${pushed} (the thread's branch is ${to}: git push origin ${u.branch}:${to})`;
  });
}

/**
 * The turn's pushes as agent_messages.publish / publishDetail: `none` when it
 * pushed nothing and left nothing unpushed, `published` when every pushed
 * branch has a PR, `partial` when some have none yet or could not be
 * confirmed, `failed` when none could. Commits the clone has that no origin
 * branch has (`unpushed`, any turn's, a canceled one's included) are in the
 * detail and keep it from `published`; with nothing pushed they are
 * `unpushed`, never `none`, so a turn that only committed doesn't read as
 * done. Past MAX_ASK_PRS PRs on the thread the detail says so; nothing is
 * refused.
 */
export function pushSummary(
  all: PushOutcome[], threadPrs: number, unpushed: UnpushedBranch[] = [], ownBranch = '',
): { publish: 'none' | 'published' | 'partial' | 'failed' | 'unpushed'; detail: string | null } {
  // Branches deleted on GitHub with no PR are history, not this turn's outcome.
  const outcomes = all.filter(o => o.kind !== 'gone');
  const left = unpushedParts(unpushed, ownBranch);
  if (!outcomes.length) return left.length ? { publish: 'unpushed', detail: left.join(' | ') } : { publish: 'none', detail: null };
  const recorded = outcomes.filter(o => o.kind === 'recorded').length;
  const failed = outcomes.filter(o => o.kind === 'failed').length;
  const publish = recorded === outcomes.length ? (left.length ? 'partial' : 'published') : !recorded && failed === outcomes.length ? 'failed' : 'partial';
  const parts = outcomes.map(o => o.kind === 'recorded'
    ? `${o.branch}: PR #${o.prNumber}${o.state === 'open' ? '' : ` (${o.state})`}`
    : o.kind === 'no-pr'
      ? `${o.branch}: pushed at ${o.headSha.slice(0, 12)}, no pull request yet (open a draft with termag-pr-create)`
      : `${o.branch}: ${(o as Extract<PushOutcome, { kind: 'failed' }>).reason}`);
  if (threadPrs > MAX_ASK_PRS) parts.push(`the thread has ${threadPrs} pull requests, more than the ${MAX_ASK_PRS} one thread usually opens`);
  // What wasn't pushed leads: the detail is cut at 1000 characters, and it is what the asker must act on.
  return { publish, detail: [...left, ...parts].join(' | ') };
}
