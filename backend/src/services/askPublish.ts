/**
 * Publishing an ask run's commits. The box uploads a git bundle of the branches the run made on
 * top of the thread's base commit; this module checks it in a throwaway bare
 * repository, pushes each branch without force, and opens (or finds) a draft
 * PR for each: the run's own branch on `termag-<asker>/<thread>`, each of its
 * `pr/<key>` branches on `termag-<asker>/<thread>-<key>` ("Several PRs").
 *
 * It runs on the orchestrator, which the run cannot touch, with the asker's
 * own stored GitHub token: GitHub then checks the asker's access, and the PR
 * is theirs. The run itself holds the box token (a decision, see the doc), so
 * these checks bind runs that go through this path, not one that goes around it.
 *
 * Checks that refuse the whole bundle: one to MAX_ASK_PRS heads, each the
 * run's own branch or a pr/<key>; it applies on the base.
 *
 * Each branch is judged on the PR's own changes. Its base branch is what its
 * PR would merge into (its PR's base on GitHub, else the repo's default
 * branch). The branch's commits beyond the thread's base are split into the
 * PR's own (not reachable from the base branch's tip on GitHub, asked of
 * GitHub's compare API) and the base branch's, which a thread with an old
 * base, or a merge of the base branch, carries. Checks that refuse one branch,
 * leaving the others to publish: it descends from the base; it has commits of
 * its own, at most MAX_COMMITS; a merge has two parents, exactly one of them
 * on the base branch; no protected path touched; every own commit authored
 * and committed as the asker; no secret-shaped string added; a new key beyond
 * the thread's MAX_ASK_PRS. The last three read the PR's own commits plus the
 * diff from each merge's base-branch parent to the merge (its resolution and
 * everything the PR's line had by then) and the diff from the merge base with
 * the base branch to the tip.
 *
 * A PR's description is the one the run wrote for that branch, if any, else
 * one built from the branch's commit messages. A run's description with a
 * secret-shaped string in it is dropped, never published. Every publish
 * rewrites the marked part of the body, so a follow-up turn's description or
 * commits show up on the PR.
 */
import { execFile } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { findSecrets, findSecretsInText } from './secretPatterns';
import { WORKFLOW_SCOPE_HINT, workflowScopeRefusal } from './workflowScope';
import { MAX_ASK_PRS, askBranch, askPrKeyOfRef, capDescription, commitDescription, replaceMarkedBody, splitDescription } from './agentMessages';

/**
 * The cap on each branch's own commits (on an existing PR, the ones the run
 * adds). There is none on the bundle's commits in all: the base branch's,
 * which a merge of it brings in, never refuse it.
 */
export const MAX_COMMITS = 200;
/** The most compare calls one publish makes before it gives up. */
export const MAX_BASE_LOOKUPS = 400;

const PROTECTED: Array<{ re: RegExp; what: string }> = [
  { re: /^\.github\/workflows\//, what: '.github/workflows' },
  { re: /(^|\/)CODEOWNERS$/, what: 'CODEOWNERS' },
  // A bare `sudoers` or a `<name>.sudoers` fragment, such as
  // deploy/claude-runner-orchestrator.sudoers: deploy/ itself may change.
  { re: /(^|\/)([^/]*\.)?sudoers$/, what: 'sudoers' },
  { re: /(^|\/)sudoers\.d\//, what: 'sudoers.d' },
];

/** The protected area a path is in, or null. */
export function protectedArea(path: string): string | null {
  for (const p of PROTECTED) if (p.re.test(path)) return p.what;
  return null;
}

// The secret patterns are shared with the CLI's space-memory scan (secretPatterns.ts).
export { findSecrets, findSecretsInText } from './secretPatterns';

export interface PublishInput {
  bundle: Buffer;
  baseSha: string;
  /** owner/name on github.com. */
  repo: string;
  token: string;
  askerEmail: string;
  /** The GitHub branch a PR key publishes to ('' is the run's own branch). */
  branchFor: (key: string) => string;
  /** The whole PR body around a description (agentMessages prBody); `onTarget` when it is an existing PR the run publishes to. */
  prBody: (description: string, key: string, onTarget: boolean) => string;
  /** What the run wrote for each branch's PR (untrusted), by key. */
  prDescriptions: Record<string, string>;
  /** The PRs the thread already has, by key: a push to one updates it. */
  prNumbers: Record<string, number>;
  /**
   * The existing PR the run's own branch publishes to, in place of the
   * thread's branch: named by `termag ask --update-pr`, or found by an earlier
   * publish and remembered. Checked by resolveTargetPr on every publish.
   * `firstPublish`: the thread has not published to it yet, so a body without
   * termag's markers gets them added rather than left alone.
   */
  target?: { number: number; askerUnix: string; firstPublish: boolean };
  /**
   * With no `target` and no PR of the thread's own yet, the run's own branch
   * publishes to the one open PR of the asker's it builds on, if there is one
   * (findTargetPr). Who the asker is on GitHub's side of that check.
   */
  askerUnix?: string;
}

export interface PublishConfig {
  /** Where `<owner>/<name>.git` is fetched from and pushed to; https://github.com in production. */
  gitBaseUrl: string;
  apiBaseUrl: string;
  fetch: typeof fetch;
}

/** What became of one branch of the bundle. */
export type PrOutcome =
  | {
    kind: 'published'; key: string; branch: string; headSha: string; commits: number; prNumber: number; prUrl: string; prCreated: boolean;
    /** Something about the description a person should know: dropped, or not updated. */
    note?: string;
    /** The existing PR the publish found the branch builds on (findTargetPr), for the thread to remember. */
    target?: { number: number; branch: string };
  }
  | { kind: 'refused' | 'failed'; key: string; branch: string; reason: string };

export type PublishOutcome =
  | { kind: 'done'; prs: PrOutcome[] }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string };

/**
 * A publish as agent_messages.publish / publishDetail: `published` when every
 * branch was, `partial` when some were, else `refused` or `failed` (failed if
 * any branch failed). The detail names the branches only when there are several.
 */
export function publishSummary(o: PublishOutcome): { publish: 'published' | 'partial' | 'refused' | 'failed'; detail: string } {
  if (o.kind !== 'done') return { publish: o.kind, detail: o.reason };
  const many = o.prs.length > 1;
  const line = (p: PrOutcome) => {
    const what = p.kind === 'published'
      ? `${p.commits} commit(s) at ${p.headSha.slice(0, 12)} on ${p.branch}${p.note ? `; ${p.note}` : ''}`
      : p.reason;
    return many ? `${p.key ? `pr/${p.key}` : 'ask'}: ${what}` : what;
  };
  const ok = o.prs.filter(p => p.kind === 'published').length;
  const publish = ok === o.prs.length ? 'published' : ok ? 'partial' : o.prs.some(p => p.kind === 'failed') ? 'failed' : 'refused';
  return { publish, detail: o.prs.map(line).join(' | ') };
}

export function publishConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PublishConfig {
  return {
    gitBaseUrl: (env.ASK_GITHUB_GIT_URL?.trim() || 'https://github.com').replace(/\/+$/, ''),
    apiBaseUrl: (env.ASK_GITHUB_API_URL?.trim() || 'https://api.github.com').replace(/\/+$/, ''),
    fetch,
  };
}

class GitError extends Error {
  constructor(message: string, readonly stderr: string) { super(message); }
}

/** A git failure's last stderr line, for a reason a person can act on. Never carries the header. */
function lastLine(s: string): string {
  return s.split('\n').map(l => l.trim()).filter(Boolean).pop()?.slice(0, 300) ?? '';
}

function git(cwd: string, env: NodeJS.ProcessEnv, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new GitError(`git ${args[0]} failed`, String(stderr)));
      else resolve(String(stdout));
    });
  });
}

/**
 * The environment every git call runs in: no system or global config, no
 * prompts, and the token as an http.extraHeader passed through GIT_CONFIG_*
 * so it is on no command line.
 */
function gitEnv(home: string, token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** Check the bundle and push it. Every outcome is returned, never thrown. */
export async function publishBundle(cfg: PublishConfig, input: PublishInput): Promise<PublishOutcome> {
  const dir = await mkdtemp(join(tmpdir(), 'termag-ask-'));
  try {
    return await publishIn(dir, cfg, input);
  } catch (err) {
    if (err instanceof GitError) return { kind: 'failed', reason: `${err.message}: ${lastLine(err.stderr) || 'no output'}` };
    return { kind: 'failed', reason: (err as Error).message };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function publishIn(dir: string, cfg: PublishConfig, input: PublishInput): Promise<PublishOutcome> {
  const env = gitEnv(dir, input.token);
  const repoDir = join(dir, 'repo.git');
  const bundlePath = join(dir, 'run.bundle');
  const url = `${cfg.gitBaseUrl}/${input.repo}.git`;
  await writeFile(bundlePath, input.bundle, { mode: 0o600 });
  await git(dir, env, ['init', '-q', '--bare', repoDir]);

  const lines = (await git(repoDir, env, ['bundle', 'list-heads', bundlePath]))
    .split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { kind: 'refused', reason: 'the bundle carries no branch' };
  if (lines.length > MAX_ASK_PRS) return { kind: 'refused', reason: `the bundle carries ${lines.length} branches, more than the ${MAX_ASK_PRS} PRs a thread opens` };
  const heads: Array<{ tip: string; ref: string; key: string }> = [];
  for (const line of lines) {
    const [tip, ref] = line.split(/\s+/);
    if (!/^[0-9a-f]{40}$/.test(tip ?? '') || !(ref === 'HEAD' || ref?.startsWith('refs/'))) return { kind: 'refused', reason: 'the bundle head is malformed' };
    const key = askPrKeyOfRef(ref);
    if (key === null) return { kind: 'refused', reason: `the bundle carries ${ref.slice(0, 100)}, which is neither the run's branch nor a pr/<name> one` };
    if (heads.some(h => h.key === key)) return { kind: 'refused', reason: `the bundle carries the ${key ? `pr/${key}` : "run's own"} branch twice` };
    heads.push({ tip, ref, key });
  }
  heads.sort((a, b) => (a.key === '' ? -1 : b.key === '' ? 1 : a.key.localeCompare(b.key)));

  try {
    await git(repoDir, env, ['fetch', '-q', '--depth=1', '--no-tags', url, input.baseSha]);
  } catch (err) {
    const why = err instanceof GitError ? lastLine(err.stderr) : (err as Error).message;
    return { kind: 'failed', reason: `could not fetch the base commit ${input.baseSha.slice(0, 12)} from ${input.repo} on GitHub: ${why}` };
  }
  // A run on another PR carries that PR's commits, which build on an older
  // commit of its base branch than the thread's base: the bundle then needs
  // those commits too. Each is fetched alone, as the base is.
  const missing: string[] = [];
  for (const sha of bundlePrerequisites(input.bundle)) {
    if (sha === input.baseSha) continue;
    try { await git(repoDir, env, ['cat-file', '-e', `${sha}^{commit}`]); } catch { missing.push(sha); }
  }
  if (missing.length > MAX_PREREQUISITES) return { kind: 'refused', reason: `the bundle builds on ${missing.length} commits, more than ${MAX_PREREQUISITES}` };
  if (missing.length) {
    try {
      await git(repoDir, env, ['fetch', '-q', '--depth=1', '--no-tags', url, ...missing]);
    } catch (err) {
      const why = err instanceof GitError ? lastLine(err.stderr) : (err as Error).message;
      return { kind: 'refused', reason: `the bundle builds on commits ${input.repo} does not have on GitHub: ${why}` };
    }
  }
  try {
    await git(repoDir, env, ['bundle', 'verify', '-q', bundlePath]);
  } catch (err) {
    return { kind: 'refused', reason: `the bundle does not apply on the base commit: ${lastLine((err as GitError).stderr ?? '')}` };
  }
  // No cap on the bundle's commits in all: a merge of the base branch carries
  // every base-branch commit since the thread's base, and those must not
  // refuse it. Each branch's own commits are capped (MAX_COMMITS), the
  // bundle's size by MAX_BUNDLE_BYTES, and GitHub lookups by MAX_BASE_LOOKUPS.
  await git(repoDir, env, ['fetch', '-q', '--no-tags', bundlePath, ...heads.map((h, i) => `${h.ref}:refs/termag/tip${i}`)]);
  const bases = baseBranchesOnGithub(cfg, input.repo, input.token);
  // The run's own branch goes to an existing PR: the one --update-pr named (or
  // a turn found before), else the one open PR of the asker's it builds on.
  let target: TargetPr | { refused: string } | { failed: string } | null = null;
  let found = false;
  const own = heads.find(h => h.key === '');
  if (input.target) {
    target = await resolveTargetPr(cfg, { repo: input.repo, token: input.token, number: input.target.number, askerUnix: input.target.askerUnix });
  } else if (own && input.askerUnix && !('' in input.prNumbers)) {
    target = await findTargetPr(cfg, input, repoDir, env, own.tip);
    found = target !== null && 'branch' in target;
  }

  let room = MAX_ASK_PRS - Object.keys(input.prNumbers).length;
  const prs: PrOutcome[] = [];
  for (const h of heads) {
    const onTarget = h.key === '' && target !== null;
    if (onTarget && target && !('branch' in target)) {
      const t = target;
      const label = input.target ? `PR #${input.target.number}` : input.branchFor('');
      prs.push('refused' in t
        ? { kind: 'refused', key: '', branch: label, reason: t.refused }
        : { kind: 'failed', key: '', branch: label, reason: t.failed });
      continue;
    }
    const pr = onTarget ? target as TargetPr : null;
    const branch = pr ? pr.branch : input.branchFor(h.key);
    const isNew = !pr && !(h.key in input.prNumbers);
    if (isNew && room <= 0) {
      prs.push({ kind: 'refused', key: h.key, branch, reason: `the thread already has ${MAX_ASK_PRS} PRs, the most one thread opens` });
      continue;
    }
    let out: PrOutcome;
    try {
      out = await publishHead(cfg, input, repoDir, env, url, h, branch, bases(pr ? pr.number : input.prNumbers[h.key] ?? null, branch), pr, found);
      if (found && pr && out.kind === 'published') out = { ...out, target: { number: pr.number, branch: pr.branch } };
    } catch (err) {
      const reason = err instanceof GitError ? `${err.message}: ${lastLine(err.stderr) || 'no output'}` : (err as Error).message;
      out = { kind: 'failed', key: h.key, branch, reason };
    }
    if (isNew && out.kind === 'published') room--;
    prs.push(out);
  }
  return { kind: 'done', prs };
}

/** One branch of the bundle: its own checks, the push, and its draft PR. */
async function publishHead(
  cfg: PublishConfig, input: PublishInput, repoDir: string, env: NodeJS.ProcessEnv, url: string,
  h: { tip: string; key: string }, branch: string, base: BaseBranch, target: TargetPr | null = null, firstOnTarget = false,
): Promise<PrOutcome> {
  const { tip, key } = h;
  const refuse = (reason: string): PrOutcome => ({ kind: 'refused', key, branch, reason });
  const isAncestor = (a: string, b: string) => git(repoDir, env, ['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);
  if (target) {
    // Fast-forward only: the branch's tip on GitHub must be in the run's
    // history. One that is not moved after the run fetched it (or the run
    // never started from it); the push without force would refuse it too.
    const present = await git(repoDir, env, ['cat-file', '-e', `${target.headSha}^{commit}`]).then(() => true, () => false);
    if (!present || !(await isAncestor(target.headSha, tip))) {
      return refuse(`PR #${target.number}'s branch ${branch} is at ${target.headSha.slice(0, 12)} on GitHub, and the commits do not build on it: it moved on GitHub since the thread fetched it, or the run did not start from it; fetch it again and commit on top`);
    }
  } else if (!(await isAncestor(input.baseSha, tip))) {
    return refuse('the commits do not build on the thread\'s base commit');
  }
  // What the checks below read: the branch's own commits (`range`), plus the
  // diffs (`diffs`, from and to) that show what its merges and its whole line
  // change over the base branch. `git log -p` shows a merge commit's own
  // changes to neither parent, so without them the scan could not see those.
  const baseName = await base.name();
  const { own, onBase } = await splitOwn(repoDir, env, input.baseSha, tip, base.has);
  if (!own.size) return refuse(`the branch holds no commits that are not already on ${baseName}`);
  const ownRange = [tip, `^${input.baseSha}`, ...onBase.map(c => `^${c}`)];
  // The walk and git must agree on what the PR's own commits are.
  const listed = (await git(repoDir, env, ['rev-list', ...ownRange])).split('\n').filter(Boolean);
  if (listed.length !== own.size || listed.some(c => !own.has(c))) return refuse(`could not tell the branch's own commits from ${baseName}'s`);
  // On an existing PR the checks read only what the run adds: the commits
  // beyond the PR's head on GitHub. What is already on the PR stays as it is.
  const range = target ? [...ownRange, `^${target.headSha}`] : ownRange;
  const fresh = target ? new Set((await git(repoDir, env, ['rev-list', ...range])).split('\n').filter(Boolean)) : null;
  const checked = fresh ? [...own].filter(([c]) => fresh.has(c)) : [...own];
  if (checked.length > MAX_COMMITS) return refuse(`${checked.length} commits ${target ? 'added' : 'of its own'} is more than ${MAX_COMMITS}`);
  const diffs: Array<[string, string]> = [];
  const merges: string[] = [];
  for (const [c, ps] of checked) {
    if (ps.length === 0) return refuse(`commit ${c.slice(0, 12)} has no parent; it brings in an unrelated history`);
    if (ps.length === 1) continue;
    const at = c.slice(0, 12);
    if (ps.length > 2) return refuse(`merge ${at} has ${ps.length} parents; only a merge of ${baseName} into the branch is accepted`);
    const sides = await Promise.all(ps.map(p => base.has(p)));
    const n = sides.filter(Boolean).length;
    if (n === 0) return refuse(`merge ${at} merges something other than ${baseName}; only a merge of ${baseName} is accepted, rebase the rest onto the base instead`);
    if (n === 2) return refuse(`merge ${at} merges two commits that are both on ${baseName}; only a merge of ${baseName} into the branch's own commits is accepted`);
    // From the base-branch parent, the merge shows what the PR's line has
    // over the base branch, its resolution included. On an existing PR, that
    // line holds what is already there, so only the resolution is read: what
    // the merge has that neither parent does.
    if (target) merges.push(c);
    else diffs.push([ps[sides.indexOf(true)], c]);
  }
  // And the PR as a whole: from its merge base with the base branch. Another
  // PR's commits stop at base-branch commits fetched one by one, and the base
  // is fetched shallow, so git can't see their order: one it keeps may be an
  // old commit of the base branch, and the diff from it would read all of the
  // base branch's changes since as the PR's. GitHub's compare drops each one
  // older than another. Git drops first the ones it can tell are older (an
  // ancestor it sees is one), so GitHub is asked only about the rest.
  const candidates = [...new Set([...onBase, ...(!target || await isAncestor(input.baseSha, tip) ? [input.baseSha] : [])])];
  const local = candidates.length > 1
    ? (await git(repoDir, env, ['merge-base', '--independent', ...candidates])).split('\n').filter(Boolean)
    : candidates;
  const mergeBases = local.length > 1 ? await base.independent(local) : local;
  const commits = checked.length;

  // Raw names, NUL-separated: a line-based listing C-quotes any path with a
  // non-ASCII or control byte, which would not match the protected prefixes.
  const touchedPaths = (await git(repoDir, env, ['log', '-z', '--name-only', '--no-renames', '--format=', ...range])).split('\0');
  for (const m of merges) touchedPaths.push(...(await git(repoDir, env, ['diff-tree', '-z', '-r', '--cc', '--name-only', '--no-commit-id', m])).split('\0'));
  if (target) {
    // The PR's diff from its base branch, less what it changed before the
    // run: a merge that takes back the base branch's change to a protected
    // path shows only here.
    const before = await prFiles(cfg, input.repo, input.token, target.number);
    for (const m of mergeBases) {
      for (const f of (await git(repoDir, env, ['diff', '-z', '--name-only', '--no-renames', m, tip])).split('\0')) if (!before.has(f)) touchedPaths.push(f);
    }
  } else {
    for (const m of mergeBases) diffs.push([m, tip]);
  }
  for (const [from, to] of diffs) touchedPaths.push(...(await git(repoDir, env, ['diff', '-z', '--name-only', '--no-renames', from, to])).split('\0'));
  const paths = [...new Set(touchedPaths.filter(Boolean))];
  const hits = [...new Set(paths.map(protectedArea).filter((a): a is string => a !== null))];
  if (hits.length) return refuse(`the commits change protected paths (${hits.join(', ')})`);

  const email = input.askerEmail.toLowerCase();
  const idents = (await git(repoDir, env, ['log', '--format=%ae%x09%ce', ...range])).split('\n').filter(Boolean);
  const strangers = idents.flatMap(l => l.split('\t')).filter(e => e.toLowerCase() !== email);
  if (strangers.length) return refuse(`every commit must be authored and committed as ${input.askerEmail}; found ${[...new Set(strangers)].join(', ')}`);

  // Every commit is pushed, not just the tip's tree: scan each commit's own
  // patch (binary blobs as text), the commit object as stored (author and
  // committer names, any extra header, the message) and every path it touches
  // (an empty new file has no `+++` line), so a secret added and later
  // removed, put in a message or a name, or used as a file name is refused too.
  // A merge's patch is in none of these, so its diff from the base branch is.
  let patches = await git(repoDir, env, ['log', '-p', '--text', '-U0', '--no-renames', '--format=', ...range]);
  for (const [from, to] of diffs) patches += await git(repoDir, env, ['diff', '--text', '-U0', '--no-renames', from, to]);
  // A combined diff marks a line the merge itself adds `++`, which the scan reads as added.
  for (const m of merges) patches += await git(repoDir, env, ['diff-tree', '-r', '--cc', '--text', '-U0', '--no-commit-id', m]);
  const objects = await git(repoDir, env, ['log', '--pretty=raw', '--no-mailmap', ...range]);
  const touched = paths.join('\n');
  const secrets = [...new Set([...findSecrets(patches), ...findSecretsInText(objects), ...findSecretsInText(touched)])];
  if (secrets.length) return refuse(`the commits add what looks like a secret (${secrets.join(', ')})`);

  try {
    await git(repoDir, env, ['push', '-q', url, `${tip}:refs/heads/${branch}`]);
  } catch (err) {
    const stderr = (err as GitError).stderr ?? '';
    const why = lastLine(stderr.split('\n').filter(l => !/^\s*hint:/.test(l)).join('\n'));
    if (/non-fast-forward|fetch first|\[rejected\]/i.test(stderr)) {
      return refuse(`${branch} moved on GitHub since the last turn; not overwriting it (${why})`);
    }
    // git's last line is only "failed to push some refs": name GitHub's refusal, and what to do about it.
    const refusal = workflowScopeRefusal(stderr);
    if (refusal) return { kind: 'failed', key, branch, reason: `push to ${input.repo} failed: ${refusal}. ${WORKFLOW_SCOPE_HINT}` };
    return { kind: 'failed', key, branch, reason: `push to ${input.repo} failed: ${why}` };
  }

  const notes: string[] = [];
  const written = input.prDescriptions[key];
  let run = written?.trim() ? splitDescription(written) : null;
  if (run) {
    const found = findSecretsInText(`${run.title ?? ''}\n${run.body}`);
    if (found.length) {
      notes.push(`the run's PR description was dropped: it looks like it holds a secret (${found.join(', ')})`);
      run = null;
    }
  }
  // Commit messages were scanned above, with everything else in the commits.
  const log = await git(repoDir, env, ['log', '--reverse', '--no-merges', '--format=%s%x1f%b%x1e', ...ownRange]);
  const messages = log.split('\x1e').map(r => r.replace(/^\n/, '')).filter(Boolean)
    .map(r => { const [subject, body = ''] = r.split('\x1f'); return { subject, body }; });
  const description = capDescription(run?.body || commitDescription(messages));

  let title = run?.title || '';
  if (!title) {
    const subject = (messages[0]?.subject ?? '').trim().slice(0, 120);
    title = `${subject || 'termag ask'}${messages.length > 1 ? ` (+${messages.length - 1} more)` : ''}`;
  }
  const pr = target
    ? await ensureDraftPr(cfg, { repo: input.repo, token: input.token, branch, prNumber: target.number, create: false, addMarkers: firstOnTarget || !!input.target?.firstPublish }, title, input.prBody(description, key, true))
    : await ensureDraftPr(cfg, { repo: input.repo, token: input.token, branch, prNumber: input.prNumbers[key] ?? null }, title, input.prBody(description, key, false));
  if ('error' in pr) return { kind: 'failed', key, branch, reason: `pushed ${branch}, but ${target ? `PR #${target.number} could not be updated` : 'the draft PR could not be opened'}: ${pr.error}` };
  if (pr.note) notes.push(pr.note);
  return {
    kind: 'published', key, branch, headSha: tip, commits, prNumber: pr.number, prUrl: pr.url, prCreated: pr.created,
    ...(notes.length ? { note: notes.join('; ') } : {}),
  };
}

/** The most commits a bundle on another PR may build on, the base aside. */
export const MAX_PREREQUISITES = 50;

/**
 * The commits a bundle needs and does not carry (its `-<sha>` header lines).
 * A v2 or v3 header is text up to the first empty line; anything else has none.
 */
export function bundlePrerequisites(bundle: Buffer): string[] {
  const end = bundle.indexOf('\n\n');
  const header = bundle.subarray(0, end < 0 ? Math.min(bundle.length, 1 << 20) : end).toString('latin1');
  if (!/^# v[23] git bundle\n/.test(header)) return [];
  const out: string[] = [];
  for (const line of header.split('\n')) {
    const m = /^-([0-9a-f]{40})(?:\s|$)/.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** The PR a thread publishes to (`termag ask --update-pr`), as GitHub has it now. */
export interface TargetPr { number: number; url: string; branch: string; headSha: string; baseBranch: string }

/** A head branch name termag pushes to and puts in a run's prompt: no quoting needed anywhere. */
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/**
 * Whether a PR is one the asker's thread may publish to, from GitHub's view of
 * it (GET /pulls/:n) and the asker's GitHub login (GET /user; null if unknown):
 * open, in `repo`, its head branch in that same repository (not a fork) and
 * not its default branch, and the asker's: a `termag-<asker>/…` branch, or a
 * PR the asker opened. Who wrote the commits already on it doesn't matter:
 * the publish checks the ones the run adds.
 */
export function targetPrRefusal(
  pr: Record<string, unknown> | null, ctx: { repo: string; number: number; askerUnix: string; askerLogin: string | null },
): { refused: string } | { target: TargetPr } {
  const n = `PR #${ctx.number}`;
  if (!pr) return { refused: `${n} is not a pull request in ${ctx.repo}` };
  const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const base = obj(pr.base);
  const head = obj(pr.head);
  const baseRepo = obj(base.repo);
  const headRepo = head.repo ? obj(head.repo) : null;
  const same = (a: string, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
  if (str(pr.state) !== 'open') return { refused: `${n} is ${pr.merged_at ? 'merged' : str(pr.state) || 'not open'}; only an open pull request can be updated` };
  if (!same(str(baseRepo.full_name), ctx.repo)) return { refused: `${n} is in ${str(baseRepo.full_name) || 'another repository'}, not ${ctx.repo}, which the thread's checkout pushes to` };
  if (!headRepo) return { refused: `${n}'s branch is in a repository that no longer exists` };
  if (!same(str(headRepo.full_name), ctx.repo)) return { refused: `${n} comes from a fork (${str(headRepo.full_name)}); termag only pushes to branches in ${ctx.repo}` };
  const branch = str(head.ref);
  const headSha = str(head.sha);
  if (!SAFE_BRANCH.test(branch) || !/^[0-9a-f]{40}$/.test(headSha)) return { refused: `${n}'s head branch could not be read` };
  if (branch === str(baseRepo.default_branch) || branch === str(base.ref)) return { refused: `${n}'s head is ${branch}, a base branch; termag does not push there` };
  const opener = str(obj(pr.user).login);
  const termagBranch = branch.startsWith(askBranch(ctx.askerUnix, ''));
  const opened = !!ctx.askerLogin && same(opener, ctx.askerLogin);
  if (!termagBranch && !opened) {
    return { refused: `${n} is not yours: it was opened by ${opener || 'someone else'} on ${branch}, which is not a ${askBranch(ctx.askerUnix, '')}… branch` };
  }
  return { target: { number: ctx.number, url: str(pr.html_url), branch, headSha, baseBranch: str(base.ref) } };
}

/** The PR a thread may publish to, read from GitHub with the asker's token, or why not. */
export async function resolveTargetPr(
  cfg: PublishConfig, input: { repo: string; token: string; number: number; askerUnix: string },
): Promise<TargetPr | { refused: string } | { failed: string }> {
  const api = githubApi(cfg, input.token);
  try {
    const r = await api('GET', `/repos/${input.repo}/pulls/${input.number}`);
    if (r.status === 404) return { refused: `PR #${input.number} is not a pull request in ${input.repo}` };
    if (r.status !== 200 || !r.data) return { failed: `could not read PR #${input.number} on GitHub (GET answered ${r.status})` };
    const head = String((r.data.head as Record<string, unknown> | undefined)?.ref ?? '');
    let login: string | null = null;
    if (!head.startsWith(askBranch(input.askerUnix, ''))) {
      const me = await api('GET', '/user');
      if (me.status !== 200) return { failed: `could not read the asker's GitHub login (GET /user answered ${me.status})` };
      login = typeof me.data?.login === 'string' ? me.data.login : null;
    }
    const checked = targetPrRefusal(r.data, { repo: input.repo, number: input.number, askerUnix: input.askerUnix, askerLogin: login });
    if ('refused' in checked) return checked;
    return checked.target;
  } catch (err) {
    return { failed: `could not read PR #${input.number} on GitHub: ${(err as Error).message}` };
  }
}

/** The most open PRs findTargetPr reads, and the most files prFiles does (GitHub lists 3000). */
const MAX_OPEN_PRS = 500;
const MAX_PR_FILES = 3000;

/**
 * The open PR the run's own branch builds on (its head on GitHub is in the
 * branch's history and adds commits beyond the thread's base), when it is
 * the asker's (targetPrRefusal): null when it
 * builds on none, refused when on several of the asker's (a stack, which
 * `--update-pr` settles) or on someone else's. The thread's own branches are
 * not counted.
 */
async function findTargetPr(
  cfg: PublishConfig, input: PublishInput, repoDir: string, env: NodeJS.ProcessEnv, tip: string,
): Promise<TargetPr | { refused: string } | { failed: string } | null> {
  const api = githubApi(cfg, input.token);
  const own = input.branchFor('');
  const candidates: Array<Record<string, unknown>> = [];
  // A PR the run builds on adds commits beyond the thread's base. One whose
  // head is already in it (a main → release PR, a branch parked on the base,
  // an older base-branch commit) is under every ask from the base, so it is
  // no PR the run continues. Git sees the base itself; GitHub's compare sees
  // older commits, which this clone holds only shallow.
  const beyondBase = async (sha: string): Promise<boolean> => {
    if (sha === input.baseSha) return false;
    if (await git(repoDir, env, ['merge-base', '--is-ancestor', sha, input.baseSha]).then(() => true, () => false)) return false;
    const r = await api('GET', `/repos/${input.repo}/compare/${input.baseSha}...${sha}?per_page=1`);
    const status = r.status === 200 ? r.data?.status : undefined;
    if (status === 'behind' || status === 'identical') return false;
    if (status === 'ahead' || status === 'diverged') return true;
    throw new Error(`could not tell whether ${sha.slice(0, 12)} is beyond the thread's base (compare answered ${r.status})`);
  };
  try {
    for (let page = 1; page <= MAX_OPEN_PRS / 100; page++) {
      const r = await api('GET', `/repos/${input.repo}/pulls?state=open&per_page=100&page=${page}`);
      if (r.status !== 200 || !Array.isArray(r.data)) return { failed: `could not list ${input.repo}'s open PRs on GitHub (GET answered ${r.status})` };
      const list = r.data as Array<Record<string, unknown>>;
      for (const p of list) {
        const head = (p.head ?? {}) as Record<string, unknown>;
        const sha = typeof head.sha === 'string' ? head.sha : '';
        const ref = typeof head.ref === 'string' ? head.ref : '';
        if (!/^[0-9a-f]{40}$/.test(sha) || ref === own || ref.startsWith(`${own}-`)) continue;
        const on = await git(repoDir, env, ['merge-base', '--is-ancestor', sha, tip]).then(() => true, () => false);
        if (!on || !(await beyondBase(sha))) continue;
        candidates.push(p);
      }
      if (list.length < 100) break;
    }
    if (!candidates.length) return null;
    let login: string | null = null;
    if (candidates.some(p => !String(((p.head ?? {}) as Record<string, unknown>).ref ?? '').startsWith(askBranch(input.askerUnix!, '')))) {
      const me = await api('GET', '/user');
      if (me.status !== 200) return { failed: `could not read the asker's GitHub login (GET /user answered ${me.status})` };
      login = typeof me.data?.login === 'string' ? me.data.login : null;
    }
    const judged = candidates.map(p => ({ p, r: targetPrRefusal(p, { repo: input.repo, number: Number(p.number), askerUnix: input.askerUnix!, askerLogin: login }) }));
    const mine = judged.flatMap(j => ('target' in j.r ? [j.r.target] : []));
    const theirs = judged.filter(j => 'refused' in j.r);
    if (mine.length > 1) {
      const ns = mine.map(t => `#${t.number}`).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).join(', ');
      return { refused: `the commits build on several of your open PRs (${ns}); say which to update with --update-pr <n> on a follow-up, or put a separate change on a pr/<name> branch` };
    }
    // Someone else's PR on top of the asker's, or alone: never updated, and never carried into the asker's.
    const above = [];
    for (const j of theirs) {
      const sha = String(((j.p.head ?? {}) as Record<string, unknown>).sha);
      if (!mine.length || !(await git(repoDir, env, ['merge-base', '--is-ancestor', sha, mine[0].headSha]).then(() => true, () => false))) above.push(j);
    }
    if (above.length) {
      const j = above[0];
      return { refused: `the commits build on PR #${String(j.p.number)}, which termag does not update: ${(j.r as { refused: string }).refused}` };
    }
    return mine[0] ?? null;
  } catch (err) {
    return { failed: `could not look up the PR the commits build on: ${(err as Error).message}` };
  }
}

/** The paths a PR changes on GitHub now (renames' old names too). Throws when GitHub can't say, or lists too many to tell. */
async function prFiles(cfg: PublishConfig, repo: string, token: string, number: number): Promise<Set<string>> {
  const api = githubApi(cfg, token);
  const out = new Set<string>();
  for (let page = 1; ; page++) {
    if (page > MAX_PR_FILES / 100) throw new Error(`PR #${number} changes more than ${MAX_PR_FILES} files, too many to check`);
    const r = await api('GET', `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.data)) throw new Error(`could not list PR #${number}'s files on GitHub (GET answered ${r.status})`);
    for (const f of r.data as Array<Record<string, unknown>>) {
      if (typeof f.filename === 'string') out.add(f.filename);
      if (typeof f.previous_filename === 'string') out.add(f.previous_filename);
    }
    if ((r.data as unknown[]).length < 100) return out;
  }
}

/** A GitHub REST call with the asker's token: its status and JSON body (null when there is none). */
function githubApi(cfg: PublishConfig, token: string) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'termag-ask',
  };
  return async (method: string, path: string, body?: unknown) => {
    const res = await cfg.fetch(`${cfg.apiBaseUrl}${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    return { status: res.status, data };
  };
}

/** A branch's base branch on GitHub, and whether a commit is on it. Both throw when GitHub can't say. */
export interface BaseBranch {
  name: () => Promise<string>;
  has: (sha: string) => Promise<boolean>;
  /** Of commits on the base branch, those no other one descends from, as `git merge-base --independent`. */
  independent: (shas: string[]) => Promise<string[]>;
}

/**
 * The base branches of one publish's branches, as GitHub has them. A branch's
 * base branch is what its PR would merge into: the base of the PR the publish
 * updates (the thread's remembered one while it is open, else the open PR for
 * the branch, as ensureDraftPr finds it), else, for a branch with no PR yet,
 * the repo's default branch, which a new PR opens against. A commit is on it
 * when it is reachable from its tip: compare `<base>...<sha>` says `behind` or
 * `identical`. A commit GitHub doesn't have (404) is not on it; any other
 * answer fails the branch rather than guess. Answers are kept per base branch
 * and commit, and at most MAX_BASE_LOOKUPS are asked in all.
 */
export function baseBranchesOnGithub(cfg: PublishConfig, repo: string, token: string): (prNumber: number | null, branch: string) => BaseBranch {
  const api = githubApi(cfg, token);
  const known = new Map<string, Promise<boolean>>();
  let ordered = 0;
  let defaultBranch: Promise<string> | null = null;
  const getDefault = () => defaultBranch ??= (async () => {
    const r = await api('GET', `/repos/${repo}`);
    const b = r.status === 200 && typeof r.data?.default_branch === 'string' ? r.data.default_branch : null;
    if (!b) throw new Error(`could not read ${repo}'s default branch on GitHub (GET answered ${r.status})`);
    return b;
  })();
  const baseOf = (pr: Record<string, unknown>): string => {
    const ref = (pr.base as Record<string, unknown> | undefined)?.ref;
    if (typeof ref !== 'string' || !ref) throw new Error(`could not read the base branch of PR #${String(pr.number)} on GitHub`);
    return ref;
  };
  return (prNumber, branch) => {
    let name: Promise<string> | null = null;
    const getName = () => name ??= (async () => {
      if (prNumber) {
        const r = await api('GET', `/repos/${repo}/pulls/${prNumber}`);
        if (r.status === 200 && r.data?.state === 'open') return baseOf({ ...r.data, number: prNumber });
      }
      const [owner] = repo.split('/');
      const open = await api('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`);
      if (open.status === 200 && Array.isArray(open.data) && open.data.length) return baseOf(open.data[0] as Record<string, unknown>);
      if (open.status !== 200) throw new Error(`could not look up ${branch}'s PR on GitHub (GET answered ${open.status})`);
      return getDefault();
    })();
    const has = async (sha: string) => {
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit id: ${sha.slice(0, 50)}`);
      const b = await getName();
      const k = `${b}\0${sha}`;
      let p = known.get(k);
      if (p) return p;
      if (known.size + ordered >= MAX_BASE_LOOKUPS) throw new Error(`more than ${MAX_BASE_LOOKUPS} commits to look up on the base branch`);
      p = (async () => {
        const r = await api('GET', `/repos/${repo}/compare/${encodeURIComponent(b).replace(/%2F/g, '/')}...${sha}?per_page=1`);
        if (r.status === 404) return false;
        const status = r.status === 200 ? r.data?.status : undefined;
        if (status === 'behind' || status === 'identical') return true;
        if (status === 'ahead' || status === 'diverged') return false;
        throw new Error(`could not tell whether ${sha.slice(0, 12)} is on ${b} (compare answered ${r.status})`);
      })();
      known.set(k, p);
      return p;
    };
    // `compare a...b` says `ahead` when b descends from a, `behind` when a descends from b.
    const independent = async (shas: string[]) => {
      const left = [...new Set(shas)];
      for (let i = 0; i < left.length; i++) {
        for (let j = i + 1; j < left.length; j++) {
          if (known.size + ordered++ >= MAX_BASE_LOOKUPS) throw new Error(`more than ${MAX_BASE_LOOKUPS} commits to look up on the base branch`);
          const r = await api('GET', `/repos/${repo}/compare/${left[i]}...${left[j]}?per_page=1`);
          const status = r.status === 200 ? r.data?.status : undefined;
          if (status === 'ahead' || status === 'identical') { left.splice(i, 1); i--; break; }
          if (status === 'behind') { left.splice(j, 1); j--; continue; }
          if (status !== 'diverged') throw new Error(`could not order ${left[i].slice(0, 12)} and ${left[j].slice(0, 12)} on GitHub (compare answered ${r.status})`);
        }
      }
      return left;
    };
    return { name: getName, has, independent };
  };
}

/**
 * Split a branch's commits beyond the thread's base into the PR's own and the
 * base branch's. Along a path of single parents the base branch's commits are
 * a tail (an ancestor of a commit on it is on it too), so each such path is
 * halved to where that tail starts rather than asked commit by commit; a
 * merge's parents each start a path of their own. `onBase` are the base
 * branch's commits where the walk stopped: the own commits are exactly
 * `tip ^baseSha ^onBase…`.
 */
async function splitOwn(
  repoDir: string, env: NodeJS.ProcessEnv, baseSha: string, tip: string, has: (sha: string) => Promise<boolean>,
): Promise<{ own: Map<string, string[]>; onBase: string[] }> {
  const parents = new Map<string, string[]>();
  for (const line of (await git(repoDir, env, ['rev-list', '--parents', tip, `^${baseSha}`])).split('\n')) {
    const [c, ...ps] = line.trim().split(/\s+/);
    if (c) parents.set(c, ps);
  }
  const own = new Map<string, string[]>();
  const onBase = new Set<string>();
  const done = (c: string) => !parents.has(c) || own.has(c) || onBase.has(c);
  const todo = [tip];
  while (todo.length) {
    const start = todo.pop()!;
    if (done(start)) continue;
    const path = [start];
    for (;;) {
      const ps = parents.get(path[path.length - 1])!;
      if (ps.length !== 1 || done(ps[0])) break;
      path.push(ps[0]);
    }
    let lo = 0;
    let hi = path.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (await has(path[mid])) hi = mid; else lo = mid + 1;
    }
    for (const c of path.slice(0, lo)) own.set(c, parents.get(c)!);
    if (lo < path.length) onBase.add(path[lo]);
    else todo.push(...parents.get(path[path.length - 1])!);
  }
  return { own, onBase: [...onBase] };
}

type PrFound = { number: number; url: string; created: boolean; note?: string };

/**
 * Open a branch's draft PR, or find it and bring its body up to date; the title
 * is set only on opening. With `create: false` (another PR the thread
 * publishes to) it only updates `prNumber`, and `addMarkers` appends termag's
 * part to a body that has none, on the thread's first publish there.
 */
async function ensureDraftPr(
  cfg: PublishConfig, input: { repo: string; token: string; branch: string; prNumber: number | null; create?: boolean; addMarkers?: boolean }, title: string, body: string,
): Promise<PrFound | { error: string }> {
  const api = githubApi(cfg, input.token);
  // A failed update leaves the PR as it was; the push and the PR still count.
  const existing = async (p: Record<string, unknown>): Promise<PrFound> => {
    const found: PrFound = { number: Number(p.number), url: String(p.html_url ?? ''), created: false };
    const current = typeof p.body === 'string' ? p.body : '';
    let next = replaceMarkedBody(current, body);
    if (next === null && input.addMarkers) next = `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${body}`;
    if (next === null) return { ...found, note: "the PR's body no longer has termag's markers, so its description was left alone" };
    if (next === current) return found;
    const r = await api('PATCH', `/repos/${input.repo}/pulls/${found.number}`, { body: next });
    return r.status === 200 ? found : { ...found, note: `the PR's description could not be updated (PATCH answered ${r.status})` };
  };
  const [owner] = input.repo.split('/');
  try {
    if (input.prNumber) {
      const r = await api('GET', `/repos/${input.repo}/pulls/${input.prNumber}`);
      if (r.status === 200 && r.data?.state === 'open') return await existing({ ...r.data, number: input.prNumber });
      if (input.create === false) return { error: `GET /pulls/${input.prNumber} answered ${r.status}${r.status === 200 ? ` (${String(r.data?.state)})` : ''}` };
    }
    const open = await api('GET', `/repos/${input.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.branch}`)}`);
    if (open.status === 200 && Array.isArray(open.data) && open.data.length) {
      return await existing(open.data[0] as Record<string, unknown>);
    }
    const repo = await api('GET', `/repos/${input.repo}`);
    const base = repo.status === 200 && typeof repo.data?.default_branch === 'string' ? repo.data.default_branch : null;
    if (!base) return { error: `GET /repos/${input.repo} answered ${repo.status}` };
    const created = await api('POST', `/repos/${input.repo}/pulls`, {
      title, head: input.branch, base, body, draft: true,
    });
    if (created.status !== 201 || !created.data) {
      const msg = typeof created.data?.message === 'string' ? created.data.message : '';
      return { error: `POST /pulls answered ${created.status}${msg ? `: ${msg}` : ''}` };
    }
    return { number: Number(created.data.number), url: String(created.data.html_url ?? ''), created: true };
  } catch (err) {
    return { error: (err as Error).message };
  }
}
